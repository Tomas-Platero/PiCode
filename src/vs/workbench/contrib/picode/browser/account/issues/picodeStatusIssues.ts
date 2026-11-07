/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './picodeIssues.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IPicodeProEntitlement } from '../picodeProEntitlement.js';
import { PicodeConnectorService } from './picodeConnectorAuth.js';
import { IPicodeConnectorService, IPicodeIssuesResult, IPicodeIssuesScope } from './picodeConnectorService.js';
import { PicodeIssueActions, stateMessage } from './picodeIssueActions.js';
import { projectRefOf } from './picodeIssueBoard.js';
import { IPicodeIssue, PicodeIssueSource, splitTitleTag } from './picodeIssueSources.js';
import { PICODE_OPEN_ISSUES_COMMAND } from './picodeIssues.contribution.js';

/** Opens the Account window, where the connections are made (`picode.account.open`). */
const OPEN_ACCOUNT_COMMAND = 'picode.account.open';
/** The last choice of the Jira space list: not a space, but the way to Jira to create one. */
const CREATE_SPACE = '\u0000create';

/** Issues shown before "Show N more": the column is narrow and is a first look, not a tracker. */
const VISIBLE_ISSUES = 5;
/** What each folder was narrowed to: GitHub `repo` or `all`; the Jira space's key, or empty for every space. */
const GITHUB_SCOPE_KEY = 'picode.issues.githubScope';
const JIRA_PROJECT_KEY = 'picode.issues.jiraProject';
/** How often a connected list is read again while the column is open. */
const REFRESH_MS = 5 * 60_000;

interface ISourceText {
	readonly source: PicodeIssueSource;
	readonly service: PicodeConnectorService;
	readonly title: string;
	readonly name: string;
}

const SOURCES: readonly ISourceText[] = [
	{ source: 'github', service: 'github', title: localize('picodeIssuesGithubTitle', "GitHub issues"), name: 'GitHub' },
	{ source: 'jira', service: 'atlassian', title: localize('picodeIssuesJiraTitle', "Jira issues"), name: 'Jira' },
];

/**
 * One panel per issue tracker in the Status column: the open issues with *Fix with pi*.
 * It lives in its own host element, which the column puts back after every repaint, so the
 * lists are not read again each time the column redraws.
 */
export class PicodeStatusIssues extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());
	private readonly actions: PicodeIssueActions;
	/** Bumped on every repaint, so an answer that arrives after the panel changed is thrown away. */
	private generation = 0;
	private readonly unfolded = new Set<PicodeIssueSource>();

	constructor(
		private readonly host: HTMLElement,
		@IPicodeProEntitlement private readonly entitlement: IPicodeProEntitlement,
		@IPicodeConnectorService private readonly connectors: IPicodeConnectorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		this.actions = instantiationService.createInstance(PicodeIssueActions);
		this.render();
		this._register(this.entitlement.onDidChange(() => this.render()));
		this._register(this.connectors.onDidChange(() => this.render()));
		const timer = setInterval(() => { if (this.host.isConnected) { this.render(); } }, REFRESH_MS);
		this._register({ dispose: () => clearInterval(timer) });
	}

	override dispose(): void {
		this.generation++;
		super.dispose();
	}

	private render(): void {
		const generation = ++this.generation;
		this.renderStore.clear();
		clearNode(this.host);
		// Locked or not shipped yet: the Account window says so; the column stays quiet.
		if (!this.entitlement.isPro) {
			return;
		}
		for (const text of SOURCES) {
			if (this.connectors.isAvailable(text.service)) {
				this.renderSource(text, generation);
			}
		}
	}

	private renderSource(text: ISourceText, generation: number): void {
		const section = append(this.host, $('.picode-overview-section'));
		const head = append(section, $('.picode-issues-title-row'));
		const heading = append(head, $('.picode-overview-title'));
		heading.textContent = text.title;
		if (!this.connectors.isConnected(text.service)) {
			const row = this.row(section, Codicon.plug, localize('picodeConnectorNotConnected', "Not connected"));
			this.button(row, localize('picodeConnectorConnect', "Connect"), () => void this.commandService.executeCommand(OPEN_ACCOUNT_COMMAND));
			return;
		}
		const loading = this.row(section, Codicon.loading, localize('picodeIssuesLoading', "Loading issues…"));
		void (async () => {
			// The folder open decides what the list is narrowed to (see `scopeOf`).
			const here = text.source === 'github' ? await this.connectors.workspaceRepoKey() : undefined;
			const result = await this.connectors.listIssues(text.source, this.scopeOf(text.source, here));
			if (generation !== this.generation) {
				return;
			}
			loading.remove();
			this.renderScopeButton(head, text, here);
			this.renderResult(section, heading, text, result, here);
			if (text.source === 'jira' && this.jiraChoice() === undefined) {
				void this.suggestJiraProject(result, generation);
			}
		})();
	}

	// -- Which project the list is about ---------------------------------------------------------------

	private jiraChoice(): string | undefined {
		return this.storageService.get(JIRA_PROJECT_KEY, StorageScope.WORKSPACE);
	}

	/** GitHub: this folder's repository, unless the person asked for all. Jira: the space linked to this folder, if any. */
	private scopeOf(source: PicodeIssueSource, here: string | undefined): IPicodeIssuesScope {
		if (source === 'github') {
			return here && this.storageService.get(GITHUB_SCOPE_KEY, StorageScope.WORKSPACE) !== 'all' ? { repo: here } : {};
		}
		const project = this.jiraChoice();
		return project ? { project } : {};
	}

	private renderScopeButton(head: HTMLElement, text: ISourceText, here: string | undefined): void {
		if (text.source === 'github') {
			if (!here) {
				return; // The folder is not a GitHub repository: nothing to narrow to.
			}
			const all = this.storageService.get(GITHUB_SCOPE_KEY, StorageScope.WORKSPACE) === 'all';
			const button = this.scopeButton(head, all ? localize('picodeIssuesScopeAllRepos', "All repositories") : localize('picodeIssuesScopeRepo', "This repository"));
			this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => {
				this.storageService.store(GITHUB_SCOPE_KEY, all ? 'repo' : 'all', StorageScope.WORKSPACE, StorageTarget.MACHINE);
				this.render();
			}));
		} else {
			const button = this.scopeButton(head, this.jiraChoice() || localize('picodeIssuesScopeAllProjects', "All projects"));
			this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => void this.pickJiraProject()));
		}
	}

	private scopeButton(head: HTMLElement, label: string): HTMLButtonElement {
		const button = append(head, $('button.picode-overview-action.picode-issues-scope', { type: 'button' })) as HTMLButtonElement;
		append(button, $('span')).textContent = label;
		append(button, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		return button;
	}

	/** Links this folder to one of the Jira spaces (or to all of them), or sends the person to Jira to create one. */
	private async pickJiraProject(): Promise<void> {
		const projects = await this.connectors.listJiraProjects();
		const items: (IQuickPickItem | IQuickPickSeparator)[] = [
			{ id: '', label: localize('picodeIssuesScopeAllProjects', "All projects") },
			...projects.map(project => ({ id: project.id, label: project.id, description: project.name })),
			{ type: 'separator' },
			{ id: CREATE_SPACE, label: `$(add) ${localize('picodeIssuesScopeCreate', "Create a space in Jira…")}` },
		];
		const pick = await this.quickInputService.pick(items, { placeHolder: localize('picodeIssuesScopePick', "Show the issues of…") });
		if (!pick || pick.id === undefined) {
			return;
		}
		if (pick.id === CREATE_SPACE) {
			const url = await this.connectors.jiraProjectsUrl();
			if (url) {
				void this.openerService.open(URI.parse(url), { openExternal: true });
			}
			return;
		}
		this.storageService.store(JIRA_PROJECT_KEY, pick.id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.render();
	}

	/** A folder not linked yet whose branch names a space that exists (`ATW-52-…`) is linked to it, once. */
	private async suggestJiraProject(result: IPicodeIssuesResult, generation: number): Promise<void> {
		const hint = await this.connectors.workspaceJiraKeyHint();
		if (hint && generation === this.generation && this.jiraChoice() === undefined && result.issues.some(issue => issue.project === hint)) {
			this.storageService.store(JIRA_PROJECT_KEY, hint, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this.render();
		}
	}

	private renderResult(section: HTMLElement, heading: HTMLElement, text: ISourceText, result: IPicodeIssuesResult, workspaceRepo: string | undefined): void {
		const note = stateMessage(result, text.name);
		if (note) {
			const row = this.row(section, Codicon.warning, note);
			const install = result.state === 'notInstalled' || result.state === 'notVisible' ? this.connectors.githubInstallUrl() : undefined;
			if (install) {
				this.button(row, localize('picodeIssuesInstall', "Install on GitHub"), () => void this.openerService.open(URI.parse(install), { openExternal: true }));
			}
		}
		if (result.state === 'reconnect') {
			const row = this.row(section, Codicon.plug, localize('picodeConnectorNotConnected', "Not connected"));
			this.button(row, localize('picodeConnectorConnect', "Connect"), () => void this.commandService.executeCommand(OPEN_ACCOUNT_COMMAND));
			return;
		}
		if (result.issues.length === 0) {
			if (result.state === 'ok') {
				this.row(section, Codicon.check, localize('picodeIssuesNone', "No open issues. 🎉"));
			}
			return;
		}
		append(heading, $('span.picode-overview-detail')).textContent = ` · ${result.issues.length}`;
		const unfolded = this.unfolded.has(text.source);
		const shown = unfolded ? result.issues : result.issues.slice(0, VISIBLE_ISSUES);
		for (const issue of shown) {
			this.renderIssue(section, issue, workspaceRepo);
		}
		const hidden = result.issues.length - shown.length;
		if (hidden > 0) {
			const more = this.row(section, Codicon.ellipsis, localize('picodeIssuesShowMore', "Show {0} more", hidden));
			this.clickable(more, () => { this.unfolded.add(text.source); this.render(); });
		}
		const refresh = this.row(section, Codicon.sync, localize('picodeIssuesRefresh', "Refresh"));
		this.clickable(refresh, () => this.render());
	}

	/**
	 * Two lines, so the title gets the whole width: what the issue says (up to two lines), then a
	 * small line with its tag, key and age. *Fix with pi* is an icon, its words are the tooltip.
	 */
	private renderIssue(section: HTMLElement, issue: IPicodeIssue, workspaceRepo: string | undefined): void {
		const item = append(section, $('.picode-issue-item'));
		item.title = `${issue.title}
${issue.key}`;
		append(item, $(`span.picode-overview-icon${ThemeIcon.asCSSSelector(Codicon.issues)}`));
		const body = append(item, $('.picode-issue-body'));
		const { tag, text } = splitTitleTag(issue.title || issue.key);
		append(body, $('.picode-issue-title')).textContent = text;
		const meta = append(body, $('.picode-issue-meta'));
		if (issue.external) {
			append(meta, $('span.picode-issue-tag.outside')).textContent = localize('picodeIssueOutside', "Outside report");
		}
		if (tag) {
			append(meta, $('span.picode-issue-tag')).textContent = tag;
		}
		append(meta, $('span.picode-issue-key')).textContent = issue.key;
		const updated = Date.parse(issue.updatedAt);
		if (!Number.isNaN(updated)) {
			append(meta, $('span')).textContent = fromNow(updated, true);
		}
		// The click opens the whole project in the viewer with this issue selected; without a project it opens the issue's page.
		const project = projectRefOf(issue);
		this.clickable(item, () => void (project
			? this.commandService.executeCommand(PICODE_OPEN_ISSUES_COMMAND, issue.source, project, issue.key)
			: this.openerService.open(URI.parse(issue.url), { openExternal: true })));
		const fixLabel = localize('picodeIssueFix', "Fix with pi");
		const fix = append(item, $('button.picode-issue-fix', { type: 'button', 'aria-label': fixLabel })) as HTMLButtonElement;
		append(fix, $(`span${ThemeIcon.asCSSSelector(Codicon.sparkle)}`));
		fix.title = fixLabel;
		this.renderStore.add(addDisposableListener(fix, EventType.CLICK, () => void this.actions.fix(issue)));
		const blocked = this.actions.fixBlockedReason(issue, workspaceRepo);
		if (blocked) {
			fix.disabled = true;
			fix.title = blocked;
		}
	}

	private row(parent: HTMLElement, icon: ThemeIcon, label: string, detail?: string): HTMLElement {
		const row = append(parent, $('.picode-overview-row'));
		append(row, $(`span.picode-overview-icon${ThemeIcon.asCSSSelector(icon)}`));
		const textBox = append(row, $('span.picode-overview-label'));
		textBox.textContent = label;
		if (detail) {
			append(textBox, $('span.picode-overview-detail')).textContent = ` · ${detail}`;
		}
		return row;
	}

	private button(row: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const button = append(row, $('button.picode-overview-action', { type: 'button' })) as HTMLButtonElement;
		button.textContent = label;
		this.renderStore.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	/** A row that does something when clicked (its buttons keep their own clicks). */
	private clickable(row: HTMLElement, run: () => void): void {
		row.classList.add('clickable');
		this.renderStore.add(addDisposableListener(row, EventType.CLICK, e => {
			if (!(e.target instanceof HTMLElement && e.target.closest('button'))) {
				run();
			}
		}));
	}
}
