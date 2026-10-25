/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'node:os';
import {
	bindSessionExtensions,
	loadSdk,
	pinAgentDir,
	runTurn,
	type AgentDeps,
	type PiInlineExtension,
	type PiSdk,
	type PiServices,
	type PiSession,
} from './agent';
import { contextBlockFor } from './editor-context';
import { withContext } from './context';
import { readPiChatSettings } from './piConfig';
import { chatAgentDir, internalProfileDir, resolveProjectScope } from './runtime';
import { resolveSessionCwd } from './session-cwd';
import { durableBridgeExtensionPath, durableFolder } from './durable';
import { DaemonClient, daemonEndpoint } from './durable-client';
import { durableSessionTurns } from './durable-sessions';
import { recordTurnInto } from './chat-record';
import { ensureProfilePackages } from './packages-install';
import { locateNpmCli } from './npm-run';
import { piToolsFromEditor, type ToolTokenHolder } from './mcp';
import {
	decisionFromAnswer,
	isReadOnlyShellCommand,
	PERMISSION_ALLOW,
	PERMISSION_QUESTION_ID,
	permissionLevelOf,
	shouldAsk,
} from './permissions';
import { modelRefOf } from './providerIds';
import { VENDOR } from './providers';

/**
 * Continuing a conversation the panel lists.
 *
 * The transcripts pi writes are **durable** — they live in the profile and survive the window —
 * and the owner's rule for the chat is the one his own pi lives by: one orchestrator, sessions
 * always durable. A durable conversation that could only be replayed read-only was the one thing
 * the durable engine had that this list lacked; this module gives pi's transcripts the same
 * property. Opening one builds an in-process pi session **on that transcript**
 * (`SessionManager.open`), so the next prompt appends to the same file and the conversation goes
 * on — same model it was saved with (pi restores it, and says so when it had to fall back), same
 * tools, same permission gate the live chat has.
 *
 * The live chat (`agent.ts`) keeps its single session and its own turn queue; this module runs
 * **beside** it with a session per transcript, one turn chain per session, its own permission
 * context and its own MCP token holder — so a resumed conversation never reaches into the live
 * chat's state, and the other way round.
 */

/** One live pi session bound to a transcript, with everything needed to run its next turn. */
interface ResumedSession {
	readonly session: PiSession;
	readonly sdk: PiSdk;
	readonly services: PiServices;
	readonly sessionManager: ReturnType<PiSdk['SessionManager']['create']>;
	/** The pieces the session was built against: a change rebuilds, exactly as the live chat does. */
	readonly agentDir: string | undefined;
	readonly bridgePath: string | undefined;
	readonly scopeKey: string;
	/** The MCP tool holder this session's tools read; set per turn, never shared with the live chat. */
	readonly toolToken: ToolTokenHolder;
	/** One turn at a time on this transcript, for the same reason the live chat queues. */
	chain: Promise<void>;
}

/** The sessions this window holds open, by transcript path. */
const resumed = new Map<string, ResumedSession>();

/** The turn in flight on a resumed session, which is where its permission gate reads. */
const resumeTurnContext: { current?: { stream: vscode.ChatResponseStream; level: string | undefined } } = {};

/**
 * The permission gate of a resumed session — the same contract as the live chat's
 * (`agent.ts` `permissionExtension`), bound to this module's turn context instead of the live
 * chat's. Fail-open on its own breakage, honoring an explicit Deny, exactly as there.
 */
function resumePermissionExtension(log: (line: string) => void): PiInlineExtension {
	return {
		name: 'picode-permissions',
		hidden: true,
		factory: pi => {
			void pi.on('tool_call', async event => {
				if (!shouldAsk(resumeTurnContext.current?.level, event.toolName) || isReadOnlyShellCommand(event.toolName, event.input)) {
					return undefined;
				}
				const stream = resumeTurnContext.current?.stream;
				if (stream === undefined || typeof stream.questionCarousel !== 'function') {
					return undefined;
				}
				try {
					const answer = await stream.questionCarousel([new vscode.ChatQuestion(
						PERMISSION_QUESTION_ID,
						vscode.ChatQuestionType.SingleSelect,
						`pi wants to run ${event.toolName}`,
						{
							options: [
								{ id: 'allow', label: 'Allow', value: PERMISSION_ALLOW },
								{ id: 'deny', label: 'Deny', value: 'deny' },
							],
						},
					)]);
					return decisionFromAnswer(answer, event.toolName);
				} catch (error) {
					log(`resumed-session permission question failed: ${error instanceof Error ? error.message : String(error)}`);
					return undefined;
				}
			});
		},
	};
}

/** The session of one transcript, built once and rebuilt when what it binds to moved. */
async function resumedSessionOf(file: string, deps: AgentDeps): Promise<ResumedSession> {
	const scope = resolveProjectScope();
	const picked = resolveSessionCwd(scope.folders, os.homedir());
	const agentDir = chatAgentDir(deps.distributionRoot);
	const bridgePath = durableBridgeExtensionPath();
	const scopeKey = `${scope.mode}\u0000${picked.cwd}\u0000${scope.folders.join('\u0000')}\u0000${scope.area?.slug ?? ''}`;
	const existing = resumed.get(file);
	if (existing !== undefined && existing.scopeKey === scopeKey && existing.agentDir === agentDir && existing.bridgePath === bridgePath) {
		return existing;
	}
	existing?.session.dispose();
	resumed.delete(file);

	const loaded = await loadSdk(deps.distributionRoot, deps.log);
	if (loaded === undefined) {
		throw new Error('this editor has no pi to talk to');
	}
	await ensureProfilePackages({ profileDir: internalProfileDir(deps.distributionRoot), npmCli: locateNpmCli(), log: deps.log });
	pinAgentDir(agentDir);
	const toolToken: ToolTokenHolder = {};
	const services = await loaded.sdk.createAgentSessionServices({
		cwd: picked.cwd,
		...(agentDir === undefined ? {} : { agentDir }),
		resourceLoaderOptions: {
			extensionFactories: [...loaded.builtins, resumePermissionExtension(deps.log)],
			...(bridgePath === undefined ? {} : { additionalExtensionPaths: [bridgePath] }),
		},
	});
	// The transcript carries its own model and thinking level in its header; pi restores them
	// (and reports a fallback when the saved model is gone). The editor's MCP servers ride along
	// as custom tools, exactly as the live chat gives them.
	const sessionManager = loaded.sdk.SessionManager.open(file, undefined, picked.cwd);
	const settings = readPiChatSettings(key => vscode.workspace.getConfiguration('picode').get(key));
	const created = await loaded.sdk.createAgentSessionFromServices({
		services,
		sessionManager,
		customTools: settings.mcpEnabled ? piToolsFromEditor(toolToken) : [],
		...(settings.disabledTools.length === 0 ? {} : { excludeTools: [...settings.disabledTools] }),
	});
	await bindSessionExtensions(created.session, deps.log);
	const entry: ResumedSession = {
		session: created.session,
		sdk: loaded.sdk,
		services,
		sessionManager,
		agentDir,
		bridgePath,
		scopeKey,
		toolToken,
		chain: Promise.resolve(),
	};
	resumed.set(file, entry);
	return entry;
}

/**
 * The request handler of one transcript: the prompt appends to the conversation it opens.
 * `vscode.ChatRequestHandler`, shaped for the content provider's session.
 */
export function piResumeRequestHandler(file: string, deps: AgentDeps): vscode.ChatRequestHandler {
	return async (request, _context, response, token) => {
		const prompt = typeof request.prompt === 'string' && request.prompt.trim().length > 0 ? request.prompt : undefined;
		if (prompt === undefined) {
			return {};
		}
		try {
			const resumedSession = await resumedSessionOf(file, deps);
			resumedSession.toolToken.current = request.toolInvocationToken;
			resumeTurnContext.current = {
				stream: response,
				level: permissionLevelOf(request.permissionLevel, vscode.workspace.getConfiguration('chat').get('permissions.default')),
			};
			const scope = resolveProjectScope();
			const picked = resolveSessionCwd(scope.folders, os.homedir());
			const settings = readPiChatSettings(key => vscode.workspace.getConfiguration('picode').get(key));
			const context = settings.attachContext ? contextBlockFor(scope, picked, request.references, settings.contextMode) : undefined;
			const framed = withContext(prompt, context, 'internal');
			// The chat's model picker reaches pi here too, exactly as in the live chat: a session
			// that answered with the previous model while the picker said otherwise is the defect
			// that fix closes.
			const model = modelRefOf(request.model, VENDOR);
			if (model !== undefined) {
				const chosen = resumedSession.services.modelRuntime.getModel(model.providerId, model.modelId);
				if (chosen !== undefined && resumedSession.session.model !== chosen) {
					await resumedSession.session.setModel(chosen);
				}
			}
			// One turn at a time on this transcript, and the turn and its ending stay paired —
			// the same discipline the live chat keeps for its own session.
			const previous = resumedSession.chain;
			let release!: () => void;
			resumedSession.chain = new Promise<void>(resolve => { release = resolve; });
			try {
				await previous.catch(() => undefined);
				if (token.isCancellationRequested) {
					return {};
				}
				await runTurn(resumedSession.session, framed, response, token, settings.showReasoning, deps.log, picked.cwd);
			} finally {
				release();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log(`resumed turn failed: ${message}`);
			response.markdown(`\n\n> PiCode: the conversation could not continue — ${message}\n`);
		}
		return {};
	};
}

/**
 * Continuing a conversation that lives in durable — the panel's one list.
 *
 * The conversation's history is read over the daemon's own protocol (its storage stays its
 * own) and **seeded into an in-process pi session**: the durable turns become the session's
 * first messages, so pi answers with the whole conversation in mind. The turn runs on pi —
 * the brain is never the daemon's — and what the room sees is recorded back into the SAME
 * durable conversation (`recordTurnInto`), so the copy in durable grows with the chat.
 */

/** The seeded sessions of the durable conversations this window continues. */
const durableResumed = new Map<number, ResumedSession>();

/** Read one durable conversation's turns over the daemon's protocol. */
async function durableConversationTurns(conversationId: number, log: (line: string) => void): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
	const folder = durableFolder();
	if (folder === undefined) return [];
	const client = await DaemonClient.connect(daemonEndpoint(folder), 4000);
	try {
		const subscribed = await client.request('subscribe', { conversationId }) as { snapshot?: unknown } | undefined;
		try {
			await client.request('unsubscribe', { conversationId });
		} catch { /* a stale watch is the daemon's to reap */ }
		return durableSessionTurns(subscribed?.snapshot);
	} catch (error) {
		log(`durable continuation: the conversation could not be read — ${error instanceof Error ? error.message : String(error)}`);
		return [];
	} finally {
		client.close();
	}
}

/** The seeded pi session of one durable conversation, built once per window. */
async function durableResumedSessionOf(conversationId: number, cwd: string, deps: AgentDeps): Promise<ResumedSession> {
	const existing = durableResumed.get(conversationId);
	if (existing !== undefined) return existing;
	const loaded = await loadSdk(deps.distributionRoot, deps.log);
	if (loaded === undefined) throw new Error('this editor has no pi to talk to');
	await ensureProfilePackages({ profileDir: internalProfileDir(deps.distributionRoot), npmCli: locateNpmCli(), log: deps.log });
	const agentDir = chatAgentDir(deps.distributionRoot);
	pinAgentDir(agentDir);
	const toolToken: ToolTokenHolder = {};
	const bridgePath = durableBridgeExtensionPath();
	const services = await loaded.sdk.createAgentSessionServices({
		cwd,
		...(agentDir === undefined ? {} : { agentDir }),
		resourceLoaderOptions: {
			extensionFactories: [...loaded.builtins, resumePermissionExtension(deps.log)],
			...(bridgePath === undefined ? {} : { additionalExtensionPaths: [bridgePath] }),
		},
	});
	// The seed: the conversation's own turns as the session's first messages, written with
	// pi's own session manager so the context reads like any other conversation's.
	const sessionManager = loaded.sdk.SessionManager.create(cwd);
	// SAFETY: `SessionManager.create` returns pi's own store, and the only member this uses is
	// `appendMessage`, which the session manager guarantees — a local view of that one member,
	// not a type for the store at large.
	const store = sessionManager as unknown as { appendMessage(message: unknown): string };
	for (const turn of await durableConversationTurns(conversationId, deps.log)) {
		store.appendMessage({ role: turn.role, content: [{ type: 'text', text: turn.text }] });
	}
	const settings = readPiChatSettings(key => vscode.workspace.getConfiguration('picode').get(key));
	const created = await loaded.sdk.createAgentSessionFromServices({
		services,
		sessionManager,
		customTools: settings.mcpEnabled ? piToolsFromEditor(toolToken) : [],
		...(settings.disabledTools.length === 0 ? {} : { excludeTools: [...settings.disabledTools] }),
	});
	await bindSessionExtensions(created.session, deps.log);
	const entry: ResumedSession = {
		session: created.session,
		sdk: loaded.sdk,
		services,
		sessionManager,
		agentDir,
		bridgePath,
		scopeKey: `durable:${conversationId}`,
		toolToken,
		chain: Promise.resolve(),
	};
	durableResumed.set(conversationId, entry);
	return entry;
}

/**
 * The request handler of a durable conversation opened from the panel: pi executes the turn
 * over the conversation's own history, and the room's turn is recorded back into durable.
 */
export function piDurableResumeHandler(conversationId: number, deps: AgentDeps): vscode.ChatRequestHandler {
	return async (request, _context, response, token) => {
		const prompt = typeof request.prompt === 'string' && request.prompt.trim().length > 0 ? request.prompt : undefined;
		if (prompt === undefined) {
			return {};
		}
		try {
			const scope = resolveProjectScope();
			const picked = resolveSessionCwd(scope.folders, os.homedir());
			const resumedSession = await durableResumedSessionOf(conversationId, picked.cwd, deps);
			resumedSession.toolToken.current = request.toolInvocationToken;
			resumeTurnContext.current = {
				stream: response,
				level: permissionLevelOf(request.permissionLevel, vscode.workspace.getConfiguration('chat').get('permissions.default')),
			};
			const settings = readPiChatSettings(key => vscode.workspace.getConfiguration('picode').get(key));
			const context = settings.attachContext ? contextBlockFor(scope, picked, request.references, settings.contextMode) : undefined;
			const framed = withContext(prompt, context, 'internal');
			const model = modelRefOf(request.model, VENDOR);
			if (model !== undefined) {
				const chosen = resumedSession.services.modelRuntime.getModel(model.providerId, model.modelId);
				if (chosen !== undefined && resumedSession.session.model !== chosen) {
					await resumedSession.session.setModel(chosen);
				}
			}
			const previous = resumedSession.chain;
			let release!: () => void;
			resumedSession.chain = new Promise<void>(resolve => { release = resolve; });
			try {
				await previous.catch(() => undefined);
				if (token.isCancellationRequested) {
					return {};
				}
				const answer = await runTurn(resumedSession.session, framed, response, token, settings.showReasoning, deps.log, picked.cwd);
				// The durable copy grows with the chat: the room's turn lands on the SAME
				// conversation, whoever opened it and wherever it was opened.
				void recordTurnInto(conversationId, { prompt: framed, answer }, deps.log);
			} finally {
				release();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log(`durable continuation failed: ${message}`);
			response.markdown(`\n\n> PiCode: the conversation could not continue — ${message}\n`);
		}
		return {};
	};
}

/** The sessions this window holds open, dropped when the extension shuts down. */
export function disposeResumedSessions(): void {
	for (const entry of resumed.values()) {
		entry.session.dispose();
	}
	resumed.clear();
	for (const entry of durableResumed.values()) {
		entry.session.dispose();
	}
	durableResumed.clear();
}
