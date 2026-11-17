/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The card over a session row's branch badge in the Agent layout: the branches the conversation
 * worked on and, with GitHub connected (Pro), the pull requests of its current branch.
 *
 * The connector writes the branches into the row's `metadata.picodeGit` (`session-git.ts`); the
 * pull requests are asked when the card opens, through the cloud service like the issues panels.
 */

import './media/picodeSessionBranch.css';
import { $, append, addDisposableListener, clearNode, EventType } from '../../../../base/browser/dom.js';
import { HoverStyle } from '../../../../base/browser/ui/hover/hover.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IAgentSession } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { IPicodePull } from './account/issues/picodeIssueBoard.js';
import { IPicodeConnectorService } from './account/issues/picodeConnectorService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';

interface ISessionGit {
	readonly branches: readonly string[];
	readonly repo: string | undefined;
}

function sessionGitOf(session: IAgentSession): ISessionGit | undefined {
	const raw = session.metadata?.picodeGit;
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const { branches, repo } = raw as { branches?: unknown; repo?: unknown };
	const names = Array.isArray(branches) ? branches.filter((b): b is string => typeof b === 'string' && b !== '') : [];
	if (names.length === 0) {
		return undefined;
	}
	return { branches: names, repo: typeof repo === 'string' && repo !== '' ? repo : undefined };
}

function stateLabel(state: IPicodePull['state']): string {
	switch (state) {
		case 'open': return localize('picode.pull.open', "Open");
		case 'draft': return localize('picode.pull.draft', "Draft");
		case 'merged': return localize('picode.pull.merged', "Merged");
		case 'closed': return localize('picode.pull.closed', "Closed");
	}
}

function stateIcon(state: IPicodePull['state']): ThemeIcon {
	switch (state) {
		case 'merged': return Codicon.gitMerge;
		case 'closed': return Codicon.gitPullRequestClosed;
		case 'draft': return Codicon.gitPullRequestDraft;
		default: return Codicon.gitPullRequest;
	}
}

/** What the session list calls for each row with a badge (`IAgentSessionsControlOptions.badgeHover`). */
export function setupSessionBranchHover(
	session: IAgentSession,
	target: HTMLElement,
	hoverService: IHoverService,
	connectorService: IPicodeConnectorService,
	openerService: IOpenerService,
): IDisposable | undefined {
	const git = sessionGitOf(session);
	if (git === undefined) {
		return undefined;
	}
	return hoverService.setupDelayedHover(target, () => {
		const card = $('.picode-branch-card');
		const current = git.branches[git.branches.length - 1];
		const head = append(card, $('.picode-branch-card-head'));
		append(head, $(`span${ThemeIcon.asCSSSelector(Codicon.gitBranch)}`));
		append(head, $('span.picode-branch-card-name')).textContent = current;
		const earlier = git.branches.slice(0, -1).reverse();
		if (earlier.length > 0) {
			append(card, $('.picode-branch-card-earlier')).textContent = localize('picode.branch.earlier', "Also worked on: {0}", earlier.join(', '));
		}
		if (git.repo !== undefined && connectorService.isConnected('github')) {
			const pulls = append(card, $('.picode-branch-card-pulls'));
			append(pulls, $('.picode-branch-card-loading')).textContent = localize('picode.branch.loadingPulls', "Looking for pull requests…");
			void connectorService.pullsForBranch(git.repo, current).then(found => {
				clearNode(pulls);
				if (found === undefined) {
					pulls.remove();
					return;
				}
				if (found.length === 0) {
					append(pulls, $('.picode-branch-card-none')).textContent = localize('picode.branch.noPulls', "No pull requests for this branch");
					return;
				}
				for (const pull of found) {
					const row = append(pulls, $(`a.picode-branch-pull.is-${pull.state}`));
					row.tabIndex = 0;
					append(row, $(`span.picode-branch-pull-icon${ThemeIcon.asCSSSelector(stateIcon(pull.state))}`));
					const text = append(row, $('.picode-branch-pull-text'));
					append(text, $('.picode-branch-pull-title')).textContent = pull.title;
					append(text, $('.picode-branch-pull-meta')).textContent = `${stateLabel(pull.state)} · ${git.repo} #${pull.number}`;
					const url = pull.url;
					if (url !== undefined) {
						const open = () => openerService.open(URI.parse(url), { openExternal: true });
						row.addEventListener(EventType.CLICK, open);
						addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
							if (e.key === 'Enter') {
								void open();
							}
						});
					}
				}
			});
		}
		return {
			content: card,
			style: HoverStyle.Pointer,
			position: { hoverPosition: HoverPosition.RIGHT },
			persistence: { sticky: true },
		};
	}, { groupId: 'picode.session.branch' });
}

/**
 * Archiving a session that works in its own copy of the project offers to remove the copy (the
 * connector asks, and keeps a copy with uncommitted work). In both layouts: archiving is the list's.
 */
class PicodeArchivedCopyContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.picodeArchivedCopy';

	constructor(
		@IAgentSessionsService agentSessionsService: IAgentSessionsService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		this._register(agentSessionsService.model.onDidChangeSessionArchivedState(session => {
			const picodeGit = session.metadata?.picodeGit;
			const hasCopy = typeof picodeGit === 'object' && picodeGit !== null && (picodeGit as { worktree?: unknown }).worktree === true;
			if (session.isArchived() && hasCopy) {
				void commandService.executeCommand('picode.session.offerRemoveCopy', session.resource.toString());
			}
		}));
	}
}

registerWorkbenchContribution2(PicodeArchivedCopyContribution.ID, PicodeArchivedCopyContribution, WorkbenchPhase.AfterRestored);
