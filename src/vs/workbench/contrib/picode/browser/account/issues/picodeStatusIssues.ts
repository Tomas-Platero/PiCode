/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './picodeIssues.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IPicodeProEntitlement } from '../picodeProEntitlement.js';
import { PicodeConnectorService } from './picodeConnectorAuth.js';
import { IPicodeConnectorService, IPicodeIssuesResult } from './picodeConnectorService.js';
import { PicodeIssueActions, stateMessage } from './picodeIssueActions.js';
import { IPicodeIssue, PicodeIssueSource } from './picodeIssueSources.js';

/** Opens the Account window, where the connections are made (`picode.account.open`). */
const OPEN_ACCOUNT_COMMAND = 'picode.account.open';

/** Issues shown before "Show N more": the column is narrow and is a first look, not a tracker. */
const VISIBLE_ISSUES = 5;
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
		append(section, $('.picode-overview-title')).textContent = text.title;
		if (!this.connectors.isConnected(text.service)) {
			const row = this.row(section, Codicon.plug, localize('picodeConnectorNotConnected', "Not connected"));
			this.button(row, localize('picodeConnectorConnect', "Connect"), () => void this.commandService.executeCommand(OPEN_ACCOUNT_COMMAND));
			return;
		}
		const loading = this.row(section, Codicon.loading, localize('picodeIssuesLoading', "Loading issues…"));
		void this.connectors.listIssues(text.source).then(async result => {
			if (generation !== this.generation) {
				return;
			}
			const here = text.source === 'github' ? await this.connectors.workspaceRepoKey() : undefined;
			if (generation === this.generation) {
				loading.remove();
				this.renderResult(section, text, result, here);
			}
		});
	}

	private renderResult(section: HTMLElement, text: ISourceText, result: IPicodeIssuesResult, workspaceRepo: string | undefined): void {
		const note = stateMessage(result, text.name);
		if (note) {
			this.row(section, Codicon.warning, note);
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

	private renderIssue(section: HTMLElement, issue: IPicodeIssue, workspaceRepo: string | undefined): void {
		const row = this.row(section, Codicon.issues, issue.title || issue.key, issue.external ? localize('picodeIssueOutside', "Outside report") : issue.key);
		row.title = issue.key;
		this.clickable(row, () => void this.openerService.open(URI.parse(issue.url), { openExternal: true }));
		const blocked = this.actions.fixBlockedReason(issue, workspaceRepo);
		const fix = this.button(row, localize('picodeIssueFix', "Fix with pi"), () => void this.actions.fix(issue));
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
