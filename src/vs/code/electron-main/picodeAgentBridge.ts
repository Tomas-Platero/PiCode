/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, createHash } from 'crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { IWindowsMainService, OpenContext } from '../../platform/windows/electron-main/windows.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { isSingleFolderWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { LocalPipeServer } from './picodeAgentBridgePipe.js';
import { BridgeReply, errorReply, folderKeyOf, parseRequest, serializeReply, SessionStartParams } from './picodeAgentBridgeProtocol.js';
import { TaskLedger } from './picodeAgentBridgeLedger.js';

/**
 * PiCode's local agent bridge: lets another app on this computer, running as this Windows user,
 * open a project and start a pi chat with an assignment, and get the pi session id back.
 *
 * Off by default (`picode.agentBridge.enabled`). While on, the main process listens on a named
 * pipe only this account on this computer can open (see `picodeAgentBridgePipe.ts`) and publishes
 * `<user data>/agent-bridge.json` with the pipe name, a token renewed at every start, and the
 * executable a caller launches when PiCode is closed. Turning it off removes the file.
 *
 * Exactly-once: see `picodeAgentBridgeLedger.ts`. The window does the chat work and reports back
 * on `vscode:picodeAgentReply` (see `contrib/picode/electron-browser/picodeAgentBridge.ts`). A task
 * stays in flight until its window actually answers (or closes), however long that takes: a
 * caller that stops waiting gets `outcome_uncertain`, and a retry joins the same run instead of
 * starting another one.
 */

export const AGENT_BRIDGE_SETTING = 'picode.agentBridge.enabled';
const INFO_FILE = 'agent-bridge.json';
const LEDGER_FILE = 'agent-bridge-tasks.json';
/** How long a caller's request waits for the task before it is told the outcome is not known yet. */
const CALLER_REPLY_TIMEOUT_MS = 180_000;

/** What a window reports for one `vscode:picodeAgentStart` or `vscode:picodeAgentRecover`. */
export type WindowReply =
	| { readonly kind: 'received'; readonly sessionId: string }
	| { readonly kind: 'not_received'; readonly sessionId?: string }
	| { readonly kind: 'not_sent'; readonly reason: 'folder_not_trusted' | 'not_ready' | 'failed'; readonly message: string }
	| { readonly kind: 'not_found' };

type TaskOutcome =
	| { readonly ok: true; readonly sessionId: string; readonly reused: boolean }
	| { readonly ok: false; readonly code: 'folder_not_trusted' | 'not_sent' | 'outcome_uncertain' | 'internal_error'; readonly message: string };

const UNCERTAIN: TaskOutcome = { ok: false, code: 'outcome_uncertain', message: 'PiCode cannot confirm whether pi received this assignment. It was not sent again.' };

/** One running helper and what belongs to it: replies go back only through the server a request came in on. */
interface Listener {
	readonly server: LocalPipeServer;
	readonly token: string;
	readonly queues: Map<number, Promise<void>>;
}

export class PicodeAgentBridge extends Disposable {

	private listener: Listener | undefined;
	/** `apply` runs one at a time: two quick toggles must not start two helpers. */
	private applying: Promise<void> = Promise.resolve();
	private readonly ledger: TaskLedger<TaskOutcome>;
	private readonly pendingReplies = new Map<string, { readonly window: ICodeWindow; readonly resolve: (reply: WindowReply | undefined) => void }>();

	constructor(
		private readonly configurationService: IConfigurationService,
		private readonly windowsMainService: IWindowsMainService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly logService: ILogService,
	) {
		super();
		this.ledger = new TaskLedger(join(environmentMainService.userDataPath, LEDGER_FILE));
		const onReply = (event: Electron.IpcMainEvent, requestId: unknown, reply: unknown) => {
			if (typeof requestId !== 'string') {
				return;
			}
			const waiting = this.pendingReplies.get(requestId);
			// Only the window the request was sent to may answer it.
			if (waiting === undefined || waiting.window.win?.webContents.id !== event.sender.id) {
				return;
			}
			this.pendingReplies.delete(requestId);
			waiting.resolve(reply as WindowReply);
		};
		validatedIpcMain.on('vscode:picodeAgentReply', onReply);
		this._register(toDisposable(() => validatedIpcMain.removeListener('vscode:picodeAgentReply', onReply)));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_BRIDGE_SETTING)) {
				this.apply();
			}
		}));
		this._register(toDisposable(() => this.stop(false)));
		this.apply();
	}

	private get infoFile(): string {
		return join(this.environmentMainService.userDataPath, INFO_FILE);
	}

	private apply(): void {
		this.applying = this.applying.then(async () => {
			const enabled = process.platform === 'win32' && this.configurationService.getValue<boolean>(AGENT_BRIDGE_SETTING) === true;
			if (enabled && this.listener === undefined) {
				await this.start();
			} else if (!enabled) {
				this.stop(true);
			}
		}).catch(error => this.logService.error(`picode: the agent bridge could not change state: ${String(error)}`));
	}

	private async start(): Promise<void> {
		const userHash = createHash('sha256').update(this.environmentMainService.userDataPath.toLowerCase()).digest('hex').slice(0, 12);
		const pipeName = `picode-agent-${userHash}-${randomBytes(8).toString('hex')}`;
		const token = randomBytes(32).toString('base64url');
		const queues = new Map<number, Promise<void>>();
		let listener: Listener | undefined;
		let server: LocalPipeServer;
		try {
			server = await LocalPipeServer.start(pipeName, {
				onLine: (connection, line) => listener && this.enqueue(listener, connection, line),
				onTooLong: connection => listener && this.reply(listener, connection, errorReply(null, 'invalid_request', 'The request is too long.')),
				onClose: connection => queues.delete(connection),
				onExit: reason => {
					// Only the helper in use counts: one stopped on purpose (a toggle, quitting) exits
					// later, and must not take its successor or the relaunch file with it.
					if (listener !== undefined && this.listener === listener) {
						this.logService.warn(`picode: the agent bridge stopped (${reason})`);
						this.listener = undefined;
						this.removeInfo();
					}
				},
			});
		} catch (error) {
			this.logService.error(`picode: the agent bridge could not start: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		listener = { server, token, queues };
		this.listener = listener;
		this.writeInfo({ version: 1, pipe: `\\\\.\\pipe\\${pipeName}`, token, exe: process.execPath, pid: process.pid });
		this.logService.info('picode: the agent bridge is listening for apps on this computer');
	}

	private stop(removeInfo: boolean): void {
		const listener = this.listener;
		this.listener = undefined;
		listener?.server.dispose();
		if (removeInfo) {
			this.removeInfo();
		} else if (listener !== undefined) {
			// PiCode is quitting: the pipe and its token are gone, the executable is what a caller
			// needs to start PiCode again.
			this.writeInfo({ version: 1, exe: process.execPath });
		}
	}

	private writeInfo(info: object): void {
		try {
			mkdirSync(this.environmentMainService.userDataPath, { recursive: true });
			const temp = `${this.infoFile}.tmp`;
			writeFileSync(temp, JSON.stringify(info, undefined, '\t'));
			renameSync(temp, this.infoFile);
		} catch (error) {
			this.logService.error(`picode: the agent bridge could not write its connection file: ${String(error)}`);
		}
	}

	private removeInfo(): void {
		if (existsSync(this.infoFile)) {
			rmSync(this.infoFile, { force: true });
		}
	}

	/** One line at a time per connection, so a caller's replies keep its order. */
	private enqueue(listener: Listener, connection: number, line: string): void {
		const previous = listener.queues.get(connection) ?? Promise.resolve();
		const next = previous.then(() => this.handle(listener, connection, line));
		listener.queues.set(connection, next);
	}

	private reply(listener: Listener, connection: number, reply: BridgeReply): void {
		// A reply for a helper that has since been replaced is dropped: its connection numbers
		// now belong to other callers.
		if (this.listener === listener) {
			listener.server.send(connection, serializeReply(reply));
		}
	}

	private async handle(listener: Listener, connection: number, line: string): Promise<void> {
		if (line.trim() === '') {
			return;
		}
		const request = parseRequest(line, listener.token);
		if (request.kind === 'error') {
			this.reply(listener, connection, errorReply(request.id, request.code, request.message));
			if (request.code === 'unauthorized') {
				listener.server.close(connection);
			}
			return;
		}
		try {
			const params = request.params;
			if (!isDirectory(params.folder)) {
				this.reply(listener, connection, errorReply(request.id, 'folder_not_found', 'The folder does not exist.'));
				return;
			}
			const decision = this.ledger.claim(params.taskId, params.folderKey, params.promptHash, kind => this.run(params, kind));
			let outcome: TaskOutcome;
			switch (decision.kind) {
				case 'conflict':
					this.reply(listener, connection, errorReply(request.id, 'task_conflict', 'This task was already started with another folder or another assignment.'));
					return;
				case 'unavailable':
					this.reply(listener, connection, errorReply(request.id, 'internal_error', 'PiCode cannot read its list of started tasks, so it is not starting any until that is fixed.'));
					return;
				case 'reuse':
					outcome = { ok: true, sessionId: decision.sessionId, reused: true };
					break;
				default: {
					const result = await withTimeout(decision.outcome, CALLER_REPLY_TIMEOUT_MS);
					outcome = result === undefined ? UNCERTAIN
						// Another request for the same task did the work: this one reuses it.
						: decision.kind === 'wait' && result.ok ? { ...result, reused: true } : result;
				}
			}
			this.reply(listener, connection, outcome.ok
				? { id: request.id, result: { sessionId: outcome.sessionId, taskId: params.taskId, reused: outcome.reused } }
				: errorReply(request.id, outcome.code, outcome.message));
		} catch (error) {
			this.logService.error(`picode: the agent bridge failed on a request: ${String(error)}`);
			this.reply(listener, connection, errorReply(request.id, 'internal_error', 'PiCode could not handle the request.'));
		}
	}

	/** The task's whole run: recover what may already exist, otherwise start it once. */
	private async run(params: SessionStartParams, kind: 'start' | 'recover'): Promise<TaskOutcome> {
		try {
			const window = await this.windowFor(params.folder, params.folderKey);
			if (window === undefined) {
				if (kind === 'start') {
					this.ledger.forget(params.taskId);
				}
				return { ok: false, code: 'not_sent', message: 'PiCode could not open the folder.' };
			}
			if (kind === 'recover') {
				const found = await this.ask(window, 'vscode:picodeAgentRecover', { folder: params.folder, taskId: params.taskId, promptHash: params.promptHash });
				if (found?.kind === 'received') {
					this.ledger.markStarted(params.taskId, params.folderKey, params.promptHash, found.sessionId);
					return { ok: true, sessionId: found.sessionId, reused: true };
				}
				if (!params.resendUncertain) {
					return UNCERTAIN;
				}
			} else {
				// Before the assignment leaves the main process.
				this.ledger.markPending(params.taskId, params.folderKey, params.promptHash);
			}
			const reply = await this.ask(window, 'vscode:picodeAgentStart', {
				folder: params.folder,
				taskId: params.taskId,
				prompt: params.prompt,
				promptHash: params.promptHash,
			});
			if (reply?.kind === 'received') {
				this.ledger.markStarted(params.taskId, params.folderKey, params.promptHash, reply.sessionId);
				return { ok: true, sessionId: reply.sessionId, reused: false };
			}
			if (reply?.kind === 'not_sent') {
				// This attempt stopped before the assignment left the window. A first attempt leaves
				// nothing behind; a resend keeps the earlier attempt's uncertainty on record, so a
				// later request without `resendUncertain` is still told it is uncertain.
				if (kind === 'start') {
					this.ledger.forget(params.taskId);
				}
				return reply.reason === 'folder_not_trusted'
					? { ok: false, code: 'folder_not_trusted', message: reply.message }
					: { ok: false, code: 'not_sent', message: reply.message };
			}
			return UNCERTAIN;
		} catch (error) {
			this.logService.error(`picode: the agent bridge could not run a task: ${String(error)}`);
			return { ok: false, code: 'internal_error', message: 'PiCode could not handle the request.' };
		}
	}

	/** The window that has exactly this folder open, or a new one: never someone's other project. */
	private async windowFor(folder: string, folderKey: string): Promise<ICodeWindow | undefined> {
		const existing = this.windowsMainService.getWindows().find(window =>
			isSingleFolderWorkspaceIdentifier(window.openedWorkspace) && folderKeyOf(window.openedWorkspace.uri.fsPath) === folderKey);
		if (existing !== undefined) {
			existing.focus();
			return existing;
		}
		const windows = await this.windowsMainService.open({
			context: OpenContext.API,
			cli: { ...this.environmentMainService.args, _: [], chat: undefined },
			urisToOpen: [{ folderUri: URI.file(folder) }],
			forceNewWindow: true,
		});
		const window = windows.at(0);
		window?.focus();
		return window;
	}

	/**
	 * Sends one request to a window and waits for its answer, as long as the window lives: the task
	 * stays in flight meanwhile, so nothing can send it again behind this window's back.
	 * `undefined` means the window closed without answering.
	 */
	private ask(window: ICodeWindow, channel: string, payload: object): Promise<WindowReply | undefined> {
		const requestId = randomBytes(12).toString('hex');
		return new Promise(resolve => {
			const closed = window.onDidClose(() => {
				if (this.pendingReplies.delete(requestId)) {
					resolve(undefined);
				}
			});
			this.pendingReplies.set(requestId, {
				window,
				resolve: reply => {
					closed.dispose();
					resolve(reply);
				},
			});
			window.sendWhenReady(channel, CancellationToken.None, requestId, payload);
		});
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(undefined), ms);
		promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
	});
}

function isDirectory(folder: string): boolean {
	try {
		return statSync(folder).isDirectory();
	} catch {
		return false;
	}
}
