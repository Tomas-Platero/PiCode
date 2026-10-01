/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { contextBlock, withContext, type EditorContext } from './context';
import { readPiChatSettings } from './piConfig';
import { extractTasks, type TaskRow } from './session-tasks';
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
import { activityLines, gentleAgentsHome, readPresenceActivity } from './subagents';
import { THINKING_HEADER, quotedThinking } from './thinking';
import { loadPiSdk } from './piSdk';
import { piCommandsOfRunner, type PiCommand } from './commands';
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
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
	readonly result?: unknown;
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

/**
 * A factory pi's built-in extensions return: it registers that extension's tools on the session.
 *
 * `createMcpExtension()`, `createCodemodeExtension()` and `createToolSearchExtension()` are all the
 * same shape — call one and it hands back a function pi runs with the session's API.
 */
type PiExtensionFactory = (pi: PiExtensionApi) => void | Promise<void>;

/** pi's inline extension shape (`resourceLoaderOptions.extensionFactories`). */
interface PiInlineExtension {
	name: string;
	factory: PiExtensionFactory;
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
	/**
	 * Starts the session's extensions, and **that** is what emits `session_start`. Absent in a pi
	 * old enough not to have it, so the caller checks — see `bindSessionExtensions`.
	 */
	bindExtensions?(bindings: {
		onError?: (error: { extensionPath?: string; event?: string; error?: string }) => void;
	}): Promise<void>;
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
		/** Inline extensions of this embedded session — here, the permission gate and pi's MCP. */
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
	/**
	 * pi's own MCP, codemode and tool search, as the CLI loads them. A pi old enough not to export
	 * them leaves these undefined and the session simply has no built-in MCP — never a broken one.
	 */
	createMcpExtension?: () => PiExtensionFactory;
	createCodemodeExtension?: () => PiExtensionFactory;
	createToolSearchExtension?: () => PiExtensionFactory;
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
 * Gentle subagents, as the chat can see them
 * ------------------------------------------------------------------ */

/** The prefixes gentle registers one tool per agent under; the prefix moved between releases. */
const AGENT_TOOL_PREFIX = /^(?:agent|subagent)_/;

/** The longest a subagent prompt or result gets in a card: it is a pointer, not a transcript. */
const CARD_PROMPT_CHARS = 200;
const CARD_RESULT_CHARS = 2000;

/** How often the turn's presence poller looks at gentle's activity file. */
const AGENT_POLL_MS = 1_500;

/** How long the poller waits before scanning for an incarnation again after a miss. */
const AGENT_RESCAN_BACKOFF_MS = 10_000;

/** Whether pi is calling a gentle subagent. */
function isAgentToolName(toolName: string): boolean {
	return AGENT_TOOL_PREFIX.test(toolName);
}

/** The tool's agent, spoken: `subagent_gentle_ai_worker` becomes "gentle ai worker". */
function agentDisplayName(toolName: string): string {
	return toolName.replace(AGENT_TOOL_PREFIX, '').replace(/_/g, ' ') || toolName;
}

/** A string capped for a card, with an ellipsis where it was cut. */
function cardText(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The subagent's prompt, as the tool's arguments carry it. */
function agentPromptOf(args: unknown): string | undefined {
	const record = recordOf(args);
	const prompt = typeof record?.['task'] === 'string' ? record['task'] : typeof record?.['prompt'] === 'string' ? record['prompt'] : undefined;
	if (prompt !== undefined) {
		return cardText(prompt, CARD_PROMPT_CHARS);
	}
	try {
		return args === undefined || args === null ? undefined : cardText(JSON.stringify(args), CARD_PROMPT_CHARS);
	} catch {
		return undefined;
	}
}

/** The gentle correlation a finished agent tool reports, read from the result's details. */
function gentleDetailsOf(result: unknown): { taskId?: string; agent?: string; status?: string } | undefined {
	const details = recordOf(recordOf(result)?.['details']);
	const gentle = recordOf(details?.['gentleAgents']);
	if (gentle === undefined) {
		return undefined;
	}
	return {
		taskId: typeof gentle['taskId'] === 'string' ? gentle['taskId'] : undefined,
		agent: typeof gentle['agent'] === 'string' ? gentle['agent'] : undefined,
		status: typeof gentle['status'] === 'string' ? gentle['status'] : undefined,
	};
}

/** The text a finished agent tool returned, as the chat's card wants it. */
function agentResultOf(result: unknown): string | undefined {
	const content = recordOf(result)?.['content'];
	if (!Array.isArray(content)) {
		return undefined;
	}
	const text = content
		.map(part => (recordOf(part)?.['type'] === 'text' && typeof recordOf(part)?.['text'] === 'string' ? recordOf(part)?.['text'] as string : ''))
		.filter(part => part.length > 0)
		.join('\n');
	return text.length === 0 ? undefined : cardText(text, CARD_RESULT_CHARS);
}

/**
 * What a subagent card carries at each stage.
 *
 * At `tool_execution_start` the card names the agent and its prompt; at
 * `tool_execution_end` it gains the result and `isComplete`. The renderer updates the same
 * card in place because every push carries the same `toolCallId` and
 * `enablePartialUpdate`.
 */
interface AgentCardData {
	readonly prompt?: string;
	readonly result?: string;
	readonly complete?: boolean;
	readonly isError?: boolean;
	readonly modelName?: string;
}

/**
 * Pushes one subagent card into the chat stream.
 *
 * The renderer API is proposed-API surface (`chatParticipantAdditions`); if it ever moves,
 * the turn must not die with it — the card is a window onto the subagent, and losing the
 * window is reported, not fatal.
 */
function pushSubagentCard(stream: vscode.ChatResponseStream, toolName: string, toolCallId: string, data: AgentCardData, log: (line: string) => void): void {
	try {
		const subagent = new vscode.ChatSubagentToolInvocationData(undefined, agentDisplayName(toolName), data.prompt, data.result);
		if (data.modelName !== undefined) {
			subagent.modelName = data.modelName;
		}
		const part = new vscode.ChatToolInvocationPart(toolName, toolCallId);
		part.toolSpecificData = subagent;
		part.enablePartialUpdate = true;
		if (data.complete !== undefined) {
			part.isComplete = data.complete;
		}
		if (data.isError !== undefined) {
			part.isError = data.isError;
		}
		stream.push(part);
	} catch (error) {
		log(`subagent card failed: ${error instanceof Error ? error.message : String(error)}`);
	}
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
async function runTurn(session: PiSession, prompt: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, showReasoning: boolean, log: (line: string) => void): Promise<void> {
	/** One gentle agent tool of this turn, by its toolCallId. */
	const agentCalls = new Map<string, { toolName: string; ended: boolean }>();
	/** Stops the presence poller; set the first time an agent tool starts. */
	let stopAgentPolling: (() => void) | undefined;

		/**
		 * One live progress line for the turn's subagents, polling gentle's presence file.
		 *
		 * Started only when an agent tool actually starts — a normal turn pays nothing. One
		 * tick is one file read of one known incarnation; the incarnation is re-scanned only
		 * after a miss, and a miss backs off, so an editor without gentle pays one failed
		 * scan every ten seconds and nothing else. Every reported line is a warning part
		 * under the spinner — the one part the progress task can carry — reported only when
		 * the picture changed, and the line settles as soon as every launched tool returned
		 * (task-mode agent tools block until their subagent is done) or the turn itself ends.
		 */
		const startAgentPolling = (): void => {
			if (stopAgentPolling !== undefined) {
				return;
			}
			const sessionId = session.sessionId;
			const home = gentleAgentsHome();
			let incarnation: string | undefined;
			let rescanAfter = 0;
			let settled = false;
			let lastReported: string | undefined;
			let reporter: vscode.Progress<vscode.ChatResponseWarningPart | vscode.ChatResponseReferencePart> | undefined;
			const finish = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearInterval(timer);
				const launched = agentCalls.size;
				const done = [...agentCalls.values()].filter(call => call.ended).length;
				resolvePolling(launched === 0 ? 'Subagents' : `Subagents: ${done}/${launched} finished`);
			};
			let resolvePolling!: (value: string) => void;
			const polling = new Promise<string>(resolve => { resolvePolling = resolve; });
			const timer = setInterval(() => {
				if (settled) {
					return;
				}
				// In task mode an agent tool returns only when its subagent is done, so every
				// tool having returned IS the work having finished.
				if (agentCalls.size > 0 && [...agentCalls.values()].every(call => call.ended)) {
					finish();
					return;
				}
				try {
					if (incarnation === undefined && Date.now() < rescanAfter) {
						return;
					}
					const read = readPresenceActivity(sessionId, home, undefined, incarnation);
					if (read === undefined) {
						// A vanished incarnation or no gentle here at all: back off before the
						// next scan, so absence costs one failed scan per back-off, not per tick.
						incarnation = undefined;
						rescanAfter = Date.now() + AGENT_RESCAN_BACKOFF_MS;
						return;
					}
					incarnation = read.incarnation;
					const lines = activityLines(read.activity);
					const text = lines.join('  \n');
					if (lines.length > 0 && reporter !== undefined && text !== lastReported) {
						lastReported = text;
						reporter.report(new vscode.ChatResponseWarningPart(text));
					}
				} catch {
					// Presence is a window, not a dependency: a failing tick says nothing.
				}
			}, AGENT_POLL_MS);
			stopAgentPolling = finish;
			stream.progress('Running subagents', progress => {
				reporter = progress;
				return polling;
			});
		};

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
				// A gentle subagent gets a card the renderer can update in place, and the
				// turn's one presence poller, which reports what the subagents are doing live.
				if (isAgentToolName(event.toolName) && typeof event.toolCallId === 'string') {
					agentCalls.set(event.toolCallId, { toolName: event.toolName, ended: false });
					pushSubagentCard(stream, event.toolName, event.toolCallId, { prompt: agentPromptOf(event.args) }, log);
					startAgentPolling();
				}
				return;
			}
			if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
				const call = agentCalls.get(event.toolCallId);
				if (call !== undefined) {
					call.ended = true;
					// The same card, now with the result: the toolCallId and enablePartialUpdate
					// are what make the renderer update instead of append.
					const gentle = gentleDetailsOf(event.result);
					pushSubagentCard(stream, call.toolName, event.toolCallId, {
						prompt: agentPromptOf(event.args),
						result: agentResultOf(event.result),
						complete: true,
						isError: event.isError === true,
						modelName: gentle?.agent ?? gentle?.status,
					}, log);
				}
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
	})
		// Whether the turn answered, threw or was cancelled, the poller has nothing more to
		// watch: its interval must not outlive the turn.
		.finally(() => stopAgentPolling?.());
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
 * The profile, pi's own extensions, and the event that starts them
 * ------------------------------------------------------------------ */

/**
 * The profile the session runs against, pinned where pi's own code looks for it.
 *
 * `agentDir` is a parameter of the SDK; pi's `getAgentDir()` reads `PI_CODING_AGENT_DIR`
 * (`dist/config.js`). An extension that resolves the profile by itself therefore ignored the
 * parameter: pi's MCP looked for `~/.pi/agent/mcp.json`, and the adapter loaded the servers of the
 * machine's own profile — measured, not assumed (see `odd/tasks/picode-pi-0992.md`). Pinning the
 * variable is what puts every extension inside PiCode's profile; the chat holds one session at a
 * time, and a profile change is exactly what rebuilds it.
 *
 * External mode passes `undefined`, and then the variable is **removed**: the machine's own profile
 * is the point there, and a value left over from an internal session would silently override it.
 */
function pinAgentDir(agentDir: string | undefined): void {
	if (agentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
		return;
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

/**
 * pi's own MCP, codemode and tool search, as the session's inline extensions.
 *
 * pi's CLI spreads `builtInExtensions` into every session it builds, and the SDK does not: a session
 * built from `createAgentSessionServices` alone has none of them. Two consequences were measured:
 * the servers in the profile's `mcp.json` had no reader in the chat, and the tools pi's MCP reaches
 * through codemode or tool search had nothing to be reached with. Loading the three here is what
 * makes the chat work like the terminal, with the exposure each server declares in the file — pi's
 * default is `codemode`, and it is pi who activates codemode or tool search when a server needs it.
 *
 * Not `llama.cpp`: that is the local-classifier extension, it has nothing to do with this, and
 * loading it would add a surface nobody asked for.
 *
 * Each factory is checked before it is called, so a pi that does not export them yields no
 * extension instead of a session that fails to start.
 */
function piBuiltinExtensions(sdk: PiSdk): PiInlineExtension[] {
	const built: PiInlineExtension[] = [];
	const add = (name: string, factory: (() => PiExtensionFactory) | undefined): void => {
		if (typeof factory === 'function') {
			built.push({ name, factory: factory(), hidden: true });
		}
	};
	// Named `mcp` on purpose: pi's own adapter detects the built-in MCP by that name
	// (`<inline:mcp>`), and a name it does not recognise is how it ends up taking `/mcp` over.
	add('mcp', sdk.createMcpExtension);
	add('codemode', sdk.createCodemodeExtension);
	add('tool-search', sdk.createToolSearchExtension);
	return built;
}

/**
 * How long the session's extensions have to start before the turn goes ahead without them.
 *
 * pi's own MCP bounds its server wait the same way; here it covers every extension the owner has
 * installed, none of which was written for a host with no terminal.
 */
const EXTENSION_START_TIMEOUT_MS = 15_000;

/**
 * Starts the session's extensions — the one thing that emits `session_start`.
 *
 * Every extension that has work to do before the first prompt hangs it there, pi's own MCP among
 * them: that event is where its servers connect (`dist/extensions/mcp/index.js`). A session built
 * through the SDK without this call has its extensions loaded and idle — measured: pi's MCP
 * extension loaded and registered no tools at all.
 *
 * Only the error listener is bound. This host has no terminal UI, and an extension that wants one
 * asks `ctx.hasUI` first — which is why the bound context has to be "no UI" rather than invented.
 * A session whose extensions fail to start still answers: the failure is said and the turn runs.
 */
async function bindSessionExtensions(session: PiSession, log: (line: string) => void): Promise<void> {
	if (typeof session.bindExtensions !== 'function') {
		return;
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		// Bounded, like pi does with its own MCP wait: an extension that sits waiting for something
		// this host never gives it — a terminal prompt, say — must not hold the first turn open. The
		// work that arrives late is still applied; the registry refreshes when tools appear.
		await Promise.race([
			session.bindExtensions({
				onError: error => log(`extension error (${error.extensionPath ?? 'unknown'}) on ${error.event ?? 'unknown'}: ${error.error ?? 'no message'}`),
			}),
			new Promise<void>(resolve => {
				timer = setTimeout(resolve, EXTENSION_START_TIMEOUT_MS);
			}),
		]);
	} catch (error) {
		log(`the session's extensions could not be started: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
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
	/** The session's task list (gentle-pi's todo tool), last snapshot; absent when none exists. */
	readonly tasks?: readonly TaskRow[];
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** A finite number from an unknown value, or `undefined` when it is not one. */
function numberOf(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The context key the chat's footer `when` clauses read to leave pi's responses alone. */
export const CHAT_ACTIVE_CONTEXT = 'picode.chatActive';

/** The live session's reset hook, set by registerPiAgent for `resetChatSession`. */
let sessionUsageProvider: (() => SessionUsage | undefined) | undefined;
let sessionResetter: (() => void) | undefined;
/** The live session's command registry reader, set by registerPiAgent for the slash list. */
let sessionCommandsProvider: (() => { readonly key: string; readonly commands: readonly PiCommand[] } | undefined) | undefined;
/** Fires when the chat's session was created, replaced or dropped. */
const sessionChangedEmitter = new vscode.EventEmitter<void>();

export function registerPiAgent(context: vscode.ExtensionContext, deps: AgentDeps): vscode.ChatParticipant {
	// The setup bridge needs to drop the live session when Gentle AI is installed or
	// removed: its agents, skills and commands load when pi's session is created.
	sessionResetter = () => { session?.dispose(); session = undefined; services = undefined; sessionChangedEmitter.fire(); };
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
			let tasks: readonly TaskRow[] | undefined;
			for (const entry of entries) {
				if (entry['type'] === 'message') {
					// The task list rides on the same entries: gentle-pi's todo tool stamps the full
					// snapshot on every result, so the last one in order is the current list.
					tasks = extractTasks([entry]) ?? tasks;
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
				...(tasks === undefined ? {} : { tasks }),
			};
		} catch {
			return undefined;
		}
	};
	// pi is the panel's own participant, and its session has no vote channel: the chat's
	// footer reads this flag to keep the vote actions off pi's responses (see
	// `chatTitleActions.ts`). Set once for the window — the panel's chat is pi's.
	void vscode.commands.executeCommand('setContext', CHAT_ACTIVE_CONTEXT, true);
	sessionCommandsProvider = () => {
		if (session === undefined || sessionFolder === undefined) {
			return undefined;
		}
		// The key is the session's identity: a rebuilt session reads again instead of
		// serving another session's registry.
		return { key: `${sessionFolder}\u0000${session.sessionId}`, commands: piCommandsOfRunner(session) };
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
				// The profile is pinned in the environment *before* anything pi loads can resolve it, and
				// the session is given pi's own MCP beside the permission gate. What each one fixes, and
				// the probes that showed it was broken, are in `odd/tasks/picode-pi-0992.md`.
				pinAgentDir(agentDir);
				services = await sdk.createAgentSessionServices({
					cwd,
					...(agentDir === undefined ? {} : { agentDir }),
					resourceLoaderOptions: { extensionFactories: [permissionExtension(deps.log), ...piBuiltinExtensions(sdk)] },
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
				// The session exists and its extensions are loaded; this is what starts them. Called
				// before the first turn, because `session_start` is where they do their startup work.
				await bindSessionExtensions(session, deps.log);
				sessionFolder = cwd;
				sessionAgentDir = agentDir;
				mcpSignature = signature;
				sessionChangedEmitter.fire();
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
			await runTurn(session, withContext(request.prompt, context, readRuntimeMode()), stream, token, settings.showReasoning, deps.log);
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

/**
 * The live session's pi extension commands and its identity, or `undefined` while no
 * session runs — what the slash-command list reads (see `commands.ts`).
 */
export function liveSessionCommands(): { readonly key: string; readonly commands: readonly PiCommand[] } | undefined {
	return sessionCommandsProvider?.();
}

/** Fires when the chat's session was created, replaced or dropped. */
export const onPiSessionChanged = sessionChangedEmitter.event;

/** The live session's usage totals and current selection, as the status view shows them. */
export function getSessionUsage(): SessionUsage | undefined {
	return sessionUsageProvider?.();
}
