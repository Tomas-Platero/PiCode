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
	buildColumns, filterIssues, initialsOf, IPicodeBoardIssue, IPicodeBoardStatus, IPicodeGithubPatch, IPicodeJiraPatch, IPicodeNamed, IPicodeProjectView, normalizeLabels, peopleOf, PicodeBoardLayout, priorityLevelOf,
} from './picodeIssueBoard.js';
import { IPicodeConnectorService, IPicodeGithubEditOptions, IPicodeJiraEditOptions, IPicodeProjectViewResult } from './picodeConnectorService.js';
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
	private dialogHost: HTMLElement | undefined;
	private noticeHost: HTMLElement | undefined;
	private readonly headerStore = this._register(new DisposableStore());
	private readonly bodyStore = this._register(new DisposableStore());
	private readonly dialogStore = this._register(new DisposableStore());

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
	/** Changes made by hand (a card moved, a field edited) and not yet confirmed by a fresh read: the views show them already. */
	private readonly moved = new Map<string, Partial<IPicodeBoardIssue>>();
	/** What a type and a priority can be changed to, read when the first issue is opened. */
	private editOptions: IPicodeJiraEditOptions | undefined;
	private editOptionsPending = false;
	private githubOptions: IPicodeGithubEditOptions | undefined;
	private githubOptionsPending = false;
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
		this.dialogHost = append(this.root, $('.picode-issues-overlay'));
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
		this.editOptions = undefined;
		this.editOptionsPending = false;
		this.githubOptions = undefined;
		this.githubOptionsPending = false;
		await this.load();
	}

	/** The tab was already open: the click only opens another issue in it. */
	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		const key = (options as IPicodeIssuesEditorOptions | undefined)?.selectKey;
		if (key) {
			this.items.get(this.selectedKey ?? '')?.classList.remove('selected');
			this.selectedKey = key;
			this.items.get(key)?.classList.add('selected');
			this.renderDialog();
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
		if (!quiet) {
			this.renderDialog();
		}
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
		clearNode(host);
		this.items.clear();
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
					this.avatar(foot, issue);
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
			const person = append(row, $('span.picode-issue-assignee-cell'));
			if (issue.assignee) {
				this.avatar(person, issue);
				append(person, $('span')).textContent = issue.assignee;
			}
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
		this.askToAllowWriting(
			localize('picodeIssuesViewNeedsWrite', "To move issues, PiCode needs permission to change them in Jira."),
			(text, label, run) => this.showBanner(text, label, run),
			() => { this.clearBanner(); void this.moveCard(key, status); });
	}

	/** Shows `message` with an *Allow* button that asks Atlassian, and runs `retry` once the account allowed it. */
	private askToAllowWriting(message: string, show: (text: string, label?: string, run?: () => void) => void, retry: () => void): void {
		show(message, localize('picodeIssuesViewAllow', "Allow"), () => {
			const source = new CancellationTokenSource();
			show(localize('picodeIssuesWaiting', "Waiting for {0}…", 'Jira'));
			void this.connectors.connectAtlassian(source.token, { write: true }).then(outcome => {
				source.dispose();
				if (outcome === 'connected') {
					retry();
					return;
				}
				show(outcomeMessage(outcome, 'Jira') ?? localize('picodeIssuesViewMoveFailed', "The issue could not be moved. Try again."));
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
		this.renderDialog();
	}

	private priorityMark(parent: HTMLElement, priority: string, withName = false): void {
		if (!priority) {
			return;
		}
		const level = priorityLevelOf(priority);
		const mark = append(parent, $(`span.picode-issue-priority.${level}`));
		append(mark, $(`span${ThemeIcon.asCSSSelector(level === 'highest' || level === 'high' ? Codicon.arrowUp : level === 'low' || level === 'lowest' ? Codicon.arrowDown : Codicon.remove)}`));
		if (withName) {
			append(mark, $('span')).textContent = priorityLabel(priority);
		} else {
			mark.title = priorityLabel(priority);
		}
	}

	/** The person's picture, or their initials when the service has none (or it cannot be loaded). */
	private avatar(parent: HTMLElement, issue: IPicodeBoardIssue): void {
		const avatar = append(parent, $('span.picode-issue-avatar'));
		avatar.title = issue.assignee;
		const initials = (): void => {
			clearNode(avatar);
			avatar.textContent = initialsOf(issue.assignee);
		};
		if (!issue.assigneeAvatar) {
			initials();
			return;
		}
		const picture = append(avatar, $('img.picode-issue-avatar-picture', { src: issue.assigneeAvatar, alt: '' })) as HTMLImageElement;
		this.bodyStore.add(addDisposableListener(picture, 'error', initials));
	}

	private statusChip(parent: HTMLElement, issue: IPicodeBoardIssue): void {
		const label = issue.source === 'github' ? (issue.status === 'closed' ? CLOSED_LABEL() : OPEN_LABEL()) : issue.status;
		append(parent, $(`span.picode-issue-status.${issue.category}`)).textContent = label;
	}

	// -- The issue in its own window ---------------------------------------------------------------

	/** The clicked issue opens in a window over the viewer, where its fields can be changed. */
	private renderDialog(): void {
		const host = this.dialogHost;
		if (!host) {
			return;
		}
		this.dialogStore.clear();
		clearNode(host);
		this.noticeHost = undefined;
		const view = this.result?.view;
		const issue = view && this.selectedKey ? this.issuesOf(view).find(candidate => candidate.key === this.selectedKey) : undefined;
		host.classList.toggle('open', !!issue);
		if (!view || !issue) {
			return;
		}
		const jira = issue.source === 'jira';
		this.dialogStore.add(addDisposableListener(host, EventType.MOUSE_DOWN, e => {
			if (e.target === host) {
				this.closeDialog();
			}
		}));
		this.dialogStore.add(addDisposableListener(host, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.closeDialog();
			}
		}));
		const dialog = append(host, $('.picode-issues-dialog', { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }));

		const head = append(dialog, $('.picode-issues-dialog-head'));
		append(head, $(`span${ThemeIcon.asCSSSelector(typeIcon(issue.type))}`));
		const key = append(head, $('a.picode-issue-key', { href: '#' }));
		key.textContent = issue.key;
		this.dialogStore.add(addDisposableListener(key, EventType.CLICK, e => { e.preventDefault(); this.openIssuePage(issue); }));
		append(head, $('.picode-issues-spacer'));
		this.iconButton(head, Codicon.linkExternal, localize('picodeIssuesViewOpenInBrowser', "Open in browser"), () => this.openIssuePage(issue));
		this.iconButton(head, Codicon.close, localize('picodeIssuesViewClose', "Close"), () => this.closeDialog());

		this.noticeHost = append(dialog, $('.picode-issues-dialog-notice'));
		const body = append(dialog, $('.picode-issues-dialog-body'));
		const main = append(body, $('.picode-issues-dialog-main'));
		const side = append(body, $('.picode-issues-dialog-side'));

		// The summary is the title.
		const summary = append(main, $('input.picode-issues-summary', { type: 'text', 'aria-label': localize('picodeIssuesViewSummary', "Summary") })) as HTMLInputElement;
		summary.value = issue.title;
		this.dialogStore.add(addDisposableListener(summary, EventType.BLUR, () => {
			const value = summary.value.trim();
			const latest = this.currentIssue(issue.key) ?? issue;
			if (value && value !== latest.title) {
				void this.save(latest, { jira: { summary: value }, github: { title: value } }, { title: value });
			} else {
				summary.value = latest.title;
			}
		}));
		this.dialogStore.add(addDisposableListener(summary, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				summary.blur();
			}
		}));

		append(main, $('h4.picode-issues-section')).textContent = localize('picodeIssuesViewDescription', "Description");
		if (issue.descriptionEditable) {
			const description = append(main, $('textarea.picode-issues-description-edit', { rows: '9', placeholder: localize('picodeIssuesViewAddDescription', "Add a description") })) as HTMLTextAreaElement;
			description.value = issue.description;
			this.dialogStore.add(addDisposableListener(description, EventType.BLUR, () => {
				const latest = this.currentIssue(issue.key) ?? issue;
				if (description.value !== latest.description) {
					void this.save(latest, { jira: { description: description.value }, github: { body: description.value } }, { description: description.value, body: description.value });
				}
			}));
		} else {
			const description = append(main, $('.picode-issues-description'));
			description.textContent = issue.body;
		}
		const actions = append(main, $('.picode-issues-detail-actions'));
		const fix = append(actions, $('button.picode-issues-primary', { type: 'button' })) as HTMLButtonElement;
		append(fix, $(`span${ThemeIcon.asCSSSelector(Codicon.sparkle)}`));
		append(fix, $('span')).textContent = localize('picodeIssueFix', "Fix with pi");
		this.dialogStore.add(addDisposableListener(fix, EventType.CLICK, () => void this.actions.fix(this.currentIssue(issue.key) ?? issue)));
		const blocked = this.actions.fixBlockedReason(issue, this.workspaceRepo);
		if (blocked) {
			fix.disabled = true;
			fix.title = blocked;
		}

		append(side, $('h4.picode-issues-section')).textContent = localize('picodeIssuesViewDetails', "Details");
		const chips = append(side, $('.picode-issues-detail-chips'));
		this.statusChip(chips, issue);
		if (issue.external) {
			append(chips, $('span.picode-issue-tag.outside')).textContent = localize('picodeIssueOutside', "Outside report");
		}
		const facts = append(side, $('dl.picode-issues-facts'));
		const row = (label: string): HTMLElement => {
			append(facts, $('dt')).textContent = label;
			return append(facts, $('dd'));
		};
		this.loadEditOptions(issue);
		const unassigned = { id: '', name: localize('picodeIssuesViewUnassigned', "Unassigned") };
		if (jira) {
			const people = peopleOf(this.issuesOf(view));
			this.selectField(row(localize('picodeIssuesViewType', "Type")), issue.type, issue.typeId, this.editOptions?.types ?? [],
				choice => void this.save(issue, { jira: { typeId: choice.id } }, { typeId: choice.id, type: choice.name }));
			this.selectField(row(localize('picodeIssuesViewPriority', "Priority")), issue.priority, issue.priorityId, this.editOptions?.priorities ?? [],
				choice => void this.save(issue, { jira: { priorityId: choice.id } }, { priorityId: choice.id, priority: choice.name }), priorityLabel);
			this.personField(row(localize('picodeIssuesViewAssignee', "Assignee")), issue, 'assignee', issue.assigneeId, issue.assignee || unassigned.name, people, unassigned,
				person => void this.save(issue, { jira: { assigneeId: person.id || null } }, { assigneeId: person.id, assignee: person.id ? person.name : '' }));
			this.personField(row(localize('picodeIssuesViewReporter', "Reporter")), issue, 'reporter', issue.reporterId, issue.author, people, undefined,
				person => void this.save(issue, { jira: { reporterId: person.id } }, { reporterId: person.id, author: person.name }));
			this.labelsField(row(localize('picodeIssuesViewLabels', "Labels")), issue, []);
		} else {
			const assignees = this.githubOptions?.assignees ?? [];
			this.personField(row(localize('picodeIssuesViewAssignee', "Assignee")), issue, 'assignee', issue.assignee, issue.assignee || unassigned.name, assignees, unassigned,
				person => void this.save(issue, { github: { assignees: person.id ? [person.id] : [] } }, { assigneeId: person.id, assignee: person.id ? person.name : '' }));
			if (issue.author) {
				row(localize('picodeIssuesViewAuthor', "Author")).textContent = issue.author;
			}
			this.labelsField(row(localize('picodeIssuesViewLabels', "Labels")), issue, this.githubOptions?.labels ?? []);
		}
		row(localize('picodeIssuesViewCreated', "Created")).textContent = ageOf(issue.createdAt);
		row(localize('picodeIssuesViewUpdated', "Updated")).textContent = ageOf(issue.updatedAt);
		dialog.focus();
	}

	private currentIssue(key: string): IPicodeBoardIssue | undefined {
		const view = this.result?.view;
		return view ? this.issuesOf(view).find(candidate => candidate.key === key) : undefined;
	}

	private openIssuePage(issue: IPicodeBoardIssue): void {
		void this.openerService.open(URI.parse(issue.url), { openExternal: true });
	}

	private closeDialog(): void {
		this.items.get(this.selectedKey ?? '')?.classList.remove('selected');
		this.selectedKey = undefined;
		this.renderDialog();
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): void {
		const button = append(parent, $('button.picode-issue-fix', { type: 'button', 'aria-label': label, title: label })) as HTMLButtonElement;
		append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		this.dialogStore.add(addDisposableListener(button, EventType.CLICK, run));
	}

	/** What a type, a priority, a label or a person can be changed to is read once, when the first issue is opened. */
	private loadEditOptions(issue: IPicodeBoardIssue): void {
		if (issue.source === 'jira') {
			if (this.editOptions || this.editOptionsPending) {
				return;
			}
			this.editOptionsPending = true;
			void this.connectors.loadJiraEditOptions(issue.key).then(options => {
				this.editOptionsPending = false;
				this.editOptions = options;
				if (this.selectedKey) {
					this.renderDialog();
				}
			});
		} else {
			if (this.githubOptions || this.githubOptionsPending) {
				return;
			}
			this.githubOptionsPending = true;
			void this.connectors.loadGithubEditOptions(issue.project).then(options => {
				this.githubOptionsPending = false;
				this.githubOptions = options;
				if (this.selectedKey) {
					this.renderDialog();
				}
			});
		}
	}

	/** A drop-down: the current value always shows, even before the list of choices arrives. */
	private selectField(cell: HTMLElement, currentName: string, currentId: string, choices: readonly IPicodeNamed[], onChange: (choice: IPicodeNamed) => void, labelOf: (name: string) => string = name => name): void {
		const select = append(cell, $('select.picode-issues-select')) as HTMLSelectElement;
		const all = !currentName || choices.some(choice => choice.id === currentId) ? choices : [{ id: currentId, name: currentName }, ...choices];
		for (const choice of all) {
			const option = append(select, $('option')) as HTMLOptionElement;
			option.value = choice.id;
			option.textContent = labelOf(choice.name);
		}
		select.value = currentId;
		select.disabled = choices.length === 0;
		this.dialogStore.add(addDisposableListener(select, EventType.CHANGE, () => {
			const choice = all.find(candidate => candidate.id === select.value);
			if (choice) {
				onChange(choice);
			}
		}));
	}

	/**
	 * A person: a button with the current name that opens a list with a search box. The people the
	 * project already has come first; in Jira, typing also looks anyone up (that needs a permission
	 * the account is asked for the first time).
	 */
	private personField(cell: HTMLElement, issue: IPicodeBoardIssue, mode: 'assignee' | 'reporter', currentId: string, currentName: string,
		known: readonly IPicodeNamed[], nobody: IPicodeNamed | undefined, onChoose: (person: IPicodeNamed) => void): void {
		cell.classList.add('picode-issues-person');
		const button = append(cell, $('button.picode-issues-select.picode-issues-person-button', { type: 'button' })) as HTMLButtonElement;
		button.textContent = currentName;
		const popup = append(cell, $('.picode-issues-people'));
		const search = append(popup, $('input.picode-issues-people-search', { type: 'text', placeholder: localize('picodeIssuesViewSearchPeople', "Search people") })) as HTMLInputElement;
		const results = append(popup, $('ul.picode-issues-people-list'));
		const note = append(popup, $('.picode-issues-people-note'));
		let generation = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const close = (): void => popup.classList.remove('open');
		const show = (people: readonly IPicodeNamed[]): void => {
			clearNode(results);
			const text = search.value.trim().toLowerCase();
			for (const person of [...(nobody && !text ? [nobody] : []), ...people]) {
				const item = append(results, $('li.picode-issues-people-item'));
				item.textContent = person.name;
				item.classList.toggle('current', person.id === currentId);
				this.dialogStore.add(addDisposableListener(item, EventType.CLICK, () => {
					close();
					if (person.id !== currentId) {
						onChoose(person);
					}
				}));
			}
			if (results.childElementCount === 0) {
				append(results, $('li.picode-issues-people-empty')).textContent = localize('picodeIssuesViewNoPeople', "No one found.");
			}
		};
		const refresh = async (): Promise<void> => {
			const text = search.value.trim();
			const mine = ++generation;
			clearNode(note);
			show(text ? known.filter(person => person.name.toLowerCase().includes(text.toLowerCase())) : known);
			if (!text || issue.source !== 'jira') {
				return;
			}
			const found = await this.connectors.searchJiraUsers(issue.key, text, mode);
			if (mine !== generation) {
				return;
			}
			if (found === 'needsPermission') {
				this.askToAllowWriting(localize('picodeIssuesViewNeedsUsers', "To find other people, PiCode needs permission to read users in Jira."),
					(message, label, run) => {
						clearNode(note);
						append(note, $('span')).textContent = message;
						if (label && run) {
							const allow = append(note, $('button.picode-overview-action', { type: 'button' })) as HTMLButtonElement;
							allow.textContent = label;
							allow.addEventListener('click', run, { once: true });
						}
					},
					() => void refresh());
			} else {
				show(found);
			}
		};
		this.dialogStore.add(addDisposableListener(button, EventType.CLICK, () => {
			const opening = !popup.classList.contains('open');
			popup.classList.toggle('open', opening);
			if (opening) {
				search.value = '';
				void refresh();
				search.focus();
			}
		}));
		this.dialogStore.add(addDisposableListener(search, EventType.INPUT, () => {
			clearTimeout(timer);
			timer = setTimeout(() => void refresh(), 250);
		}));
		this.dialogStore.add(addDisposableListener(search, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				close();
				button.focus();
			}
		}));
		// A click anywhere else in the window closes the list.
		if (this.dialogHost) {
			this.dialogStore.add(addDisposableListener(this.dialogHost, EventType.MOUSE_DOWN, e => {
				if (e.target instanceof Node && !cell.contains(e.target)) {
					close();
				}
			}));
		}
		this.dialogStore.add({ dispose: () => clearTimeout(timer) });
	}

	private labelsField(cell: HTMLElement, issue: IPicodeBoardIssue, suggestions: readonly string[]): void {
		const box = append(cell, $('.picode-issues-labels'));
		const apply = (labels: readonly string[]): void => {
			void this.save(issue, { jira: { labels }, github: { labels } }, { labels });
			this.renderDialog();
			(this.dialogHost?.querySelector('.picode-issues-label-input') as HTMLInputElement | null)?.focus();
		};
		for (const label of issue.labels) {
			const chip = append(box, $('span.picode-issue-tag.removable'));
			append(chip, $('span')).textContent = label;
			const text = localize('picodeIssuesViewRemoveLabel', "Remove {0}", label);
			const remove = append(chip, $('button', { type: 'button', 'aria-label': text, title: text })) as HTMLButtonElement;
			append(remove, $(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
			this.dialogStore.add(addDisposableListener(remove, EventType.CLICK, () => apply(issue.labels.filter(existing => existing !== label))));
		}
		const input = append(box, $('input.picode-issues-label-input', { type: 'text', placeholder: localize('picodeIssuesViewAddLabel', "Add a label") })) as HTMLInputElement;
		if (suggestions.length > 0) {
			const list = append(box, $('datalist', { id: 'picode-issues-label-suggestions' }));
			for (const suggestion of suggestions) {
				append(list, $('option')).setAttribute('value', suggestion);
			}
			input.setAttribute('list', 'picode-issues-label-suggestions');
		}
		this.dialogStore.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
			if (e.key !== 'Enter') {
				return;
			}
			// Jira labels cannot hold spaces; GitHub's can.
			const [added] = issue.source === 'jira' ? normalizeLabels([input.value]) : [input.value.trim()];
			if (added && !issue.labels.includes(added)) {
				apply([...issue.labels, added]);
			}
			input.value = '';
		}));
	}

	/**
	 * Saves a change. The board and the window show it at once; if the service says no, it goes back
	 * and the reason is shown in the window. \`edit\` holds the change in each service's own terms.
	 */
	private async save(issue: IPicodeBoardIssue, edit: { readonly jira?: IPicodeJiraPatch; readonly github?: IPicodeGithubPatch }, local: Partial<IPicodeBoardIssue>): Promise<void> {
		this.dialogNotice();
		const jira = issue.source === 'jira';
		const before = this.moved.get(issue.key);
		this.moved.set(issue.key, { ...before, ...local });
		this.renderBody();
		const revert = (): void => {
			if (before) {
				this.moved.set(issue.key, before);
			} else {
				this.moved.delete(issue.key);
			}
			this.renderBody();
			this.renderDialog();
		};
		const askToAllow = (): void => {
			if (jira) {
				this.askToAllowWriting(
					localize('picodeIssuesViewNeedsEdit', "To edit issues, PiCode needs permission to change them in Jira."),
					(text, label, run) => this.dialogNotice(text, label, run),
					() => { this.dialogNotice(); void this.save(issue, edit, local); });
			} else {
				// GitHub's permissions belong to the App: whoever installed it has to accept the change on GitHub.
				this.dialogNotice(
					localize('picodeIssuesViewGithubNeedsEdit', "GitHub has not allowed PiCode to edit issues in this repository yet."),
					localize('picodeIssuesViewGithubReview', "Review permissions"),
					() => void this.openerService.open(URI.parse('https://github.com/settings/installations'), { openExternal: true }));
			}
		};
		if (jira && !(await this.connectors.canMoveJiraIssues())) {
			revert();
			askToAllow();
			return;
		}
		const outcome = jira
			? await this.connectors.updateJiraIssue(issue.key, edit.jira ?? {})
			: await this.connectors.updateGithubIssue(issue.key, edit.github ?? {});
		if (outcome === 'saved') {
			void this.load(true);
			return;
		}
		revert();
		if (outcome === 'needsPermission') {
			askToAllow();
		} else {
			this.dialogNotice(outcome === 'rejected'
				? (jira ? localize('picodeIssuesViewEditRejected', "Jira did not accept this change.") : localize('picodeIssuesViewEditRejectedGithub', "GitHub did not accept this change."))
				: localize('picodeIssuesViewSaveFailed', "The change could not be saved. Try again."));
		}
	}

	private dialogNotice(text?: string, label?: string, run?: () => void): void {
		const host = this.noticeHost;
		if (!host) {
			return;
		}
		clearNode(host);
		host.classList.toggle('shown', !!text);
		if (!text) {
			return;
		}
		append(host, $('span')).textContent = text;
		if (label && run) {
			const button = append(host, $('button.picode-overview-action', { type: 'button' })) as HTMLButtonElement;
			button.textContent = label;
			button.addEventListener('click', run, { once: true });
		}
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

/** The standard priorities of Jira, in the person's language; a name the space made up stays as it is. */
function priorityLabel(name: string): string {
	switch (name.trim().toLowerCase()) {
		case 'highest': return localize('picodeIssuesPriorityHighest', "Highest");
		case 'high': return localize('picodeIssuesPriorityHigh', "High");
		case 'medium': return localize('picodeIssuesPriorityMedium', "Medium");
		case 'low': return localize('picodeIssuesPriorityLow', "Low");
		case 'lowest': return localize('picodeIssuesPriorityLowest', "Lowest");
		case 'critical': return localize('picodeIssuesPriorityCritical', "Critical");
		case 'blocker': return localize('picodeIssuesPriorityBlocker', "Blocker");
		case 'major': return localize('picodeIssuesPriorityMajor', "Major");
		case 'minor': return localize('picodeIssuesPriorityMinor', "Minor");
		case 'trivial': return localize('picodeIssuesPriorityTrivial', "Trivial");
		default: return name;
	}
}
