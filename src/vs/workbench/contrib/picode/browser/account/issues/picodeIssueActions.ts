/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IWorkspaceTrustManagementService } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { ACTION_ID_NEW_CHAT } from '../../../../chat/browser/actions/chatActions.js';
import { PicodeAccountEditorInput } from '../picodeAccountEditorInput.js';
import { PicodeConnectOutcome, IPicodeIssuesResult } from './picodeConnectorService.js';
import { buildFixPrompt } from './picodeIssuePrompt.js';
import { IPicodeIssue } from './picodeIssueSources.js';

/** The one sentence a failed connection attempt gets, or nothing when there is nothing to say. */
export function outcomeMessage(outcome: PicodeConnectOutcome, name: string): string | undefined {
	switch (outcome) {
		case 'connected':
		case 'cancelled': return undefined;
		case 'denied': return localize('picodeConnectDenied', "{0} did not get your permission.", name);
		case 'expired': return localize('picodeConnectExpired', "The code expired. Try again.");
		case 'notPro': return localize('picodeConnectNotPro', "Issues come with the Pro plan.");
		case 'failed': return localize('picodeConnectFailed', "The connection could not be made. Try again.");
	}
}

/** The one sentence a failed read of the issues gets. */
export function stateMessage(result: IPicodeIssuesResult, name: string): string | undefined {
	switch (result.state) {
		case 'ok':
		case 'notConnected': return undefined;
		case 'reconnect': return localize('picodeIssuesEnded', "The connection ended.");
		case 'notPro': return localize('picodeIssuesNotPro', "Issues come with the Pro plan.");
		case 'notInstalled': return localize('picodeIssuesNotInstalled', "PiCode cannot see any of your repositories yet.");
		case 'rateLimited': return localize('picodeIssuesRateLimited', "{0} asked to wait a few minutes.", name);
		case 'offline': return result.stale
			? localize('picodeIssuesOfflineStale', "Could not reach {0}. This is the last list.", name)
			: localize('picodeIssuesOffline', "Could not reach {0}.", name);
	}
}

/** What "Fix with pi" does and when it is off. Shared by the Status panels. */
export class PicodeIssueActions {

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	/** Why the button is off, in words for the person; `undefined` when it works. */
	fixBlockedReason(issue: IPicodeIssue, workspaceRepo: string | undefined): string | undefined {
		if (this.workspaceContextService.getWorkspace().folders.length === 0) {
			return localize('picodeIssueFixNoProject', "Open a project first.");
		}
		if (!this.trustService.isWorkspaceTrusted()) {
			return localize('picodeIssueFixUntrusted', "Trust this folder first.");
		}
		if (issue.source === 'github' && workspaceRepo && issue.project.toLowerCase() !== workspaceRepo) {
			return localize('picodeIssueFixOtherProject', "Open the project {0} first.", issue.project);
		}
		return undefined;
	}

	/** Puts the issue in a new chat, written but NOT sent: the person reads it and decides. */
	async fix(issue: IPicodeIssue): Promise<void> {
		// From the Account window the chat would stay hidden behind it, so that window goes first.
		const active = this.editorService.activeEditor;
		const groupId = this.editorService.activeEditorPane?.group.id;
		if (active instanceof PicodeAccountEditorInput && groupId !== undefined) {
			await this.editorService.closeEditor({ editor: active, groupId });
		}
		await this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
		await this.commandService.executeCommand('workbench.action.chat.open', { query: buildFixPrompt(issue), isPartialQuery: true, mode: 'agent' });
	}
}
