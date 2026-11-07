/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './picodeIssues.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../../base/common/date.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import {
	buildColumns, filterIssues, initialsOf, IPicodeBoardIssue, IPicodeBoardStatus, IPicodeProjectView, PicodeBoardLayout, PicodeStatusCategory,
} from './picodeIssueBoard.js';
import { IPicodeConnectorService, IPicodeProjectViewResult } from './picodeConnectorService.js';
import { outcomeMessage, PicodeIssueActions, stateMessage } from './picodeIssueActions.js';
import { IPicodeIssuesEditorOptions, PICODE_ISSUES_EDITOR_ID, PicodeIssuesEditorInput } from './picodeIssuesEditorInput.js';

/** Opens the Account window, where the connections are made (`picode.account.open`). */
const OPEN_ACCOUNT_COMMAND = 'picode.account.open';

const OPEN_LABEL = () => localize('picodeIssuesViewOpen', "Open");
const CLOSED_LABEL = () => localize('picodeIssuesViewClosed', "Closed");

/**
 * The issues viewer: a whole Jira project (a board or a list) or a whole GitHub repository
 * (a list), with the issue that was clicked open on the right.
 */
export class PicodeIssuesEditor extends EditorPane {
	static readonly ID = PICODE_ISSUES_EDITOR_ID;

	private root: HTMLElement | undefined;
	private headerHost: HTMLElement | undefined;
	private bodyHost: HTMLElement | undefined;
	private detailHost: HTMLElement | undefined;
	private readonly headerStore = this._register(new DisposableStore());
	private readonly bodyStore = this._register(new DisposableStore());
	private readonly detailStore = this._register(new DisposableStore());

	private current: PicodeIssuesEditorInput | undefined;
	private result: IPicodeProjectViewResult | undefined;
	private loading = false;
	/** Bumped on every read, so an answer that arrives after the tab changed is thrown away. */
	private generation = 0;
	private layoutMode: PicodeBoardLayout | undefined;
	private githubState: 'open' | 'closed' = 'open';
	private query = '';
	private selectedKey: string | undefined;
	private workspaceRepo: string | undefined;
	private readonly items = new Map<string, HTMLElement>();
	/** Cards moved by hand and not yet confirmed by a fresh read: the board shows them in their new column. */
	private readonly moved = new Map<string, { readonly status: string; readonly statusId: string; readonly category: PicodeStatusCategory }>();
	private dragKey: string | undefined;
	private bannerHost: HTMLElement | undefined;
	private readonly actions: PicodeIssueActions;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IPicodeConnectorService private readonly connectors: IPicodeConnectorService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super(PicodeIssuesEditor.ID, group, telemetryService, themeService, storageService);
		this.actions = instantiationService.createInstance(PicodeIssueActions);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.picode-issues-view'));
		this.headerHost = append(this.root, $('.picode-issues-header'));
		this.bannerHost = append(this.root, $('.picode-issues-banner'));
		this.bodyHost = append(this.root, $('.picode-issues-main'));
		this._register(this.connectors.onDidChange(() => { if (this.current) { void this.load(); } }));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof PicodeIssuesEditorInput)) {
			return;
		}
		this.current = input;
		this.result = undefined;
		this.layoutMode = undefined;
		this.githubState = 'open';
		this.query = '';
		this.selectedKey = (options as IPicodeIssuesEditorOptions | undefined)?.selectKey;
		await this.load();
	}

	/** The tab was already open: the click only picks another issue in it. */
	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		const key = (options as IPicodeIssuesEditorOptions | undefined)?.selectKey;
		if (key && key !== this.selectedKey) {
			this.selectedKey = key;
			if (this.result?.view) {
				this.renderBody();
			}
		}
	}

	override clearInput(): void {
		this.generation++;
		this.current = undefined;
		super.clearInput();
	}

	layout(): void {
		// The page is laid out by CSS.
	}

	/** `quiet` re-reads without the loading screen: the board stays as it is until the answer comes. */
	private async load(quiet = false): Promise<void> {
		const input = this.current;
		if (!input) {
			return;
		}
		const generation = ++this.generation;
		if (!quiet) {
			this.loading = true;
			this.renderHeader();
			this.renderBody();
		}
		const [result, repo] = await Promise.all([
			this.connectors.loadProjectView(input.source, input.ref),
			input.source === 'github' ? this.connectors.workspaceRepoKey() : Promise.resolve(undefined),
		]);
		if (generation !== this.generation) {
			return;
		}
		this.loading = false;
		this.moved.clear();
		this.result = result;
		this.workspaceRepo = repo;
		if (result.view) {
			this.layoutMode ??= result.view.layout;
		}
		this.renderHeader();
		this.renderBody();
		this.updateBoardBanner();
	}

	// -- Header -------------------------------------------------------------------------------------

	private renderHeader(): void {
		const host = this.headerHost;
		const input = this.current;
		if (!host || !input) {
			return;
		}
		this.headerStore.clear();
		clearNode(host);
		const view = this.result?.view;
		append(host, $(`span.picode-issues-header-icon${ThemeIcon.asCSSSelector(Codicon.issues)}`));
		const heading = append(host, $('h2.picode-issues-heading'));
		heading.textContent = view?.name ?? input.getName();
		append(heading, $('span.picode-issues-ref')).textContent = input.source === 'jira' ? input.ref : '';
		append(host, $('.picode-issues-spacer'));
		if (!view) {
			return;
		}

		const search = append(host, $('input.picode-issues-search', { type: 'search', placeholder: localize('picodeIssuesViewSearch', "Search issues") })) as HTMLInputElement;
		search.value = this.query;
		this.headerStore.add(addDisposableListener(search, EventType.INPUT, () => { this.query = search.value; this.renderBody(); }));

		if (view.source === 'jira') {
			const segment = append(host, $('.picode-issues-segment'));
			this.segmentButton(segment, localize('picodeIssuesViewBoard', "Board"), Codicon.layout, this.layoutMode === 'kanban', () => this.setLayout('kanban'));
			this.segmentButton(segment, localize('picodeIssuesViewList', "List"), Codicon.listFlat, this.layoutMode === 'list', () => this.setLayout('list'));
		} else {
			const counts = { open: 0, closed: 0 };
			for (const issue of view.issues) {
				counts[issue.status === 'closed' ? 'closed' : 'open']++;
			}
			const segment = append(host, $('.picode-issues-segment'));
			this.segmentButton(segment, `${OPEN_LABEL()} ${counts.open}`, Codicon.issues, this.githubState === 'open', () => this.setGithubState('open'));
			this.segmentButton(segment, `${CLOSED_LABEL()} ${counts.closed}`, Codicon.check, this.githubState === 'closed', () => this.setGithubState('closed'));
		}

		const refresh = append(host, $('button.picode-issue-fix', { type: 'button', 'aria-label': localize('picodeIssuesRefresh', "Refresh"), title: localize('picodeIssuesRefresh', "Refresh") })) as HTMLButtonElement;
		append(refresh, $(`span${ThemeIcon.asCSSSelector(Codicon.sync)}`));
		this.headerStore.add(addDisposableListener(refresh, EventType.CLICK, () => void this.load()));
	}

	private segmentButton(parent: HTMLElement, label: string, icon: ThemeIcon, active: boolean, run: () => void): void {
		const button = append(parent, $('button.picode-issues-segment-button', { type: 'button' })) as HTMLButtonElement;
		button.classList.toggle('active', active);
		append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		append(button, $('span')).textContent = label;
		this.headerStore.add(addDisposableListener(button, EventType.CLICK, run));
	}

	private setLayout(layout: PicodeBoardLayout): void {
		this.layoutMode = layout;
		this.renderHeader();
		this.renderBody();
		this.updateBoardBanner();
	}

	private setGithubState(state: 'open' | 'closed'): void {
		this.githubState = state;
		this.renderHeader();
		this.renderBody();
	}

	// -- Body ---------------------------------------------------------------------------------------

	private renderBody(): void {
		const host = this.bodyHost;
		if (!host) {
			return;
		}
		this.bodyStore.clear();
		this.detailStore.clear();
		clearNode(host);
		this.items.clear();
		this.detailHost = undefined;
		const input = this.current;
		if (!input) {
			return;
		}
		if (this.loading || !this.result) {
			this.message(host, Codicon.loading, localize('picodeIssuesLoading', "Loading issues…"));
			return;
		}
		const view = this.result.view;
		if (!view) {
			this.renderProblem(host, input);
			return;
		}
		const content = append(host, $('.picode-issues-content'));
		let issues = filterIssues(this.issuesOf(view), this.query);
		if (view.source === 'github') {
			issues = issues.filter(issue => (issue.status === 'closed') === (this.githubState === 'closed'));
		}
		if (issues.length === 0) {
			this.message(content, Codicon.issues, this.query ? localize('picodeIssuesViewNoMatch', "No issues match your search.") : localize('picodeIssuesViewEmpty', "No issues here."));
		} else if (view.source === 'jira' && this.layoutMode === 'kanban') {
			this.renderBoard(content, view, issues);
		} else {
			this.renderList(content, view, issues);
		}
		if (view.truncated) {
			append(content, $('.picode-issues-note')).textContent = localize('picodeIssuesViewTruncated', "Showing the latest {0} issues.", view.issues.length);
		}
		this.detailHost = append(host, $('.picode-issues-detail'));
		this.renderDetail(view);
	}

	/** The issues as the board shows them: the ones moved by hand already in their new status. */
	private issuesOf(view: IPicodeProjectView): readonly IPicodeBoardIssue[] {
		return this.moved.size === 0 ? view.issues : view.issues.map(issue => {
			const move = this.moved.get(issue.key);
			return move ? { ...issue, ...move } : issue;
		});
	}

	private renderProblem(host: HTMLElement, input: PicodeIssuesEditorInput): void {
		const name = input.source === 'github' ? 'GitHub' : 'Jira';
		const state = this.result?.state ?? 'offline';
		const box = append(host, $('.picode-issues-message'));
		if (state === 'notConnected' || state === 'reconnect') {
			append(box, $(`span${ThemeIcon.asCSSSelector(Codicon.plug)}`));
			append(box, $('span')).textContent = state === 'reconnect' ? localize('picodeIssuesEnded', "The connection ended.") : localize('picodeConnectorNotConnected', "Not connected");
			this.button(box, localize('picodeConnectorConnect', "Connect"), () => void this.commandService.executeCommand(OPEN_ACCOUNT_COMMAND));
			return;
		}
		append(box, $(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`));
		append(box, $('span')).textContent = stateMessage({ state, issues: [], stale: false }, name) ?? '';
		this.button(box, localize('picodeIssuesRefresh', "Refresh"), () => void this.load());
	}

	private message(parent: HTMLElement, icon: ThemeIcon, text: string): void {
		const box = append(parent, $('.picode-issues-message'));
		append(box, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		append(box, $('span')).textContent = text;
	}

	private button(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $('button.picode-overview-action', { type: 'button' })) as HTMLButtonElement;
		button.textContent = label;
		this.bodyStore.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	// -- Board and list ---------------------------------------------------------------------------

	private renderBoard(parent: HTMLElement, view: IPicodeProjectView, issues: readonly IPicodeBoardIssue[]): void {
		const board = append(parent, $('.picode-issues-board'));
		for (const column of buildColumns(view.statuses, issues)) {
			const element = append(board, $('.picode-issues-column'));
			this.dropTarget(element, column.status);
			const head = append(element, $('.picode-issues-column-head'));
			append(head, $('span.picode-issues-column-name')).textContent = column.status.name;
			append(head, $('span.picode-issues-column-count')).textContent = String(column.issues.length);
			const body = append(element, $('.picode-issues-column-body'));
			for (const issue of column.issues) {
				const card = append(body, $('.picode-issue-card'));
				this.draggable(card, issue.key);
				append(card, $('.picode-issue-card-title')).textContent = issue.title;
				if (issue.labels.length > 0) {
					const tags = append(card, $('.picode-issue-card-tags'));
					for (const label of issue.labels) {
						append(tags, $('span.picode-issue-tag')).textContent = label;
					}
				}
				const foot = append(card, $('.picode-issue-card-foot'));
				append(foot, $(`span${ThemeIcon.asCSSSelector(typeIcon(issue.type))}`));
				append(foot, $('span.picode-issue-key')).textContent = issue.key;
				append(foot, $('.picode-issues-spacer'));
				this.priorityMark(foot, issue.priority);
				if (issue.assignee) {
					const avatar = append(foot, $('span.picode-issue-avatar'));
					avatar.textContent = initialsOf(issue.assignee);
					avatar.title = issue.assignee;
				}
				this.pickable(card, issue.key);
			}
		}
	}

	private renderList(parent: HTMLElement, view: IPicodeProjectView, issues: readonly IPicodeBoardIssue[]): void {
		const github = view.source === 'github';
		const table = append(parent, $(`.picode-issues-table${github ? '.github' : ''}`));
		const head = append(table, $('.picode-issues-row.head'));
		const columns = github
			? [localize('picodeIssuesViewKey', "Issue"), '', localize('picodeIssuesViewAssignee', "Assignee"), '', localize('picodeIssuesViewUpdated', "Updated")]
			: [localize('picodeIssuesViewKey', "Issue"), '', localize('picodeIssuesViewAssignee', "Assignee"), localize('picodeIssuesViewPriority', "Priority"), localize('picodeIssuesViewStatus', "Status"), localize('picodeIssuesViewUpdated', "Updated")];
		for (const column of columns) {
			append(head, $('span')).textContent = column;
		}
		for (const issue of issues) {
			const row = append(table, $('.picode-issues-row.item'));
			const key = append(row, $('span.picode-issue-key-cell'));
			append(key, $(`span${ThemeIcon.asCSSSelector(typeIcon(issue.type))}`));
			append(key, $('span.picode-issue-key')).textContent = github ? `#${issue.key.split('#')[1]}` : issue.key;
			const title = append(row, $('span.picode-issue-title-cell'));
			append(title, $('span.picode-issue-title-text')).textContent = issue.title;
			if (github) {
				for (const label of issue.labels) {
					append(title, $('span.picode-issue-tag')).textContent = label;
				}
			}
			append(row, $('span.picode-issue-assignee-cell')).textContent = issue.assignee;
			if (github) {
				const comments = append(row, $('span.picode-issue-comments-cell'));
				if (issue.comments > 0) {
					append(comments, $(`span${ThemeIcon.asCSSSelector(Codicon.comment)}`));
					append(comments, $('span')).textContent = String(issue.comments);
				}
			} else {
				this.priorityMark(append(row, $('span.picode-issue-priority-cell')), issue.priority, true);
				this.statusChip(append(row, $('span')), issue);
			}
			append(row, $('span.picode-issue-updated-cell')).textContent = ageOf(issue.updatedAt);
			this.pickable(row, issue.key);
		}
	}

	// -- Moving a card to another column ----------------------------------------------------------------

	private draggable(card: HTMLElement, key: string): void {
		card.draggable = true;
		this.bodyStore.add(addDisposableListener(card, EventType.DRAG_START, e => {
			this.dragKey = key;
			e.dataTransfer?.setData('text/plain', key);
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
			}
			card.classList.add('dragging');
		}));
		this.bodyStore.add(addDisposableListener(card, EventType.DRAG_END, () => {
			this.dragKey = undefined;
			card.classList.remove('dragging');
		}));
	}

	private dropTarget(column: HTMLElement, status: IPicodeBoardStatus): void {
		this.bodyStore.add(addDisposableListener(column, EventType.DRAG_OVER, e => {
			if (this.dragKey) {
				e.preventDefault();
				column.classList.add('drop');
			}
		}));
		this.bodyStore.add(addDisposableListener(column, EventType.DRAG_LEAVE, e => {
			if (!(e.relatedTarget instanceof Node && column.contains(e.relatedTarget))) {
				column.classList.remove('drop');
			}
		}));
		this.bodyStore.add(addDisposableListener(column, EventType.DROP, e => {
			e.preventDefault();
			column.classList.remove('drop');
			const key = this.dragKey;
			this.dragKey = undefined;
			if (key) {
				void this.moveCard(key, status);
			}
		}));
	}

	private async moveCard(key: string, status: IPicodeBoardStatus): Promise<void> {
		const view = this.result?.view;
		const issue = view ? this.issuesOf(view).find(candidate => candidate.key === key) : undefined;
		if (!view || !issue || issue.status === status.name) {
			return;
		}
		this.clearBanner();
		if (!(await this.connectors.canMoveJiraIssues())) {
			this.askToAllowMoving(key, status);
			return;
		}
		// The card moves at once; if Jira says no it goes back and the reason is shown.
		const before = this.moved.get(key);
		this.moved.set(key, { status: status.name, statusId: status.ids?.[0] ?? '', category: status.category });
		this.renderBody();
		const outcome = await this.connectors.moveJiraIssue(key, status);
		if (outcome === 'moved') {
			void this.load(true);
			return;
		}
		if (before) {
			this.moved.set(key, before);
		} else {
			this.moved.delete(key);
		}
		this.renderBody();
		if (outcome === 'needsPermission') {
			this.askToAllowMoving(key, status);
		} else {
			this.showBanner(outcome === 'notAllowed'
				? localize('picodeIssuesViewMoveBlocked', "Jira does not allow moving this issue to {0} from here.", status.name)
				: localize('picodeIssuesViewMoveFailed', "The issue could not be moved. Try again."));
		}
	}

	/** The board shows Jira's own columns only when the account allowed reading boards: when not, it says so. */
	private updateBoardBanner(): void {
		const view = this.result?.view;
		this.clearBanner();
		if (!view || view.source !== 'jira' || this.layoutMode !== 'kanban' || view.columns === 'board') {
			return;
		}
		if (view.columns === 'needsPermission') {
			this.showBanner(localize('picodeIssuesViewNeedsBoards', "To show the same columns as Jira, PiCode needs permission to read your boards."), localize('picodeIssuesViewAllow', "Allow"), () => {
				const source = new CancellationTokenSource();
				this.showBanner(localize('picodeIssuesWaiting', "Waiting for {0}…", 'Jira'));
				void this.connectors.connectAtlassian(source.token, { boards: true }).then(outcome => {
					source.dispose();
					if (outcome === 'connected') {
						return this.load();
					}
					this.showBanner(outcomeMessage(outcome, 'Jira') ?? localize('picodeIssuesViewMoveFailed', "The issue could not be moved. Try again."));
					return undefined;
				});
			});
		} else {
			this.showBanner(localize('picodeIssuesViewColumnsFromStatuses', "The board's columns could not be read, so these come from the project's statuses."));
		}
	}

	/** Moving issues changes them in Jira, so the permission is asked the first time it is needed, not when connecting. */
	private askToAllowMoving(key: string, status: IPicodeBoardStatus): void {
		this.showBanner(localize('picodeIssuesViewNeedsWrite', "To move issues, PiCode needs permission to change them in Jira."), localize('picodeIssuesViewAllow', "Allow"), () => {
			const source = new CancellationTokenSource();
			this.showBanner(localize('picodeIssuesWaiting', "Waiting for {0}…", 'Jira'));
			void this.connectors.connectAtlassian(source.token, { write: true }).then(outcome => {
				source.dispose();
				if (outcome === 'connected') {
					this.clearBanner();
					return this.moveCard(key, status);
				}
				this.showBanner(outcomeMessage(outcome, 'Jira') ?? localize('picodeIssuesViewMoveFailed', "The issue could not be moved. Try again."));
				return undefined;
			});
		});
	}

	private showBanner(text: string, actionLabel?: string, run?: () => void): void {
		const host = this.bannerHost;
		if (!host) {
			return;
		}
		clearNode(host);
		host.classList.add('shown');
		append(host, $('span')).textContent = text;
		if (actionLabel && run) {
			const button = append(host, $('button.picode-overview-action', { type: 'button' })) as HTMLButtonElement;
			button.textContent = actionLabel;
			button.addEventListener('click', run, { once: true });
		}
	}

	private clearBanner(): void {
		if (this.bannerHost) {
			clearNode(this.bannerHost);
			this.bannerHost.classList.remove('shown');
		}
	}

	private pickable(element: HTMLElement, key: string): void {
		this.items.set(key, element);
		element.classList.toggle('selected', key === this.selectedKey);
		this.bodyStore.add(addDisposableListener(element, EventType.CLICK, () => this.select(key)));
	}

	private select(key: string): void {
		this.items.get(this.selectedKey ?? '')?.classList.remove('selected');
		this.selectedKey = key;
		this.items.get(key)?.classList.add('selected');
		const view = this.result?.view;
		if (view) {
			this.renderDetail(view);
		}
	}

	private priorityMark(parent: HTMLElement, priority: string, withName = false): void {
		if (!priority) {
			return;
		}
		const level = priorityLevel(priority);
		const mark = append(parent, $(`span.picode-issue-priority.${level}`));
		append(mark, $(`span${ThemeIcon.asCSSSelector(level === 'high' ? Codicon.arrowUp : level === 'low' ? Codicon.arrowDown : Codicon.remove)}`));
		if (withName) {
			append(mark, $('span')).textContent = priority;
		} else {
			mark.title = priority;
		}
	}

	private statusChip(parent: HTMLElement, issue: IPicodeBoardIssue): void {
		const label = issue.source === 'github' ? (issue.status === 'closed' ? CLOSED_LABEL() : OPEN_LABEL()) : issue.status;
		append(parent, $(`span.picode-issue-status.${issue.category}`)).textContent = label;
	}

	// -- The issue on the right ---------------------------------------------------------------------

	private renderDetail(view: IPicodeProjectView): void {
		const host = this.detailHost;
		if (!host) {
			return;
		}
		this.detailStore.clear();
		clearNode(host);
		const issue = this.issuesOf(view).find(candidate => candidate.key === this.selectedKey);
		host.classList.toggle('open', !!issue);
		if (!issue) {
			return;
		}
		const head = append(host, $('.picode-issues-detail-head'));
		const key = append(head, $('a.picode-issue-key', { href: '#' }));
		key.textContent = issue.key;
		this.detailStore.add(addDisposableListener(key, EventType.CLICK, e => { e.preventDefault(); void this.openerService.open(URI.parse(issue.url), { openExternal: true }); }));
		append(head, $('.picode-issues-spacer'));
		const close = append(head, $('button.picode-issue-fix', { type: 'button', 'aria-label': localize('picodeIssuesViewClose', "Close"), title: localize('picodeIssuesViewClose', "Close") })) as HTMLButtonElement;
		append(close, $(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this.detailStore.add(addDisposableListener(close, EventType.CLICK, () => {
			this.items.get(issue.key)?.classList.remove('selected');
			this.selectedKey = undefined;
			this.renderDetail(view);
		}));

		append(host, $('h3.picode-issues-detail-title')).textContent = issue.title;
		const chips = append(host, $('.picode-issues-detail-chips'));
		this.statusChip(chips, issue);
		if (issue.external) {
			append(chips, $('span.picode-issue-tag.outside')).textContent = localize('picodeIssueOutside', "Outside report");
		}

		const facts = append(host, $('dl.picode-issues-facts'));
		const fact = (label: string, value: string): void => {
			if (value) {
				append(facts, $('dt')).textContent = label;
				append(facts, $('dd')).textContent = value;
			}
		};
		fact(localize('picodeIssuesViewType', "Type"), issue.type);
		fact(localize('picodeIssuesViewPriority', "Priority"), issue.priority);
		fact(localize('picodeIssuesViewAssignee', "Assignee"), issue.assignee || localize('picodeIssuesViewUnassigned', "Unassigned"));
		fact(issue.source === 'github' ? localize('picodeIssuesViewAuthor', "Author") : localize('picodeIssuesViewReporter', "Reporter"), issue.author);
		fact(localize('picodeIssuesViewCreated', "Created"), ageOf(issue.createdAt));
		fact(localize('picodeIssuesViewUpdated', "Updated"), ageOf(issue.updatedAt));
		if (issue.labels.length > 0) {
			append(facts, $('dt')).textContent = localize('picodeIssuesViewLabels', "Labels");
			const tags = append(append(facts, $('dd')), $('.picode-issue-card-tags'));
			for (const label of issue.labels) {
				append(tags, $('span.picode-issue-tag')).textContent = label;
			}
		}

		const description = append(host, $('.picode-issues-description'));
		if (issue.body) {
			description.textContent = issue.body;
		} else {
			description.classList.add('empty');
			description.textContent = localize('picodeIssuesViewNoDescription', "No description.");
		}

		const footer = append(host, $('.picode-issues-detail-actions'));
		const fix = append(footer, $('button.picode-issues-primary', { type: 'button' })) as HTMLButtonElement;
		append(fix, $(`span${ThemeIcon.asCSSSelector(Codicon.sparkle)}`));
		append(fix, $('span')).textContent = localize('picodeIssueFix', "Fix with pi");
		this.detailStore.add(addDisposableListener(fix, EventType.CLICK, () => void this.actions.fix(issue)));
		const blocked = this.actions.fixBlockedReason(issue, this.workspaceRepo);
		if (blocked) {
			fix.disabled = true;
			fix.title = blocked;
		}
		const browser = append(footer, $('button.picode-overview-action', { type: 'button' })) as HTMLButtonElement;
		browser.textContent = localize('picodeIssuesViewOpenInBrowser', "Open in browser");
		this.detailStore.add(addDisposableListener(browser, EventType.CLICK, () => void this.openerService.open(URI.parse(issue.url), { openExternal: true })));
	}
}

function ageOf(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? '' : fromNow(time, true);
}

function typeIcon(type: string): ThemeIcon {
	switch (type.toLowerCase()) {
		case 'bug': return Codicon.bug;
		case 'task':
		case 'subtask':
		case 'sub-task': return Codicon.checklist;
		case 'story': return Codicon.bookmark;
		case 'epic': return Codicon.zap;
		default: return Codicon.issues;
	}
}

function priorityLevel(priority: string): 'high' | 'medium' | 'low' {
	const name = priority.toLowerCase();
	if (name === 'highest' || name === 'high' || name === 'critical' || name === 'blocker') {
		return 'high';
	}
	return name === 'low' || name === 'lowest' || name === 'minor' || name === 'trivial' ? 'low' : 'medium';
}
