/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { contextBlock, withContext, type EditorContext } from './context';
import { readPiChatSettings } from './piConfig';
import { chatAgentDir, readRuntimeMode, sdkEntryCandidates } from './runtime';
import * as path from 'node:path';
import { piToolsFromEditor, type ToolTokenHolder } from './mcp';
import {
	decisionFromAnswer,
	permissionLevelOf,
	PERMISSION_ALLOW,
	PERMISSION_QUESTION_ID,
	shouldAsk,
} from './permissions';
import { mcpTools, toolSetSignature, type EditorToolInfo } from './mcpTools';
import { toolProgress } from './progress';
import { THINKING_HEADER, quotedThinking } from './thinking';
import { loadPiSdk } from './piSdk';
import { modelRefOf } from './providerIds';
import { VENDOR } from './providers';

/**
 * `@pi` inside the editor's own chat.
 *
 * This is what makes the chat exist at all. The editor only shows its chat when it has an
 * agent to talk to — with Copilot gone and nobody registered, it hides the view. Registering
 * here supplies that agent, and it is supplied the way this product wants it: **as the
 * editor's agent**, not as a panel, a tab or a window of our own. Nothing is drawn by this
 * file; the conversation happens in Chat.
 *
 * The owner's requirement behind it is blunt and it is the shape of this module: *"quiero que
 * esté funcional, no quiero tener yo que configurar más cosas más allá del proveedor"*. So
 * nothing here asks the owner anything. It finds pi by itself, opens a session by itself, and
 * the only thing the owner ever fills in is which provider to talk to.
 *
 * ## What the chat and pi share
 *
 * Four things travel between them, and each one is a decision the owner already made in the
 * editor:
 *
 * - **the model**: the one selected in the chat is the one pi runs, and switching it mid
 *   conversation switches pi's session too. A picker that did not reach pi would be a lie;
 * - **the thinking level**: `Settings > Chat > Pi`, left to pi's own default when unset;
 * - **the context**: the folder, the open file and the selection travel with the prompt when
 *   `picode.context.attach` is on, so "arregla esto" means the file he is looking at;
 * - **the thinking**: pi's reasoning is written into the chat only if `picode.pi.reasoning` says
 *   so, because it is long and most of the time he does not want it.
 */

/* ------------------------------------------------------------------ *
 * The pi types this module calls, typed structurally
 * ------------------------------------------------------------------ */

interface PiDelta {
	readonly type: string;
	readonly contentIndex?: number;
	readonly delta?: string;
}

interface PiEvent {
	readonly type: string;
	readonly message?: { readonly role?: unknown; readonly errorMessage?: unknown };
	readonly assistantMessageEvent?: PiDelta;
	readonly toolName?: string;
	readonly args?: unknown;
	readonly isError?: boolean;
}

/** pi's `Model`, opaque here: it is handed back to pi and never inspected. */
interface PiModel {
	readonly [key: string]: unknown;
}

/** The `tool_call` event pi hands an extension, reduced to what a permission asks: which tool, with what. */
interface PiToolCallEvent {
	readonly toolName: string;
	readonly input?: unknown;
}

/** What a `tool_call` handler may return: block with a reason, or nothing to let it run. */
interface PiToolCallResult {
	block?: boolean;
	reason?: string;
}

/** pi's extension API, reduced to the one event this bridge listens on. */
interface PiExtensionApi {
	on(event: 'tool_call', handler: (event: PiToolCallEvent) => Promise<PiToolCallResult | undefined>): () => void;
}

/** pi's inline extension shape (`resourceLoaderOptions.extensionFactories`). */
interface PiInlineExtension {
	name: string;
	factory: (pi: PiExtensionApi) => void | Promise<void>;
	hidden?: boolean;
}

/** pi's session store, created once and handed back to pi across a session's rebuilds. */
interface PiSessionStore {
	readonly [key: string]: unknown;
}

interface PiSession {
	readonly sessionId: string;
	readonly isStreaming: boolean;
	readonly model?: PiModel;
	readonly thinkingLevel?: string;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: (event: PiEvent) => void): () => void;
	setModel(model: PiModel): Promise<void>;
	setThinkingLevel(level: string): void;
	dispose(): void;
}

/** pi's runtime services for one working directory, reduced to what a session needs. */
interface PiServices {
	readonly modelRuntime: { getModel(providerId: string, modelId: string): PiModel | undefined };
}

interface PiSdk {
	createAgentSessionServices(options: {
		cwd: string;
		agentDir?: string;
		/** Inline extensions of this embedded session — here, the permission gate. */
		resourceLoaderOptions?: { extensionFactories?: PiInlineExtension[] };
	}): Promise<PiServices>;
	createAgentSessionFromServices(options: {
		services: PiServices;
		sessionManager: unknown;
		model?: PiModel;
		thinkingLevel?: string;
		/** The MCP tools of the editor, given to pi as tools of its own. See `mcp.ts`. */
		customTools?: unknown[];
	}): Promise<{ session: PiSession }>;
	SessionManager: {
		// `sessionDir` is pi's optional override; without it pi resolves the machine's
		// default, which is right for the external pi and a leak for the internal one.
		create(cwd: string, sessionDir?: string): PiSessionStore;
	};
}

/** pi's entry, loaded and checked for the two methods an agent turn needs. */
async function loadSdk(distributionRoot: string, log: (line: string) => void): Promise<PiSdk | undefined> {
	const loaded = await loadPiSdk<Partial<PiSdk>>(sdkEntryCandidates(distributionRoot));
	if ('problem' in loaded) {
		log(loaded.problem);
		return undefined;
	}
	return typeof loaded.sdk?.createAgentSessionServices === 'function' && typeof loaded.sdk.createAgentSessionFromServices === 'function'
		? (loaded.sdk as PiSdk)
		: undefined;
}

/**
 * The editor as the context block wants it: the folder, the file and the selection.
 *
 * Read here rather than passed around, because this is the only place that knows about the
 * editor's own objects; what is written from them is decided in `context.ts`, where it can be
 * exercised.
 */
function editorContext(folder: string | undefined): EditorContext {
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined || editor.document.uri.scheme !== 'file') {
		return { ...(folder === undefined ? {} : { folder }) };
	}
	const selection = editor.selection.isEmpty
		? undefined
		: {
			text: editor.document.getText(editor.selection),
			lines: editor.selection.end.line - editor.selection.start.line + 1,
		};
	return {
		...(folder === undefined ? {} : { folder }),
		file: editor.document.uri.fsPath,
		...(selection === undefined ? {} : { selection }),
	};
}

/* ------------------------------------------------------------------ *
 * The turn, as the editor's chat wants it
 * ------------------------------------------------------------------ */

/**
 * Answers one request by running one pi turn.
 *
 * `agent_settled` is what ends the turn — not `agent_end`, which also fires when pi is about to
 * retry, and not `prompt()` resolving, which only means the order was accepted.
 */
async function runTurn(session: PiSession, prompt: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, showReasoning: boolean): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let thinking = false;
		// The chat appends what is streamed, token by token, so the quote marker belongs where a
		// line *starts*: prefixing every token renders "The> user> asks". See `thinking.ts`.
		let atLineStart = true;
		const subscription = session.subscribe(event => {
			if (event.type === 'message_update') {
				const delta = event.assistantMessageEvent;
				if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
					if (thinking) {
						// The answer starts: the thinking block is closed so the two are not one wall of
						// text. A blockquote is what the chat renders as thinking, and it needs no API the
						// editor does not have.
						thinking = false;
						stream.markdown('\n\n');
					}
					stream.markdown(delta.delta);
					return;
				}
				if (delta?.type === 'thinking_delta' && typeof delta.delta === 'string' && showReasoning) {
					if (!thinking) {
						thinking = true;
						stream.markdown(THINKING_HEADER);
						atLineStart = true;
					}
					const quoted = quotedThinking(delta.delta, atLineStart);
					atLineStart = quoted.atLineStart;
					stream.markdown(quoted.text);
					return;
				}
				return;
			}
			if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
				// What it is working on, not just which tool: "read src/app.ts" is worth a line,
				// "read" is not.
				stream.progress(toolProgress(event.toolName, event.args));
				return;
			}
			if (event.type === 'message_end') {
				const message = event.message;
				if (message?.role === 'assistant' && typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
					stream.markdown(`\n\n> PiCode: ${message.errorMessage}\n`);
				}
				return;
			}
			if (event.type === 'agent_settled' && !settled) {
				settled = true;
				// What `subscribe` returns is the unsubscribe function itself, not a disposable.
				subscription();
				resolve();
			}
		});

		const cancellation = token.onCancellationRequested(() => {
			// Cancelling at pi is what makes the turn end; a host-side timeout would invent an
			// ending pi never had.
			void session.abort().catch(() => undefined);
		});

		session.prompt(prompt).catch(reject);
		void cancellation;
	});
}

/* ------------------------------------------------------------------ *
 * The permission gate, as the chat's "Default permissions" wants it
 * ------------------------------------------------------------------ */

/**
 * One chat request while its pi turn runs.
 *
 * The question carousel can only be shown on the request's own stream, and the level only
 * changes per request — so this is filled when the turn starts and emptied when it settles,
 * and the `tool_call` handler reads it at call time, exactly like `toolToken`.
 */
interface TurnContext {
	stream: vscode.ChatResponseStream;
	level: ReturnType<typeof permissionLevelOf>;
}

/** The request in flight, which is where a pi tool call gets its stream and its level. */
const turnContext: { current?: TurnContext } = {};

/** The longest stretch of a command or path shown in the permission question. */
const PERMISSION_DETAIL_LIMIT = 160;

/** One line saying what the tool is about to do, for the question's message. */
function describeToolCall(toolName: string, input: unknown): string {
	const record = recordOf(input);
	if (toolName === 'bash' || toolName === 'powershell') {
		const command = typeof record?.['command'] === 'string' ? record['command'] : '';
		return command.length === 0 ? `It runs a ${toolName} command.`
			: `It runs:${command.length > PERMISSION_DETAIL_LIMIT ? `
${command.slice(0, PERMISSION_DETAIL_LIMIT)}…` : `
${command}`}`;
	}
	const target = typeof record?.['path'] === 'string' ? record['path'] : '';
	return target.length === 0 ? `It changes a file with ${toolName}.` : `It wants to ${toolName} ${target}.`;
}

/** The Allow / Deny question, in the two positions the chat's picker model speaks. */
function permissionQuestion(toolName: string, input: unknown): vscode.ChatQuestion {
	return new vscode.ChatQuestion(
		PERMISSION_QUESTION_ID,
		vscode.ChatQuestionType.SingleSelect,
		`pi wants to run ${toolName}`,
		{
			message: describeToolCall(toolName, input),
			options: [
				{ id: 'allow', label: 'Allow', value: PERMISSION_ALLOW },
				{ id: 'deny', label: 'Deny', value: 'deny' },
			],
		},
	);
}

/**
 * The inline extension that gates pi's mutating tools behind the chat's permission level.
 *
 * It is registered once per session rebuild and reads the turn holder at call time, so a
 * session built under one level answers correctly after the picker moved. When it must not
 * ask (approving level, read-only tool) it returns `undefined` — pi's contract for "carry
 * on". The failure posture is fail-OPEN on the bridge's own breakage (no stream, a carousel
 * that throws): a permission layer that wedges every command over its own bugs would be a
 * worse defect than one that misses some gates. What the owner does explicitly — Escape,
 * a skip, a Deny — is honored and blocks, never opened.
 */
function permissionExtension(log: (line: string) => void): PiInlineExtension {
	return {
		name: 'picode-permissions',
		hidden: true,
		factory: pi => {
			void pi.on('tool_call', async event => {
				if (!shouldAsk(turnContext.current?.level, event.toolName)) {
					return undefined;
				}
				const stream = turnContext.current?.stream;
				if (stream === undefined || typeof stream.questionCarousel !== 'function') {
					return undefined;
				}
				try {
					const answer = await stream.questionCarousel([permissionQuestion(event.toolName, event.input)]);
					return decisionFromAnswer(answer, event.toolName);
				} catch (error) {
					log(`permission question failed: ${error instanceof Error ? error.message : String(error)}`);
					return undefined;
				}
			});
		},
	};
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** The participant id the chat calls this agent by. */
export const PI_PARTICIPANT = 'picode.pi';

export interface AgentDeps {
	/** The distribution root, so pi and the profile can be found without configuration. */
	readonly distributionRoot: string;
	readonly log: (line: string) => void;
}

/**
 * Registers `@pi` and returns the participant.
 *
 * A single session is kept for the workspace: pi binds a session to a working directory, and
 * the editor's chat is one conversation in one place. The session is rebuilt if the folder
 * changes, because a session that outlived its directory is a session pi cannot use.
 */
/** The live session's usage totals and current selection, as the status view shows them. */
export interface SessionUsage {
	readonly ctxTokens?: number;
	readonly cost?: number;
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly model?: string;
	readonly thinkingLevel?: string;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** A finite number from an unknown value, or `undefined` when it is not one. */
function numberOf(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The live session's reset hook, set by registerPiAgent for `resetChatSession`. */
let sessionUsageProvider: (() => SessionUsage | undefined) | undefined;
let sessionResetter: (() => void) | undefined;

export function registerPiAgent(context: vscode.ExtensionContext, deps: AgentDeps): vscode.ChatParticipant {
	// The setup bridge needs to drop the live session when Gentle AI is installed or
	// removed: its agents, skills and commands load when pi's session is created.
	sessionResetter = () => { session?.dispose(); session = undefined; services = undefined; };
	sessionUsageProvider = () => {
		if (sessionManager === undefined) {
			return undefined;
		}
		try {
			const entries = (sessionManager as {
				getEntries?: () => ReadonlyArray<Record<string, unknown>>;
			}).getEntries?.() ?? [];
			let input = 0;
			let output = 0;
			let cacheRead = 0;
			let cacheWrite = 0;
			let cost = 0;
			let hasUsage = false;
			let ctxTokens: number | undefined;
			let model: string | undefined;
			let thinkingLevel: string | undefined;
			for (const entry of entries) {
				if (entry['type'] === 'message') {
					// Usage lives nested under `message`, and only assistant messages carry it.
					const message = recordOf(entry['message']);
					if (message?.['role'] !== 'assistant') {
						continue;
					}
					const usage = recordOf(message['usage']);
					if (usage === undefined) {
						continue;
					}
					hasUsage = true;
					const turnInput = numberOf(usage['input']) ?? 0;
					const turnCacheRead = numberOf(usage['cacheRead']) ?? 0;
					const turnCacheWrite = numberOf(usage['cacheWrite']) ?? 0;
					input += turnInput;
					output += numberOf(usage['output']) ?? 0;
					cacheRead += turnCacheRead;
					cacheWrite += turnCacheWrite;
					// Occupancy is what the last prompt actually cost: fresh input plus everything
					// read from or written to the cache. The last answer's output is not in yet.
					ctxTokens = turnInput + turnCacheRead + turnCacheWrite;
					cost += numberOf(recordOf(usage['cost'])?.['total']) ?? 0;
					continue;
				}
				if (entry['type'] === 'model_change') {
					const providerId = entry['provider'];
					const modelId = entry['modelId'];
					if (typeof providerId === 'string' && typeof modelId === 'string') {
						model = `${providerId}/${modelId}`;
					}
					continue;
				}
				if (entry['type'] === 'thinking_level_change') {
					const level = entry['thinkingLevel'];
					if (typeof level === 'string') {
						thinkingLevel = level;
					}
				}
			}
			return {
				...(model === undefined ? {} : { model }),
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				...(hasUsage ? { ctxTokens, input, output, cacheRead, cacheWrite, cost } : {}),
			};
		} catch {
			return undefined;
		}
	};
	let session: PiSession | undefined;
	let sessionFolder: string | undefined;
	/** The profile the live session was built against, so a runtime switch rebuilds it. */
	let sessionAgentDir: string | undefined;
	/** pi's runtime for the current folder: what resolves a model id into the model pi runs. */
	let services: PiServices | undefined;
	/**
	 * The session's store, kept across a rebuild so the conversation survives one.
	 *
	 * A rebuild happens when the editor's MCP servers change, because pi registers custom tools
	 * when a session is created and cannot add one later. Reusing the manager is what makes that
	 * rebuild invisible: the transcript is in the manager, not in the session.
	 */
	let sessionManager: unknown;
	/** The MCP tool set the running session was built with. */
	let mcpSignature = '';

	/** What the editor's MCP servers offer right now, as a signature to compare. */
	const currentMcpSignature = () => toolSetSignature(mcpTools(vscode.lm.tools as readonly EditorToolInfo[]));
	/** Whether the owner wants pi to have the editor's MCP tools at all (`picode.mcp.enabled`). */
	const mcpEnabled = () => readPiChatSettings(key => vscode.workspace.getConfiguration('picode').get(key)).mcpEnabled;
	/** The chat request in flight, which is where an MCP call gets its invocation token. */
	const toolToken: ToolTokenHolder = {};

const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
		toolToken.current = request.toolInvocationToken;
		// The picker's two positions name the four level names the host has shipped; see
		// `permissions.ts`. The setting covers a request that arrives without a level.
		turnContext.current = {
				stream,
				level: permissionLevelOf(request.permissionLevel, vscode.workspace.getConfiguration('chat').get('permissions.default')),
		};
		const sdk = await loadSdk(deps.distributionRoot, deps.log);
		if (sdk === undefined) {
			stream.markdown('PiCode: this editor has no pi to talk to. Reinstall it so the agent can answer.');
			return {};
		}

		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const cwd = folder ?? process.cwd();
		const config = vscode.workspace.getConfiguration('picode');
		const settings = readPiChatSettings(key => config.get(key));

		try {
			const selected = modelRefOf(request.model, VENDOR);
			const signature = mcpEnabled() ? currentMcpSignature() : '';
			// The profile is resolved PER REQUEST, not once at activation: the runtime can be
			// switched while the window is open, and a session built against the previous
			// profile would answer from credentials it does not have ("No API key found").
			const agentDir = chatAgentDir(deps.distributionRoot);
			// Rebuilt when the folder changes — a session belongs to a working directory — when
			// the editor's MCP servers do, and when the chosen pi's profile changes, which is
			// the same conversation pointed at a different pi.
			const folderChanged = sessionFolder !== cwd;
			const toolsChanged = signature !== mcpSignature;
			const profileChanged = sessionAgentDir !== agentDir;
			if (session === undefined || folderChanged || toolsChanged || profileChanged) {
				session?.dispose();
				services = await sdk.createAgentSessionServices({
				cwd,
				...(agentDir === undefined ? {} : { agentDir }),
				resourceLoaderOptions: { extensionFactories: [permissionExtension(deps.log)] },
			});
				if (folderChanged || sessionManager === undefined || profileChanged) {
					sessionManager = sdk.SessionManager.create(cwd, agentDir === undefined ? undefined : path.join(agentDir, 'sessions'));
				}
				const model = selected === undefined ? undefined : services.modelRuntime.getModel(selected.providerId, selected.modelId);
				const created = await sdk.createAgentSessionFromServices({
					services,
					sessionManager,
					// pi's own default when the chat is on a model that is not ours: better pi's choice
					// than a guess at one of ours.
					...(model === undefined ? {} : { model }),
					...(settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel }),
					// The editor's MCP servers, as tools pi can call (see `mcp.ts`). Read every time,
					// because a server added a minute ago has to be there on the next message.
					customTools: mcpEnabled() ? piToolsFromEditor(toolToken) : [],
				});
				session = created.session;
				sessionFolder = cwd;
				sessionAgentDir = agentDir;
				mcpSignature = signature;
			} else {
				// The model picked in the chat between two turns is followed here: a session that
				// answered with the previous model while the picker said otherwise is the defect this
				// closes.
				if (selected !== undefined) {
					const model = services?.modelRuntime.getModel(selected.providerId, selected.modelId);
					if (model !== undefined && session.model !== model) {
						await session.setModel(model);
					}
				}
				if (settings.thinkingLevel !== undefined && session.thinkingLevel !== settings.thinkingLevel) {
					session.setThinkingLevel(settings.thinkingLevel);
				}
			}

			const context = settings.attachContext ? contextBlock(editorContext(folder)) : undefined;
			await runTurn(session, withContext(request.prompt, context, readRuntimeMode()), stream, token, settings.showReasoning);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log(`turn failed: ${message}`);
			stream.markdown(`\n\n> PiCode: ${message}\n`);
		}
		return {};
	};

	const participant = vscode.chat.createChatParticipant(PI_PARTICIPANT, handler);
	// The answer header's avatar is the participant's icon: the host turns `iconPath` into the
	// agent metadata the chat renderer reads (`chatListRenderer.getAgentIcon`), which is why the
	// manifest has no `iconPath` of its own. The brand mark is the line-art `media/picode.svg`.
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'picode.svg');
	context.subscriptions.push(
		participant,
		new vscode.Disposable(() => {
			session?.dispose();
			session = undefined;
		}),
	);
	return participant;
}

/** Disposes the chat's live pi session; the next message rebuilds it from scratch. */
export function resetChatSession(): void {
	sessionResetter?.();
}

/** The live session's usage totals and current selection, as the status view shows them. */
export function getSessionUsage(): SessionUsage | undefined {
	return sessionUsageProvider?.();
}
