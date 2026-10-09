/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { contextBlock, withContext, type EditorContext } from './context';
import { readPiChatSettings } from './piConfig';
import { chatAgentDir, internalProfileDir, readRuntimeMode, resolveProjectScope, sdkEntryCandidates, type PiProjectScope } from './runtime';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { mcpBuiltinWithExistingCwd } from './mcp-cwd';
import { mcpServerNameOfTool } from './mcp-provider';
import { missingDirectories, resolveSessionCwd, type SessionCwd } from './session-cwd';
import { areaContextBlock } from './workspace-area';
import { piToolsFromEditor, type ToolTokenHolder } from './mcp';
import {
	decisionFromAnswer,
	isReadOnlyShellCommand,
	permissionLevelOf,
	PERMISSION_ALLOW,
	PERMISSION_QUESTION_ID,
	shouldAsk,
} from './permissions';
import { mcpTools, toolSetSignature, type EditorToolInfo } from './mcpTools';
import { toolProgress } from './progress';
import { BackgroundJobTracker, backgroundJobRows, backgroundJobStartOf, type BackgroundJobCompletion } from './background-jobs';
import { durableCard, isDurableDelegationTool, type DurableCardData } from './durable-cards';
import {
	beforeUriPathOf,
	clearTurnEdits,
	isFileMutationTool,
	mutatedPathOf,
	PICODE_BEFORE_SCHEME,
	recordAfter,
	snapshotBefore,
	turnFileEdits,
	whenEditsSettled,
} from './chat-edits';
import {
	BACKGROUND_TOOL,
	backgroundCallOf,
	backgroundCompletionOf,
	backgroundResultOf,
	backgroundStartOf,
	completionFailed,
	finishedResultLine,
	isBackgroundTool,
	runningResultLine,
	type BackgroundCall,
} from './background-cards';
import { durableBridgeExtensionPath } from './durable';
import { THINKING_HEADER, quotedThinking } from './thinking';
import { builtinsModuleOf, loadPiSdk, piBuiltinExtensions } from './piSdk';
import { ensureProfilePackages } from './packages-install';
import { locateNpmCli } from './npm-run';
import { piProjectSlug } from './sessions-provider';
import { piCommandsOfRunner, type PiCommand } from './command-registry';
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
 * The shape of every entry of pi's `builtInExtensions` list, too — the chat hands pi's own entries
 * to the session unchanged, beside this editor's own factory.
 */
type PiExtensionFactory = (pi: PiExtensionApi) => void | Promise<void>;

/** pi's inline extension shape (`resourceLoaderOptions.extensionFactories`). */
interface PiInlineExtension {
	name: string;
	factory: PiExtensionFactory;
	hidden?: boolean;
	/** Marks the entry as the code of a `builtin:<name>` path — what makes pi's map take it. */
	builtin?: true;
	/** See pi's `InlineExtension`: another extension registering the same name replaces this one. */
	replaceable?: boolean;
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
	/**
	 * Send a prompt. While {@link isStreaming}, pi **requires** the queueing choice and refuses the
	 * prompt without it — «Agent is already processing. Specify streamingBehavior ('steer' or
	 * 'followUp') to queue the message» — which is what the owner read when he asked «como van»
	 * while a background job's result was being processed.
	 */
	prompt(text: string, options?: { readonly streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: (event: PiEvent) => void): () => void;
	setModel(model: PiModel): Promise<void>;
	setThinkingLevel(level: string): void;
	/**
	 * Starts the session's extensions, and **that** is what emits `session_start`. Absent in a pi
	 * old enough not to have it, so the caller checks — see `bindSessionExtensions`.
	 */
	bindExtensions?(bindings: {
		/**
		 * pi's interactive UI for extensions. The chat's question carousel stands in for the
		 * terminal: `confirm`/`select`/`input` become questions, `notify` a chat line, and the
		 * terminal-only methods are inert. Set, this is what makes `ctx.hasUI` true.
		 */
		uiContext?: unknown;
		/** `"rpc"`: dialogs available, no terminal. Extensions gate TUI components on `"tui"`. */
		mode?: string;
		onError?: (error: { extensionPath?: string; event?: string; error?: string }) => void;
	}): Promise<void>;
	/**
	 * The tools the running session exposes, by name. Present in pi 1.1.0; read defensively
	 * (optional call) because the SDK is loaded at runtime and older pins may lack it. The
	 * `mcp__<server>__<tool>` names are how the session's **connected** MCP servers are
	 * discovered — servers no file declares, brought in by pi extensions and plugins.
	 */
	getAllTools?(): ReadonlyArray<{ readonly name: string }>;
	dispose(): void;
}

/** pi's runtime services for one working directory, reduced to what a session needs. */
interface PiServices {
	readonly modelRuntime: { getModel(providerId: string, modelId: string): PiModel | undefined };
	/** Non-fatal issues pi collected while loading its resources — a bridge that failed to load is said here. */
	readonly diagnostics?: ReadonlyArray<{ readonly type: string; readonly message: string }>;
}

interface PiSdk {
	createAgentSessionServices(options: {
		cwd: string;
		agentDir?: string;
		/** Inline extensions of this embedded session — here, the permission gate and pi's MCP. */
		resourceLoaderOptions?: {
			extensionFactories?: PiInlineExtension[];
			/** pi extension files loaded from disk — here, the durable bridge. */
			additionalExtensionPaths?: string[];
		};
	}): Promise<PiServices>;
	createAgentSessionFromServices(options: {
		services: PiServices;
		sessionManager: unknown;
		model?: PiModel;
		thinkingLevel?: string;
		/** The MCP tools of the editor, given to pi as tools of its own. See `mcp.ts`. */
		customTools?: unknown[];
		/** The agent tools that stay off, by name (pi's own `excludeTools`). See `piConfig.ts`. */
		excludeTools?: string[];
	}): Promise<{ session: PiSession }>;
	SessionManager: {
		// `sessionDir` is pi's optional override; without it pi resolves the machine's
		// default, which is right for the external pi and a leak for the internal one.
		// The internal mode passes pi's own default **shape**: the per-project folder
		// under this profile's `sessions/` (see the sessionManager creation below).
		create(cwd: string, sessionDir?: string): PiSessionStore;
	};
}

/**
 * pi's entry, loaded and checked for the two methods an agent turn needs — **and** the built-in
 * extension entries pi ships beside it.
 *
 * The built-ins are the piece a session cannot work without and also cannot invent: pi builds its
 * built-in map **from the factories the caller passes** (`resource-loader.js` line 246), so a session
 * built with only this editor's factories would have no `builtin:mcp`, no `/mcp`, and no MCP servers
 * connected at all. pi's own CLI avoids that by prepending its built-in list to the caller's
 * factories (`dist/main.js:451`); the list lives in `dist/extensions/index.js` beside the entry and
 * is loaded from the **same install** the SDK was, so the session never mixes one pi's built-ins
 * into another's. What loads then follows pi's own rules: every built-in is enabled by default
 * unless the profile's `extensions` setting excludes it (`package-manager.js` line 738), so the
 * owner's `pi config` choices — including `-builtin:mcp` — stay in charge without this editor
 * taking a position on individual names, which would go stale at the next pi version.
 *
 * A built-in module that is missing or unreadable is logged, not fatal: the session still runs,
 * its MCP is simply absent, and the host guard (`mcp-host-support`) tells the owner why.
 */
interface PiSdkWithBuiltins {
	sdk: PiSdk;
	builtins: readonly PiInlineExtension[];
}

async function loadSdk(distributionRoot: string, log: (line: string) => void): Promise<PiSdkWithBuiltins | undefined> {
	const loaded = await loadPiSdk<Partial<PiSdk>>(sdkEntryCandidates(distributionRoot));
	if ('problem' in loaded) {
		log(loaded.problem);
		return undefined;
	}
	if (typeof loaded.sdk?.createAgentSessionServices !== 'function' || typeof loaded.sdk.createAgentSessionFromServices !== 'function') {
		return undefined;
	}
	// The built-in module beside the entry that was actually loaded, so the factories handed to the
	// session are the ones this pi knows by name (`builtin:mcp` resolves against this same map).
	const builtinsLoad = await loadPiSdk<{ builtInExtensions?: unknown }>([builtinsModuleOf(loaded.entry)]);
	if ('problem' in builtinsLoad) {
		log(`pi built-in extensions: ${builtinsLoad.problem} — the session runs without them (no MCP connector)`);
		return { sdk: loaded.sdk as PiSdk, builtins: [] };
	}
	const read = piBuiltinExtensions(builtinsLoad.sdk);
	for (const skip of read.skipped) {
		log(`pi built-in extensions: skipped ${skip}`);
	}
	// The one built-in this editor re-wraps: pi's `mcp` extension decides each stdio server's
	// working directory and spawns the server there, and when that directory is not on disk Node
	// answers `spawn node ENOENT` — or `spawn C:\WINDOWS\system32\cmd.exe ENOENT` for the `.cmd`
	// shims cross-spawn routes through cmd.exe — naming eight healthy commands for one missing
	// directory (the multi-root workspace keeps a folder in `workspaceFolders` after it is moved,
	// renamed or deleted). The wrapper keeps pi's own extension and only guards the transport's
	// `cwd`: a missing directory never stops a server, and the sentence the owner reads names the
	// directory, not the command. Everything else — config, OAuth, `/mcp` — stays pi's.
	const mcp = await mcpBuiltinWithExistingCwd(loaded.entry, log);
	const builtins = mcp === undefined ? read.builtins : read.builtins.map(entry => (entry.name === 'mcp' ? mcp : entry));
	return { sdk: loaded.sdk as PiSdk, builtins };
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

/**
 * The context block the project scope asks for.
 *
 * One folder is the block `context.ts` already writes, and folder mode is exactly that.
 * In workspace mode the session is a session of the **area**, so the folder line is
 * replaced by the area block (`workspace-area.ts`): every root named the way the owner
 * names it, with the rule for matching a named project to its root, addressing a file
 * under the right root, and the honest limit — one working directory per shell. The
 * file and selection still travel through `context.ts`; only the folder line yields,
 * because the roots list says more and says it about every folder at once. A folder
 * that is not on disk is named as such — the session must know `guildboard` is not
 * there rather than discover it with a failed command.
 */
function contextBlockFor(scope: PiProjectScope, picked: SessionCwd): string | undefined {
	if (scope.mode !== 'workspace' || scope.area === undefined) {
		return contextBlock(editorContext(picked.cwd));
	}
	// Every root's on-disk state is checked on its own (see `missingDirectories`): a folder
	// the editor keeps after a move or delete sits wherever it sits in the order, and the
	// context must say it is gone rather than let a command discover it.
	const missing = missingDirectories(scope.folders);
	const roots = scope.roots.map(root => ({
		name: root.name,
		path: root.path,
		onDisk: !missing.includes(root.path),
	}));
	const base = contextBlock(editorContext(undefined));
	const area = areaContextBlock(roots, picked.cwd);
	if (area === undefined) {
		return base;
	}
	return base === undefined ? area : `${base}\n${area}`;
}

/* ------------------------------------------------------------------ *
 * The durable delegation, as the chat can see it
 * ------------------------------------------------------------------ */

/**
 * Pushes one durable-delegation card into the chat stream.
 *
 * The renderer API is proposed-API surface (`chatParticipantAdditions`); if it ever moves,
 * the turn must not die with it — the card is a window onto the delegated work, and losing
 * the window is reported, not fatal.
 */
function pushDurableCard(stream: vscode.ChatResponseStream, toolCallId: string, data: DurableCardData, log: (line: string) => void): void {
	try {
		const subagent = new vscode.ChatSubagentToolInvocationData(data.description, data.agentName, data.prompt, data.result);
		const part = new vscode.ChatToolInvocationPart(DURABLE_SEND_TOOL_NAME, toolCallId);
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
		log(`durable card failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The delegation tool's name, as the bridge extension registers it (`durable-cards.ts` owns the check). */
const DURABLE_SEND_TOOL_NAME = 'durable_send';

/**
 * The card a background job gets: at its start, and updated once its result names the job it became.
 *
 * The agent's `background` tool returns at once, so both ends happen inside this same call — the card
 * is pushed when the call starts and updated when its result arrives, which is what "running in the
 * background" should look like while it is true.
 */
function pushBackgroundCard(stream: vscode.ChatResponseStream, toolCallId: string, call: BackgroundCall, jobNumber: string | undefined, log: (line: string) => void): void {
	try {
		const subagent = new vscode.ChatSubagentToolInvocationData(
			jobNumber === undefined ? 'Starting in the background' : 'Running in the background',
			call.label ?? 'background job',
			call.command ?? '',
			runningResultLine(jobNumber),
		);
		const part = new vscode.ChatToolInvocationPart(BACKGROUND_TOOL, toolCallId);
		part.toolSpecificData = subagent;
		part.enablePartialUpdate = true;
		part.isComplete = false;
		stream.push(part);
	} catch (error) {
		log(`background card failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * The card a **finished** job gets, in the message that brings its result.
 *
 * A different card from the one above, and it has to be: the result arrives in a later turn, and the
 * editor only updates a part inside the response being streamed. So the pair reads as one job — the
 * first card says it started, this one says how it ended, and both name the same job.
 */
function pushBackgroundCompletionCard(
	stream: vscode.ChatResponseStream,
	completion: ReturnType<typeof backgroundCompletionOf> & object,
	log: (line: string) => void,
): void {
	try {
		const failed = completionFailed(completion);
		const subagent = new vscode.ChatSubagentToolInvocationData(
			failed ? 'A background job failed' : 'A background job finished',
			completion.label ?? 'background job',
			completion.command ?? '',
			[finishedResultLine(completion), completion.tail ?? ''].filter(line => line.length > 0).join('\n\n'),
		);
		const part = new vscode.ChatToolInvocationPart(BACKGROUND_TOOL, `background-job-${completion.id ?? completion.summary}`);
		part.toolSpecificData = subagent;
		part.enablePartialUpdate = true;
		part.isComplete = true;
		part.isError = failed;
		stream.push(part);
	} catch (error) {
		log(`background completion card failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/* ------------------------------------------------------------------ *
 * The turn's changed files, as the chat can see them
 * ------------------------------------------------------------------ */

/**
 * Reads a file as the ledger asks: text, or nothing when it is not there.
 *
 * The `catch` lives in the ledger's own reads; this one only normalizes encoding errors
 * into the same "no file" answer, because a file that cannot be decoded was never a
 * change the chat can show.
 */
async function readLedgerFile(absolutePath: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(absolutePath, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * The workspace path pi reported, made absolute against the turn's working directory —
 * the same resolution pi's own tools apply (`resolveToCwd`), so the ledger's snapshot and
 * its re-read hit the same file, and the diff opens the file the tool actually wrote.
 *
 * The session's directory is the caller's knowledge (`registerPiAgent` builds the session
 * against it), so it travels here as a parameter rather than being read from shared state.
 */
function toLedgerPath(reported: string, sessionCwd: string): string {
	return path.isAbsolute(reported) ? reported : path.join(sessionCwd, reported);
}

/**
 * Snapshots the file a mutating tool is about to write. Called from `tool_execution_start`,
 * where the "before" still exists on disk — by the time the result arrives, it does not.
 */
function snapshotToolTarget(toolName: string, args: unknown, sessionCwd: string): void {
	if (!isFileMutationTool(toolName)) {
		return;
	}
	const reported = mutatedPathOf(args);
	if (reported !== undefined) {
		snapshotBefore(toLedgerPath(reported, sessionCwd), readLedgerFile);
	}
}

/**
 * Records the file a mutating tool has written, when the tool succeeded — a failed tool
 * did not change the file, and the card never says it did.
 */
function recordToolResult(toolName: string, args: unknown, isError: boolean | undefined, sessionCwd: string): void {
	if (!isFileMutationTool(toolName) || isError === true) {
		return;
	}
	const reported = mutatedPathOf(args);
	if (reported !== undefined) {
		recordAfter(toLedgerPath(reported, sessionCwd), readLedgerFile);
	}
}

/** The title the multi-diff editor opens with; the card's own header is the renderer's. */
const TURN_EDITS_TITLE = 'Changed files';

/**
 * Pushes the turn's change card — "Changed N files", one row per file with its +N/−M, and
 * the button that opens every diff at once. One card per turn, at its very end: the row
 * counts need the file's re-read, and a card that appears before the turn ends would have
 * to be updated in place, which this part does not do.
 *
 * The renderer API is proposed-API surface (`chatParticipantAdditions`); if it ever moves,
 * the turn must not die with it — the card is a window onto the work, and losing the
 * window is reported, not fatal (the same posture as the other cards).
 */
async function pushTurnEditsCard(stream: vscode.ChatResponseStream, log: (line: string) => void): Promise<void> {
	try {
		await whenEditsSettled();
		const edits = turnFileEdits();
		if (edits.length === 0 || typeof vscode.ChatResponseMultiDiffPart !== 'function') {
			return;
		}
		const entries = edits.map((edit): vscode.ChatResponseDiffEntry => {
			const file = vscode.Uri.file(edit.path);
			return {
				// The original side is the snapshot this turn took, served by the content
				// provider on the before-scheme; a file the tool created has no before, and
				// its row shows the whole file as added.
				...(edit.isNew ? {} : { originalUri: vscode.Uri.from({ scheme: PICODE_BEFORE_SCHEME, path: beforeUriPathOf(edit.path) }) }),
				modifiedUri: file,
				goToFileUri: file,
				added: edit.added,
				removed: edit.removed,
			};
		});
		stream.push(new vscode.ChatResponseMultiDiffPart(entries, TURN_EDITS_TITLE));
	} catch (error) {
		log(`turn edits card failed: ${error instanceof Error ? error.message : String(error)}`);
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
async function runTurn(session: PiSession, prompt: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, showReasoning: boolean, log: (line: string) => void, sessionCwd: string): Promise<void> {
	// One ledger per turn: the card says what THIS answer changed, and the queue above
	// (`turnChain`) guarantees two turns never overlap.
	clearTurnEdits();
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
				// The same line is the pill's "now": what the agent is doing this instant, above
				// the input where it stays visible while the transcript scrolls on.
				agentActivity = toolProgress(event.toolName, event.args);
				notifyAgentStatus();
				// A durable delegation gets a card the renderer can update in place: which
				// conversation the work became, what was asked, and — when the call ends —
				// what came back. Losing the card is reported, never fatal.
				if (isDurableDelegationTool(event.toolName) && typeof event.toolCallId === 'string') {
					const card = durableCard(event.toolName, event.args, undefined, false);
					if (card !== undefined) {
						pushDurableCard(stream, event.toolCallId, card, log);
					}
				}
				// Work the agent left running: its card says so from the first moment, which is what the
				// owner asked to be able to see («¿hay alguna forma de que yo vea ese background?»).
				if (isBackgroundTool(event.toolName) && typeof event.toolCallId === 'string') {
					pushBackgroundCard(stream, event.toolCallId, backgroundCallOf(event.args), undefined, log);
				}
				// A file this tool is about to write is snapshotted now — this is where the "before"
				// still exists on disk; by the tool's end it does not.
				snapshotToolTarget(event.toolName, event.args, sessionCwd);
				return;
			}
			if (event.type === 'tool_execution_end' && typeof event.toolName === 'string' && typeof event.toolCallId === 'string') {
				// The same card, now with the answer: the toolCallId and enablePartialUpdate are
				// what make the renderer update instead of append.
				const card = durableCard(event.toolName, event.args, event.result, event.isError === true);
				if (card !== undefined) {
					pushDurableCard(stream, event.toolCallId, card, log);
				}
				// A file this tool has written lands in the ledger — when the tool succeeded;
				// a failed tool did not change the file, and the card never says it did.
				recordToolResult(event.toolName, event.args, event.isError, sessionCwd);
				// A background job's call ends at once, when the job **starts**: its result is what names
				// the job, so the same card is updated with it rather than a second one being pushed.
				if (isBackgroundTool(event.toolName)) {
					// The result is what the card can always count on: it names the job, and it repeats the
					// label the call carried — which is what keeps the card honest when the call's own
					// arguments are not readable from here (they do arrive serialised often enough).
					const start = backgroundStartOf(backgroundResultOf(event.result));
					const call = backgroundCallOf(event.args);
					pushBackgroundCard(stream, event.toolCallId, {
						...call,
						...(call.label === undefined && start.label !== undefined ? { label: start.label } : {}),
					}, start.jobNumber, log);
					// The same fact feeds the pill above the chat input: the job is **running now**.
					const tracked = backgroundJobStartOf(backgroundResultOf(event.result));
					if (tracked !== undefined) {
						const label = call.label ?? tracked.label;
						backgroundJobs.start({
							jobNumber: tracked.jobNumber,
							...(label === undefined ? {} : { label }),
							...(call.command === undefined ? {} : { command: call.command }),
						}, Date.now());
						notifyAgentStatus();
					}
				}
				return;
			}
			if (event.type === 'message_end') {
				const message = event.message;
				// A job that has ended arrives as its own message into the conversation: the card says which
				// job it was, how it ended, and the tail of its output (`background-cards.ts` reads it, and
				// only a message of that exact type becomes a card).
				const completion = backgroundCompletionOf(message);
				if (completion !== undefined) {
					pushBackgroundCompletionCard(stream, completion, log);
					// The same ending closes the job in the pill's registry: no completion, no job.
					const closed: BackgroundJobCompletion = {
						...(completion.id === undefined ? {} : { id: completion.id }),
						...(completion.label === undefined ? {} : { label: completion.label }),
						...(completion.command === undefined ? {} : { command: completion.command }),
					};
					backgroundJobs.complete(closed);
					notifyAgentStatus();
				}
				if (message?.role === 'assistant' && typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
					// What happened first, then pi's own sentence — except for the one failure whose advice only works
					// in a terminal, which is answered with the settings where a provider is added.
					stream.markdown(needsProvider(message.errorMessage)
						? '\n\n> PiCode: this model has no provider connected. [Open the provider settings](command:workbench.action.openSettings?%5B%22picode.providers%22%5D) to add one.\n'
						: `\n\n> PiCode: the answer could not be finished — ${message.errorMessage}\n`);
				}
				return;
			}
			if (event.type === 'agent_settled' && !settled) {
				settled = true;
				agentActivity = undefined;
				notifyAgentStatus();
				// What `subscribe` returns is the unsubscribe function itself, not a disposable.
				subscription();
				// The change card comes last, once the ledger's reads have settled: the turn ends
				// with it, so "what changed" is the last thing the transcript says — never a card
				// missing the file whose read was still in flight.
				void pushTurnEditsCard(stream, log).then(resolve, () => resolve());
			}
		});

		const cancellation = token.onCancellationRequested(() => {
			// Cancelling at pi is what makes the turn end; a host-side timeout would invent an
			// ending pi never had.
			void session.abort().catch(() => undefined);
		});

		// pi refuses a prompt while it is streaming unless it is told how to queue it: «Agent is already
		// processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message» — which is
		// the error the owner hit by asking «como van» while a background job's result was being
		// processed. Our own queue (`turnChain`) orders **our** requests, and that is all it can do: it
		// cannot see what pi is doing for itself, and a background job delivers its result into the
		// session as a steer, so pi can be busy when our next prompt arrives.
		//
		// `followUp` is the honest answer — it waits for the run in flight and then runs — and it is
		// pi's own machinery rather than a second guess at it. The turn's ending stays paired: pi settles
		// once, after everything queued has run (`_runAgentPrompt` loops on `hasQueuedMessages` and calls
		// `_emitAgentSettled` in its `finally`), so the single `agent_settled` this awaits is the end of
		// the work that includes this prompt.
		session.prompt(prompt, session.isStreaming ? { streamingBehavior: 'followUp' } : undefined).catch(reject);
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
				if (!shouldAsk(turnContext.current?.level, event.toolName) || isReadOnlyShellCommand(event.toolName, event.input)) {
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
 * pi's interactive UI, as the chat can host it
 * ------------------------------------------------------------------ */

/**
 * The answer key of the bridge's questions. One live question per kind at a time, so one id is
 * enough; the carousel answer record is keyed by it.
 */
const EXTENSION_UI_QUESTION_ID = 'picode-extension-ui';

/** The longest extension-supplied text shown in a question; the rest is trimmed with an ellipsis. */
const EXTENSION_UI_TEXT_LIMIT = 600;

function trimExtensionText(text: string): string {
	return text.length <= EXTENSION_UI_TEXT_LIMIT ? text : `${text.slice(0, EXTENSION_UI_TEXT_LIMIT)}…`;
}

/**
 * One question an extension asked through `ctx.ui`, shown on the current turn's carousel.
 *
 * `undefined` when there is no turn to ask on — an extension that asks outside a turn (a
 * `session_start` handler, say) gets no answer rather than an invented one, and every caller of
 * this bridge reads that as "not approved"/"cancelled", which is the safe direction.
 */
async function askExtensionInChat(
	kind: 'text' | 'select',
	title: string,
	message: string | undefined,
	options: readonly string[] | undefined,
	log: (line: string) => void,
): Promise<unknown> {
	const stream = turnContext.current?.stream;
	if (stream === undefined || typeof stream.questionCarousel !== 'function') {
		log(`extension asked a ${kind} question outside a chat turn: ${title}`);
		return undefined;
	}
	const question = new vscode.ChatQuestion(
		EXTENSION_UI_QUESTION_ID,
		kind === 'text' ? vscode.ChatQuestionType.Text : vscode.ChatQuestionType.SingleSelect,
		trimExtensionText(title),
		{
			...(message !== undefined && message !== '' ? { message: trimExtensionText(message) } : {}),
			...(options !== undefined
				? { options: options.map((option, index) => ({ id: `option-${index}`, label: trimExtensionText(option), value: option })) }
				: {}),
		},
	);
	try {
		const answer = await stream.questionCarousel([question]);
		return answer?.[EXTENSION_UI_QUESTION_ID];
	} catch (error) {
		log(`extension ${kind} question failed: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/**
 * The colour helpers a `Theme` answers with. Here they return the text unchanged: the chat paints
 * its own colours, and a widget this host never renders only needs the call not to throw.
 */
type ChatThemeStyle = (colorOrText?: unknown, text?: unknown) => string;

/** The colour surface an extension may reach through `ctx.ui.theme`. */
type ChatTheme = Record<string, ChatThemeStyle>;

/**
 * pi's `ExtensionUIContext`, reduced to the surface this host answers.
 *
 * Typed rather than `unknown` so the bridge itself is checkable. pi reads the object structurally,
 * so the properties it declares and this one does not are simply absent, and the terminal-only
 * methods are inert no-ops rather than missing — an extension that calls `setStatus` on a host
 * without a status bar must not fail the turn.
 */
interface PiExtensionUiContext {
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: 'info' | 'warning' | 'error'): void;
	onTerminalInput(): () => void;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: unknown): void;
	setHiddenThinkingLabel(label?: string): void;
	setWidget(key: string, content?: unknown, options?: unknown): void;
	setFooter(factory?: unknown): void;
	setHeader(factory?: unknown): void;
	setTitle(title: string): void;
	custom(): Promise<undefined>;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	editor(title: string, prefill?: string): Promise<undefined>;
	addAutocompleteProvider(factory: unknown): void;
	setEditorComponent(factory?: unknown): void;
	getEditorComponent(): undefined;
	readonly theme: ChatTheme;
	getAllThemes(): readonly unknown[];
	getTheme(name: string): undefined;
	setTheme(theme: unknown): { success: boolean; error: string };
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
}

/**
 * A theme good enough for an extension that asks before drawing. A proxy rather than a hand-written
 * object, because pi's `Theme` has more methods than any one extension uses and a missing one must
 * not fail the turn.
 */
const CHAT_THEME: ChatTheme = new Proxy({} as ChatTheme, {
	get: () => (colorOrText?: unknown, text?: unknown) =>
		typeof text === 'string' ? text : typeof colorOrText === 'string' ? colorOrText : '',
});

/**
 * pi's interactive UI, as the chat can host it.
 *
 * pi gives extensions `ctx.ui.confirm/select/input/notify` and a `ctx.hasUI` flag, and this host
 * used to bind extensions with **no** UI context: an extension that needed a question — a
 * destructive-command guard, an ask-user tool, a panel — saw `hasUI === false` and
 * either blocked with a reason the model could only relay, or answered "unavailable". The owner
 * approved the command and it still did not run.
 *
 * Binding this context makes `hasUI` true and turns those calls into the chat's own question
 * carousel, so the owner answers where the work is. The mode is `"rpc"`, not `"tui"`: the chat has
 * dialogs but no terminal, and extensions that draw terminal components gate on `mode === "tui"`.
 * Everything the chat cannot show is a no-op or `undefined`, never a throw — an extension that
 * calls `setStatus` on a host without a status bar must not fail the turn.
 *
 * `custom` (a terminal component) resolves `undefined`, exactly as pi's own RPC mode does; callers
 * already handle that as "she did not pick anything".
 */
function extensionUiContext(log: (line: string) => void): PiExtensionUiContext {
	const noop = (): void => { /* the chat owns this surface */ };
	return {
		confirm: async (title: string, message: string): Promise<boolean> =>
			(await askExtensionInChat('select', title, message, ['Allow', 'Deny'], log)) === 'Allow',
		select: async (title: string, options: string[]): Promise<string | undefined> => {
			const answer = await askExtensionInChat('select', title, undefined, options, log);
			return typeof answer === 'string' ? answer : undefined;
		},
		input: async (title: string, placeholder?: string): Promise<string | undefined> => {
			const answer = await askExtensionInChat('text', title, placeholder, undefined, log);
			return typeof answer === 'string' ? answer : undefined;
		},
		notify: (message: string, type?: 'info' | 'warning' | 'error'): void => {
			const stream = turnContext.current?.stream;
			if (stream === undefined || typeof message !== 'string' || message.trim() === '') {
				return;
			}
			const mark = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
			try {
				stream.markdown(`\n${mark} ${trimExtensionText(message.trim())}\n`);
			} catch { /* a stream that already closed is not an error to report */ }
		},
		// Terminal surfaces the chat does not have; inert on purpose.
		onTerminalInput: () => () => { /* nothing to unsubscribe */ },
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		custom: async (): Promise<undefined> => undefined,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: (): string => '',
		editor: async (): Promise<undefined> => undefined,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: (): undefined => undefined,
		theme: CHAT_THEME,
		getAllThemes: (): readonly unknown[] => [],
		getTheme: (): undefined => undefined,
		setTheme: (): { success: boolean; error: string } => ({ success: false, error: 'Themes are managed by the editor.' }),
		getToolsExpanded: (): boolean => false,
		setToolsExpanded: noop,
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
 * Whether pi's failure is "this model has no provider", told from pi's own words.
 *
 * The match is deliberately narrow. pi says `No API key found for the selected model.` and then points
 * at its terminal's `/login`, which the editor does not have — so that one case gets the door where a
 * provider is actually connected, and everything else keeps pi's sentence, framed for a chat.
 */
function needsProvider(errorMessage: string): boolean {
	return /no api key|invalid api key|missing api key|api key not found/i.test(errorMessage);
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
 * Every extension that has work to do before the first prompt hangs it there; that is the contract,
 * and a session built through the SDK without this call has its extensions loaded and idle (measured:
 * one loaded and registered nothing at all). Which extensions the owner has is his business — this is
 * the door they all wait behind, and it opens before the first turn.
 *
 * The extensions are bound with the chat's UI (see `extensionUiContext`) and `mode: "rpc"`,
 * which is the interactive-host contract an extension reads: with a UI context its
 * `confirm`/`select`/`input`/`notify` reach the chat instead of blocking with "requires
 * interactive confirmation". `onError` is bound so a broken extension is said and the turn
 * still runs.
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
				uiContext: extensionUiContext(log),
				mode: 'rpc',
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
 * the editor's chat is one conversation in one place. The session is rebuilt if the project
 * scope changes — a different folder, or a different project mode — because a session that
 * outlived its directory is a session pi cannot use.
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

/** The context key the chat's footer `when` clauses read to leave pi's responses alone. */
export const CHAT_ACTIVE_CONTEXT = 'picode.chatActive';

/** The live session's reset hook, set by registerPiAgent for `resetChatSession`. */
let sessionUsageProvider: (() => SessionUsage | undefined) | undefined;
let sessionResetter: (() => void) | undefined;
/** The live session's command registry reader, set by registerPiAgent for the slash list. */
let sessionCommandsProvider: (() => { readonly key: string; readonly commands: readonly PiCommand[] } | undefined) | undefined;
/** Fires when the chat's session was created, replaced or dropped. */
const sessionChangedEmitter = new vscode.EventEmitter<void>();

/** The live session's MCP server names, set by registerPiAgent; read by the status answer. */
let sessionMcpProvider: (() => readonly string[] | undefined) | undefined;

/** The background jobs this window's agent left running, as the pill above the chat input reads them. */
const backgroundJobs = new BackgroundJobTracker();

/** The command id the pill above the chat input polls for the jobs still running. */
export const BACKGROUND_JOBS_COMMAND = 'picode.backgroundJobs';

/**
 * The status the pill above the chat input is told about, as one push.
 *
 * The connector pushes; the pill never polls — a poll would wake this extension at window
 * start just to hear "nothing happening". Every field is a fact the transcript already
 * reported: the jobs still running, whether a turn is in flight, what it is doing right
 * now, and how many requests of this window are waiting for their slot.
 */
export interface AgentStatusPush {
	readonly backgroundJobs: ReturnType<typeof backgroundJobRows>;
	readonly running: boolean;
	readonly activity?: string;
	readonly queued: number;
}

/** What the agent is doing this instant, as the tool's progress line says it. */
let agentActivity: string | undefined;
/** Whether a turn is in flight in this window. */
let agentRunning = false;

/**
 * The turns waiting for their slot, each with the way out: dropping one makes its request
 * return without ever running, at once — not when the running turn ends.
 */
interface WaitingTurn {
	drop(): void;
}
const waitingTurns = new Set<WaitingTurn>();

/**
 * The status push: what the pill is told, whenever any of its facts changed. The command
 * the core registers may be missing (an older editor carrying a newer connector), so the
 * push is told once and never again — the pill is a nicety, not something to retry.
 */
const notifyAgentStatus = (): void => {
	const status: AgentStatusPush = {
		backgroundJobs: runningBackgroundJobs(),
		running: agentRunning,
		...(agentActivity === undefined ? {} : { activity: agentActivity }),
		queued: waitingTurns.size,
	};
	void vscode.commands.executeCommand('picode.picodeAgentStatusChanged', status)
		.then(() => undefined, () => undefined);
};

/**
 * The status command's answer, so the pill could also ask once (it never needs to): what
 * this window's agent is doing right now.
 */
export function currentAgentStatus(): AgentStatusPush {
	return {
		backgroundJobs: runningBackgroundJobs(),
		running: agentRunning,
		...(agentActivity === undefined ? {} : { activity: agentActivity }),
		queued: waitingTurns.size,
	};
}

/**
 * Drops every turn waiting for its slot — the pill's "Cancel" for the queue. Returns how
 * many were waiting. Turns already running are not touched: the chat's own stop button is
 * what aborts the turn in flight.
 */
export function cancelQueuedTurns(): number {
	const count = waitingTurns.size;
	for (const waiting of waitingTurns) {
		waiting.drop();
	}
	waitingTurns.clear();
	notifyAgentStatus();
	return count;
}

/**
 * The background jobs still running, with how long each has run — the answer the
 * `picode.backgroundJobs` command gives the pill. An empty list is an honest "nothing
 * running", and is what a window with no live session answers too.
 */
export function runningBackgroundJobs(): ReturnType<typeof backgroundJobRows> {
	return backgroundJobRows(backgroundJobs.list(), Date.now());
}

/**
 * The server names the live session actually connected — every server behind an `mcp__…`
 * tool pi exposed, whatever file (or pi extension or plugin) brought it in. `undefined`
 * when there is no live session to ask: no session, no discovery, no invented rows.
 */
export function liveSessionMcpServers(): readonly string[] | undefined {
	return sessionMcpProvider?.();
}

export function registerPiAgent(context: vscode.ExtensionContext, deps: AgentDeps): vscode.ChatParticipant {
	// The setup bridge needs to drop the live session when the profile's packages change:
	// what they load (agents, skills, commands) registers when pi's session is created.
	sessionResetter = () => { session?.dispose(); session = undefined; services = undefined; backgroundJobs.clear(); notifyAgentStatus(); sessionChangedEmitter.fire(); };
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
	sessionMcpProvider = () => {
		if (session === undefined || typeof session.getAllTools !== 'function') {
			return undefined;
		}
		try {
			const names = new Set<string>();
			for (const tool of session.getAllTools() ?? []) {
				const server = mcpServerNameOfTool(String(tool?.name ?? ''));
				if (server !== undefined) {
					names.add(server);
				}
			}
			return [...names].toSorted((a, b) => a.localeCompare(b));
		} catch {
			// A session that cannot answer its tools is "no discovery", not an error to surface.
			return undefined;
		}
	};
	let session: PiSession | undefined;
	let sessionFolder: string | undefined;
	/** The project scope the live session was built against, so a mode or folder change rebuilds it. */
	let sessionScopeKey: string | undefined;
	/** The profile the live session was built against, so a runtime switch rebuilds it. */
	let sessionAgentDir: string | undefined;
	/** The durable bridge the live session was built with, so a folder change rebuilds it. */
	let sessionBridgePath: string | undefined;
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
	/** The disabled tools the running session was built with, so a change rebuilds it. */
	let disabledToolsKey = '';

	/**
	 * The turns of this window, one at a time, and how many are waiting for their slot.
	 *
	 * There is **one** pi session per window (see `session` above): every chat session the owner has
	 * open drives the same agent. Sending a message in a second one while the first is still
	 * streaming makes pi refuse the prompt — «Agent is already processing. Specify streamingBehavior
	 * ('steer' or 'followUp') to queue the message.» — and that is what the owner saw as soon as he
	 * opened more than one session: the turn never started, and the chat said so.
	 *
	 * Queued **here**, not through pi's `streamingBehavior`: `followUp` would hand the second message
	 * to pi to run after the current turn, and the event that ends a turn (`agent_settled`) would then
	 * fire for the *first* one while the second request was still waiting for its answer — the second
	 * tab would stream nothing and end early, which is worse than the error. Waiting one's turn keeps
	 * the turn and its ending paired, and the second tab's own stream shows its own answer.
	 */
	let turnChain: Promise<void> = Promise.resolve();
	let turnsWaiting = 0;

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
		const loaded = await loadSdk(deps.distributionRoot, deps.log);
		if (loaded === undefined) {
			stream.markdown('PiCode: this editor has no pi to talk to. [Set up PiCode](command:picode.setup) so the agent can answer.');
			return {};
		}

		const scope = resolveProjectScope();
		// The session's directory must exist on disk: pi itself tolerates a missing one, but
		// everything spawned into it does not, and the workspace can hold a folder that is open
		// but not there (moved, renamed, deleted — the editor keeps it in `workspaceFolders`).
		// The first folder that exists is where pi runs; the home directory when none does; and
		// every folder skipped is logged, so the missing directory is named once, honestly.
		const picked = resolveSessionCwd(scope.folders, os.homedir());
		for (const missing of picked.missing) {
			deps.log(`the workspace folder "${missing}" does not exist on disk — pi runs in "${picked.cwd}" instead`);
		}
		const cwd = picked.cwd;
		const config = vscode.workspace.getConfiguration('picode');
		const settings = readPiChatSettings(key => config.get(key));

		try {
			const selected = modelRefOf(request.model, VENDOR);
			const signature = mcpEnabled() ? currentMcpSignature() : '';
			// The profile is resolved PER REQUEST, not once at activation: the runtime can be
			// switched while the window is open, and a session built against the previous
			// profile would answer from credentials it does not have ("No API key found").
			const agentDir = chatAgentDir(deps.distributionRoot);
			// The bridge extension (durable_send/durable_list/durable_read) is loaded from disk
			// when it sits next to the durable folder (`durable.ts` resolves it from the same
			// setting). Resolved per request, so a moved durable folder rebuilds the session.
			const bridgePath = durableBridgeExtensionPath();
			// Rebuilt when the project scope changes — the working directory, the project
			// mode, or the area identity the session files under — when the editor's MCP
			// servers do, when the chosen pi's profile changes, which is the same
			// conversation pointed at a different pi, and when the durable bridge the
			// session should load does.
			const scopeKey = `${scope.mode}\u0000${cwd}\u0000${scope.folders.join('\u0000')}\u0000${scope.area?.slug ?? ''}`;
			const scopeChanged = sessionScopeKey !== scopeKey;
			const toolsChanged = signature !== mcpSignature;
			const profileChanged = sessionAgentDir !== agentDir;
			const bridgeChanged = sessionBridgePath !== bridgePath;
			// The disabled tools reshape the session like the MCP tools do: changing them rebuilds.
			const disabledChanged = disabledToolsKey !== settings.disabledTools.join('\u0000');
			disabledToolsKey = settings.disabledTools.join('\u0000');
			if (session === undefined || scopeChanged || toolsChanged || profileChanged || bridgeChanged || disabledChanged) {
				session?.dispose();
				// The profile is pinned in the environment *before* anything pi loads can resolve it. pi's built-in
				// extensions load beside the permission gate, exactly as pi's own CLI builds a session
				// (`dist/main.js:451`: built-ins first, the caller's after): pi takes its built-in map **from
				// the factories the caller passes** (`resource-loader.js:246`), so the earlier list of only the
				// permission gate left the session with no `builtin:mcp`, no `/mcp` command, and no connector for
				// the profile's MCP servers — the "MCP connector: MISSING" warning came from exactly that. What
				// is enabled stays pi's own default — every built-in unless the profile's `extensions` setting
				// excludes it (`package-manager.js:738`) — so the owner's `pi config` choices, including
				// `-builtin:mcp`, keep deciding, and this editor takes no position that would go stale. This
				// reverses one half of `odd/tasks/picode-pi-0992.md`: pi's MCP extension is wanted again,
				// because the profile's servers (the nan provider's) must connect. The editor's own MCP servers
				// keep flowing as `customTools` below, so the chat's tools are untouched; a server declared both
				// in the profile and bridged from the editor would run twice — the pre-0992 overlap — and is
				// the owner's to reconcile in the profile, not something this editor decides.
				// Before pi loads anything: the profile's declared-but-missing packages are installed here
				// (hidden, one run for the whole list) so pi's loader finds every declaration on disk and
				// never installs one itself — its per-package installs each flashed a console window.
				await ensureProfilePackages({ profileDir: internalProfileDir(deps.distributionRoot), npmCli: locateNpmCli(), log: deps.log });
				pinAgentDir(agentDir);
				services = await loaded.sdk.createAgentSessionServices({
					cwd,
					...(agentDir === undefined ? {} : { agentDir }),
					resourceLoaderOptions: {
						extensionFactories: [...loaded.builtins, permissionExtension(deps.log)],
						...(bridgePath === undefined ? {} : { additionalExtensionPaths: [bridgePath] }),
					},
				});
				// pi collects load problems instead of failing the session; a bridge extension
				// that could not be loaded is said here, and the turn still runs without it.
				for (const diagnostic of services.diagnostics ?? []) {
					if (diagnostic.type === 'error' || diagnostic.type === 'warning') {
						deps.log(`pi resources (${diagnostic.type}): ${diagnostic.message}`);
					}
				}
				if (scopeChanged || sessionManager === undefined || profileChanged) {
					// pi's own session home: the per-project folder under the profile's `sessions/`,
					// the same shape `getDefaultSessionDirPath` builds (replicated by `piProjectSlug`,
					// which the Sessions listing matches against). In workspace mode the session is a
					// session of the **area**, so it files under the area's own slug instead of the
					// first folder's: filed under folder A's slug, every area conversation would read
					// — in the Sessions panel and on disk — as a session of folder A. The area slug
					// (see `workspace-area.ts`) is an identity no single path encodes, so the listing
					// can group it on its own. The override used to be the bare `sessions/` folder,
					// and pi files a custom session directory **directly in it** — no project folder —
					// so every conversation the chat saved landed where the listing never walks: the
					// owner's recent sessions were invisible in Sessions, and clicking a saved one
					// could only ever replay the CLI's older transcripts. Filing under the project
					// slug puts the chat's sessions where pi's own live, and the listing — and the
					// click that replays one — sees them.
					sessionManager = loaded.sdk.SessionManager.create(
						cwd,
						agentDir === undefined ? undefined : path.join(agentDir, 'sessions', scope.area?.slug ?? piProjectSlug(cwd)),
					);
				}
				const model = selected === undefined ? undefined : services.modelRuntime.getModel(selected.providerId, selected.modelId);
				// The tools the owner turned off, read at session build: a change rebuilds the session
				// with everything else that reshapes it. What pi keeps is a **denial, not a wall** —
				// its commands still ask before they run.
				const disabledTools = settings.disabledTools;
				const created = await loaded.sdk.createAgentSessionFromServices({
					services,
					sessionManager,
					// pi's own default when the chat is on a model that is not ours: better pi's choice
					// than a guess at one of ours.
					...(model === undefined ? {} : { model }),
					...(settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel }),
					// The editor's MCP servers, as tools pi can call (see `mcp.ts`). Read every time,
					// because a server added a minute ago has to be there on the next message.
					customTools: mcpEnabled() ? piToolsFromEditor(toolToken) : [],
					...(disabledTools.length === 0 ? {} : { excludeTools: [...disabledTools] }),
				});
				session = created.session;
				// The session exists and its extensions are loaded; this is what starts them. Called
				// before the first turn, because `session_start` is where they do their startup work.
				await bindSessionExtensions(session, deps.log);
				sessionFolder = cwd;
				sessionScopeKey = scopeKey;
				sessionAgentDir = agentDir;
				sessionBridgePath = bridgePath;
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

			const context = settings.attachContext ? contextBlockFor(scope, picked) : undefined;
			// One turn at a time in this window: the next one waits for the turn in flight to end, so
			// a second chat session cannot prompt an agent that is still answering. See `turnChain`.
			const previousTurn = turnChain;
			let releaseTurn!: () => void;
			turnChain = new Promise<void>(resolve => { releaseTurn = resolve; });
			turnsWaiting++;
			// The way out while waiting: dropping the request makes it return at once, without
			// waiting for the running turn to end first — that is what "Cancel queued" means.
			let dropWaiting!: () => void;
			const droppedWhileWaiting = new Promise<void>(resolve => { dropWaiting = resolve; });
			const waitingTurn: WaitingTurn = { drop: dropWaiting };
			waitingTurns.add(waitingTurn);
			agentRunning = true;
			notifyAgentStatus();
			try {
				if (turnsWaiting > 1) {
					stream.progress('PiCode is finishing the turn already running in this window…');
				}
				await Promise.race([previousTurn.catch(() => undefined), droppedWhileWaiting]);
				if (token.isCancellationRequested) {
					// Cancelled while waiting: the turn this request would have run must not start.
					return {};
				}
				await runTurn(session, withContext(request.prompt, context, readRuntimeMode()), stream, token, settings.showReasoning, deps.log, cwd);
			} finally {
				waitingTurns.delete(waitingTurn);
				turnsWaiting--;
				agentRunning = false;
				agentActivity = undefined;
				notifyAgentStatus();
				releaseTurn();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log(`turn failed: ${message}`);
			stream.markdown(`\n\n> PiCode: the turn could not finish — ${message}\n`);
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
