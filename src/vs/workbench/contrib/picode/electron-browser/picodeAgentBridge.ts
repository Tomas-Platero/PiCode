/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../chat/browser/chat.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';

/**
 * The window half of PiCode's local agent bridge (the main half is
 * `code/electron-main/picodeAgentBridge.ts`).
 *
 * `vscode:picodeAgentStart` starts one task: it creates **its own** chat session (never the one on
 * screen), tells the connector which task that session carries, shows it, sends the assignment to
 * that session, and reports back only once pi has the assignment in that session's history. Every
 * failure before the assignment is handed to the chat is reported as `not_sent`, which lets the
 * main process start the task again later; anything after that point is never reported as
 * `not_sent`, because pi may already have it.
 *
 * `vscode:picodeAgentRecover` looks for a task's session on disk, by the task mark the connector
 * writes into the session itself (not its title, which can be renamed).
 */

const CONNECTOR_READY_TIMEOUT_MS = 60_000;
// The first turn of a chat can install the profile's packages before pi takes the message.
const RECEIVED_TIMEOUT_MS = 600_000;
const BIND_TASK_COMMAND = 'picode.agent.bindTask';
const SESSION_FOR_COMMAND = 'picode.agent.sessionFor';
const FIND_TASK_COMMAND = 'picode.agent.findTaskSession';

interface StartRequest {
	readonly folder: string;
	readonly taskId: string;
	readonly prompt: string;
	readonly promptHash: string;
}

interface RecoverRequest {
	readonly folder: string;
	readonly taskId: string;
	readonly promptHash: string;
}

/** What the connector reports for a session: its id once it exists, and whether pi has the assignment. */
interface ConnectorSessionState {
	readonly sessionId?: string;
	readonly received: boolean;
}

class PicodeAgentBridgeWindow extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeAgentBridge';

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustRequestService private readonly workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const onStart = (_: unknown, requestId: unknown, request: unknown) => {
			if (typeof requestId === 'string') {
				void this.start(request as StartRequest).then(reply => ipcRenderer.send('vscode:picodeAgentReply', requestId, reply));
			}
		};
		const onRecover = (_: unknown, requestId: unknown, request: unknown) => {
			if (typeof requestId === 'string') {
				void this.recover(request as RecoverRequest).then(reply => ipcRenderer.send('vscode:picodeAgentReply', requestId, reply));
			}
		};
		ipcRenderer.on('vscode:picodeAgentStart', onStart);
		ipcRenderer.on('vscode:picodeAgentRecover', onRecover);
		this._register({
			dispose: () => {
				ipcRenderer.removeListener('vscode:picodeAgentStart', onStart);
				ipcRenderer.removeListener('vscode:picodeAgentRecover', onRecover);
			}
		});
	}

	private async connectorReady(): Promise<boolean> {
		const deadline = Date.now() + CONNECTOR_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (CommandsRegistry.getCommand(BIND_TASK_COMMAND) && CommandsRegistry.getCommand(SESSION_FOR_COMMAND)) {
				return true;
			}
			await timeout(250);
		}
		return false;
	}

	private async start(request: StartRequest): Promise<unknown> {
		// Until the assignment is handed to the chat, every failure means pi never saw it.
		let handedOver = false;
		try {
			if (this.workspaceContextService.getWorkspaceFolder(URI.file(request.folder)) === null) {
				return { kind: 'not_sent', reason: 'failed', message: 'PiCode could not open the folder.' };
			}
			const trusted = await this.workspaceTrustRequestService.requestWorkspaceTrust({
				message: localize('picodeAgentBridgeTrust', "An app on this computer wants pi to work in this folder. Trust it to start the chat."),
			});
			if (!trusted) {
				return { kind: 'not_sent', reason: 'folder_not_trusted', message: 'The folder was not trusted, so the chat did not start.' };
			}
			if (!await this.connectorReady()) {
				return { kind: 'not_sent', reason: 'not_ready', message: 'pi was not ready in time.' };
			}
			const ref = this.chatService.startNewLocalSession(ChatAgentLocation.Chat);
			try {
				const resource = ref.object.sessionResource;
				await this.commandService.executeCommand(BIND_TASK_COMMAND, resource.toString(), {
					taskId: request.taskId,
					promptHash: request.promptHash,
					title: titleFor(request.taskId, request.prompt),
				});
				const widget = await this.chatWidgetService.openSession(resource, ChatViewPaneTarget);
				if (widget === undefined || widget.viewModel?.sessionResource.toString() !== resource.toString()) {
					return { kind: 'not_sent', reason: 'failed', message: 'PiCode could not show the chat.' };
				}
				const agentMode = widget.input.currentChatModesObs.get().findModeByName(ChatModeKind.Agent);
				if (agentMode) {
					widget.input.setChatMode(agentMode.id, true, true);
				}
				handedOver = true;
				await widget.acceptInput(request.prompt, { noCommandDetection: true, storeToHistory: false });
				const state = await this.commandService.executeCommand<ConnectorSessionState>(SESSION_FOR_COMMAND, resource.toString(), RECEIVED_TIMEOUT_MS);
				if (state?.received && state.sessionId) {
					return { kind: 'received', sessionId: state.sessionId };
				}
				return { kind: 'not_received', sessionId: state?.sessionId };
			} finally {
				ref.dispose();
			}
		} catch (error) {
			this.logService.error('picode: the agent bridge could not start a chat', error);
			return handedOver
				? { kind: 'not_received' }
				: { kind: 'not_sent', reason: 'failed', message: 'PiCode could not start the chat.' };
		}
	}

	private async recover(request: RecoverRequest): Promise<unknown> {
		try {
			if (!await this.connectorReady()) {
				return { kind: 'not_found' };
			}
			const state = await this.commandService.executeCommand<ConnectorSessionState | undefined>(FIND_TASK_COMMAND, request.folder, request.taskId, request.promptHash);
			if (state?.received && state.sessionId) {
				return { kind: 'received', sessionId: state.sessionId };
			}
			return state?.sessionId ? { kind: 'not_received', sessionId: state.sessionId } : { kind: 'not_found' };
		} catch (error) {
			this.logService.error('picode: the agent bridge could not look for a task session', error);
			return { kind: 'not_found' };
		}
	}
}

/** The session's name in the Sessions list: the task first, so it is easy to tell apart. */
function titleFor(taskId: string, prompt: string): string {
	const firstLine = prompt.trim().split(/\r?\n/)[0] ?? '';
	const short = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
	return short ? `${taskId} · ${short}` : taskId;
}

registerWorkbenchContribution2(PicodeAgentBridgeWindow.ID, PicodeAgentBridgeWindow, WorkbenchPhase.BlockRestore);
