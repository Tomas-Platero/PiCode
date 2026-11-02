/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { PICODE_STATUS_CONTAINER_ID, sidebarSideColumn } from '../../../browser/parts/sidebar/sidebarSideColumn.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { ISCMService } from '../../scm/common/scm.js';
import { onDidChangePicodeAgentStatus, picodeAgentStatus } from './picodeAgentStatusPill.js';
import { createServiceLogo, displayNameOf } from './picodeServiceLogo.js';

/**
 * The Agent layout's status column, the first half of the review side bar once it is wide enough: where the agent works, how
 * full its context is, which MCPs it has, what changed and what is still running.
 *
 * Every row is read from what the editor already knows — the workspace, source control, the chat's
 * last answer, pi's own status (`picode.setup.status`) and the jobs the connector pushes — and
 * nothing is guessed: a fact that is not there is left out rather than shown as a zero.
 */
const STATUS_DATA_COMMAND = 'picode.setup.status';
const DIFF_STAT_COMMAND = 'picode.git.diffStat';

/** How often the panel re-reads what has no event of its own (context use, pi's connectors). */
const REFRESH_MS = 4000;

interface IConnector {
	readonly name: string;
	readonly on?: boolean;
	readonly signIn?: 'ok' | 'needed' | 'unknown';
}

/**
 * pi's MCPs as last read, shared by every status panel of this window: a panel that opens (the
 * column, or the tab after it) shows them at once instead of waiting for pi to answer again, and
 * until pi first answers the section is left out rather than shown as empty.
 */
let knownConnectors: readonly IConnector[] | undefined;

/** One row of the connector's task board (`picode.tasks.data`). */
interface ITaskRow {
	readonly title: string;
	readonly detail: string;
	readonly icon: string;
	readonly agentId?: string;
	readonly outputFile?: string;
	readonly tooltip?: string;
}

/** The connector's task board: what its Tasks block shows. */
interface ITaskBoard {
	readonly running: readonly ITaskRow[];
	readonly finished: readonly ITaskRow[];
}

/** What the connector's Memory block shows (`picode.memory.summary`). */
interface IMemorySummary {
	readonly state: 'loading' | 'unavailable' | 'ready';
	readonly retried?: boolean;
	readonly heading?: string;
	readonly detail?: string;
	readonly projects?: readonly { readonly name: string; readonly memories: number }[];
	readonly search?: { readonly query: string; readonly total: number; readonly rows: readonly { readonly id: number; readonly title: string; readonly project: string; readonly when: string; readonly icon: string }[] };
	readonly newerEngine?: string;
}

const TASKS_DATA_COMMAND = 'picode.tasks.data';
const TASKS_TRANSCRIPT_COMMAND = 'picode.tasks.openTranscript';
const MEMORY_SUMMARY_COMMAND = 'picode.memory.summary';
const MEMORY_SEARCH_COMMAND = 'picode.memory.search';
const MEMORY_CLEAR_SEARCH_COMMAND = 'picode.memory.clearSearch';
const MEMORY_OPEN_COMMAND = 'picode.memory.open';
const MEMORY_CHECK_COMMAND = 'picode.memory.check';
const MEMORY_UPDATE_COMMAND = 'picode.memory.updateEngine';

/** Whether memory is on (the connector sets it). */
const MEMORY_ENABLED_CONTEXT = 'picode.memory.enabled';

/** The task board and the memory summary as last read, shared like the MCPs. */
let knownTasks: ITaskBoard | undefined;
let knownMemory: IMemorySummary | undefined;

/** The folder's `+N −M` as last read, shared the same way. */
let knownDiff: { readonly added: number; readonly removed: number } | undefined;

/**
 * Both, kept with the workspace between starts: the panel paints what was last seen while pi starts
 * up (a few seconds), and pi's first answer replaces it.
 */
const LAST_SEEN_KEY = 'picode.status.lastSeen';

/** Opens every uncommitted change in one tab and narrows the review side bar to make room for it. */
const OPEN_CHANGES_COMMAND = 'picode.status.openChanges';

export class PicodeAgentOverview extends Disposable {

	private readonly root: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	/** Whether the finished tasks are unfolded. */
	private showFinished = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ISCMService private readonly scmService: ISCMService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		if (knownConnectors === undefined) {
			try {
				const saved = JSON.parse(this.storageService.get(LAST_SEEN_KEY, StorageScope.WORKSPACE) ?? 'null');
				knownConnectors = Array.isArray(saved?.connectors) ? saved.connectors : undefined;
				knownDiff ??= saved?.diff ?? undefined;
				knownMemory ??= saved?.memory?.state === 'ready' ? saved.memory : undefined;
			} catch {
				// A damaged record: wait for pi, as on a first start.
			}
		}
		this.root = append(parent, $('.picode-overview'));

		this._register(onDidChangePicodeAgentStatus(() => this.paint()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.paint()));
		this._register(this.scmService.onDidAddRepository(() => this.paint()));
		this._register(this.scmService.onDidRemoveRepository(() => this.paint()));
		this._register(this.chatWidgetService.onDidChangeFocusedSession(() => this.paint()));
		// What the editor already knows is painted now; pi's MCPs join when it answers.
		this.paint();
		this.setLive(true);
	}

	private setLive(live: boolean): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (live) {
			void this.refreshConnectors();
			this.timer = setInterval(() => void this.refreshConnectors(), REFRESH_MS);
		}
	}

	override dispose(): void {
		this.setLive(false);
		super.dispose();
	}

	private async refreshConnectors(): Promise<void> {
		try {
			const data = await this.commandService.executeCommand<{ mcpServers?: readonly IConnector[] }>(STATUS_DATA_COMMAND);
			knownConnectors = Array.isArray(data?.mcpServers) ? data.mcpServers : [];
		} catch {
			// pi is not answering yet: keep what it said last, if anything
		}
		const folder = this.workspaceService.getWorkspace().folders[0];
		try {
			knownDiff = folder ? await this.commandService.executeCommand<{ added: number; removed: number }>(DIFF_STAT_COMMAND, folder.uri.fsPath) : undefined;
		} catch {
			// pi is not answering yet: keep the last count
		}
		try {
			knownTasks = await this.commandService.executeCommand<ITaskBoard>(TASKS_DATA_COMMAND) ?? knownTasks;
		} catch {
			// pi is not answering yet: the chat's own status stands in (see `renderTasks`)
		}
		try {
			const memory = await this.commandService.executeCommand<IMemorySummary>(MEMORY_SUMMARY_COMMAND);
			// While the engine wakes, what it said last stands; its first answer replaces it.
			if (memory && (memory.state === 'ready' || knownMemory === undefined)) {
				knownMemory = memory;
			}
		} catch {
			// pi is not answering yet: keep what memory said last
		}
		const lastSeen = JSON.stringify({ connectors: knownConnectors, diff: knownDiff, memory: knownMemory?.state === 'ready' ? { ...knownMemory, search: undefined } : undefined });
		if (lastSeen !== this.storageService.get(LAST_SEEN_KEY, StorageScope.WORKSPACE)) {
			this.storageService.store(LAST_SEEN_KEY, lastSeen, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this.paint();
	}

	private paint(): void {
		this.renderDisposables.clear();
		clearNode(this.root);
		this.renderEnvironment(this.root);
		this.renderContext(this.root);
		this.renderConnectors(this.root);
		this.renderChanges(this.root);
		this.renderTasks(this.root);
		this.renderMemory(this.root);
	}

	/** A row that does something when clicked (its buttons keep their own clicks). */
	private clickable(row: HTMLElement, run: () => void, title?: string): void {
		row.classList.add('clickable');
		if (title) {
			row.title = title;
		}
		this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, e => {
			if (!(e.target instanceof HTMLElement && e.target.closest('button'))) {
				run();
			}
		}));
	}

	/** Runs one of the connector's commands, then reads again so the column shows its effect. */
	private async runAndRefresh(command: string, ...args: unknown[]): Promise<void> {
		await this.commandService.executeCommand(command, ...args);
		await this.refreshConnectors();
	}

	private section(parent: HTMLElement, title: string): HTMLElement {
		const section = append(parent, $('.picode-overview-section'));
		append(section, $('.picode-overview-title')).textContent = title;
		return section;
	}

	private row(parent: HTMLElement, icon: ThemeIcon, label: string, detail?: string): HTMLElement {
		const row = append(parent, $('.picode-overview-row'));
		append(row, $(`span.picode-overview-icon${ThemeIcon.asCSSSelector(icon)}`));
		const text = append(row, $('span.picode-overview-label'));
		text.textContent = label;
		if (detail) {
			append(text, $('span.picode-overview-detail')).textContent = ` · ${detail}`;
		}
		return row;
	}

	private action(row: HTMLElement, label: string, run: () => void): void {
		const button = append(row, $('button.picode-overview-action', { type: 'button' }));
		button.textContent = label;
		this.renderDisposables.add(addDisposableListener(button, EventType.CLICK, run));
	}

	private renderEnvironment(parent: HTMLElement): void {
		const section = this.section(parent, localize('picode.overview.environment', "Environment"));
		const remote = this.environmentService.remoteAuthority;
		this.row(section, remote ? Codicon.remote : Codicon.vm, remote ? remote : localize('picode.overview.thisComputer', "This computer"));

		const folder = this.workspaceService.getWorkspace().folders[0];
		if (folder) {
			this.row(section, Codicon.folder, folder.name, basename(folder.uri) !== folder.name ? basename(folder.uri) : undefined);
		} else {
			const row = this.row(section, Codicon.folder, localize('picode.overview.noFolder', "No folder open"));
			this.action(row, localize('picode.overview.openFolder', "Open"), () => void this.commandService.executeCommand('workbench.action.files.openFolder'));
		}

		const branch = this.currentBranch();
		if (branch) {
			this.row(section, Codicon.gitBranch, branch);
		}
	}

	private currentBranch(): string | undefined {
		for (const repository of this.scmService.repositories) {
			const name = repository.provider.historyProvider.get()?.historyItemRef.get()?.name;
			if (name) {
				return name;
			}
		}
		return undefined;
	}

	private renderContext(parent: HTMLElement): void {
		const usage = this.contextUsage();
		if (usage === undefined) {
			return;
		}
		const section = this.section(parent, localize('picode.overview.context', "Context"));
		const row = append(section, $('.picode-overview-row.picode-overview-meter-row'));
		append(row, $('span.picode-overview-label')).textContent = localize('picode.overview.contextUsed', "Used by this conversation");
		append(row, $('span.picode-overview-value')).textContent = `${usage}%`;
		const meter = append(section, $('.picode-overview-meter'));
		append(meter, $('.picode-overview-meter-fill')).style.width = `${Math.min(100, usage)}%`;
	}

	/** How full the focused chat's context is, from its last answer; undefined when unknown. */
	private contextUsage(): number | undefined {
		const model = this.chatWidgetService.lastFocusedWidget?.viewModel?.model;
		const last = model?.getRequests().at(-1);
		const usage = last?.response?.usage;
		const modelId = last?.modelId;
		if (!usage || !modelId) {
			return undefined;
		}
		const window = this.languageModelsService.lookupLanguageModel(modelId)?.maxInputTokens;
		if (!window) {
			return undefined;
		}
		return Math.round(((usage.promptTokens + usage.completionTokens) / window) * 100);
	}

	private renderConnectors(parent: HTMLElement): void {
		const connectors = knownConnectors;
		if (connectors === undefined) {
			return;
		}
		const section = this.section(parent, localize('picode.overview.connectors', "MCPs"));
		if (connectors.length === 0) {
			const row = this.row(section, Codicon.plug, localize('picode.overview.noConnectors', "No MCPs yet"));
			this.action(row, localize('picode.overview.addConnector', "Add"), () => void this.commandService.executeCommand('picode.mcp.addServer'));
			return;
		}
		for (const connector of connectors) {
			// The same mark the chat settings' MCP list shows: the service's own logo, or its initials.
			const row = append(section, $('.picode-overview-row'));
			append(row, $('span.picode-overview-logo')).appendChild(createServiceLogo(connector.name));
			append(row, $('span.picode-overview-label')).textContent = displayNameOf(connector.name);
			if (connector.signIn === 'needed') {
				row.classList.add('attention');
				this.action(row, localize('picode.overview.signIn', "Sign in"), () => void this.commandService.executeCommand('picode.mcp.signInServer', connector.name));
			} else if (connector.on === false) {
				append(row, $('span.picode-overview-value')).textContent = localize('picode.overview.off', "Off");
			}
		}
	}

	private renderChanges(parent: HTMLElement): void {
		let files = 0;
		for (const repository of this.scmService.repositories) {
			for (const group of repository.provider.groups) {
				files += group.resources.length;
			}
		}
		const section = this.section(parent, localize('picode.overview.changes', "Changes"));
		const filesLabel = files === 0
			? localize('picode.overview.noChanges', "Nothing changed")
			: files === 1 ? localize('picode.overview.oneChange', "1 file changed") : localize('picode.overview.manyChanges', "{0} files changed", files);
		let row: HTMLElement;
		if (files > 0 && knownDiff && (knownDiff.added > 0 || knownDiff.removed > 0)) {
			// Lines added and removed, as Claude Code shows them; the file count stays as the hover.
			row = append(section, $('.picode-overview-row'));
			append(row, $(`span.picode-overview-icon${ThemeIcon.asCSSSelector(Codicon.diff)}`));
			const label = append(row, $('span.picode-overview-label'));
			append(label, $('span.picode-overview-added')).textContent = `+${knownDiff.added.toLocaleString()}`;
			append(label, $('span.picode-overview-removed')).textContent = `−${knownDiff.removed.toLocaleString()}`;
			row.title = localize('picode.overview.openChanges', "{0} — open the changes", filesLabel);
			row.classList.add('clickable');
			this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, e => {
				if (!(e.target instanceof HTMLElement && e.target.closest('button'))) {
					void this.commandService.executeCommand(OPEN_CHANGES_COMMAND);
				}
			}));
		} else {
			row = this.row(section, Codicon.diff, filesLabel);
		}
		if (files > 0) {
			this.action(row, localize('picode.overview.review', "Review"), () => void this.commandService.executeCommand(OPEN_CHANGES_COMMAND));
		}
	}

	/** The chat's background work: what the connector's Tasks block shows, running first, then what finished. */
	private renderTasks(parent: HTMLElement): void {
		const status = picodeAgentStatus();
		const section = this.section(parent, localize('picode.overview.tasks', "Tasks"));
		if (status?.running && status.activity) {
			this.row(section, Codicon.loading, status.activity).classList.add('running');
		}
		const board = knownTasks;
		if (board === undefined) {
			// The connector has not answered yet: the jobs the chat reported stand in.
			for (const job of status?.jobs ?? []) {
				const minutes = Math.max(0, Math.round((Date.now() - job.startedAt) / 60_000));
				const row = this.row(section, Codicon.terminal, job.label ?? job.command ?? localize('picode.overview.job', "Job {0}", job.jobNumber));
				append(row, $('span.picode-overview-value')).textContent = minutes < 1 ? localize('picode.overview.justNow', "now") : localize('picode.overview.minutes', "{0} min", minutes);
			}
			if (!status?.running && (status?.jobs.length ?? 0) === 0) {
				this.row(section, Codicon.check, localize('picode.overview.idle', "Nothing running"));
			}
			return;
		}
		for (const task of board.running) {
			this.taskRow(section, task);
		}
		if (board.running.length === 0 && !status?.running) {
			this.row(section, Codicon.check, localize('picode.overview.idle', "Nothing running"));
		}
		if (board.finished.length > 0) {
			const row = this.row(section, this.showFinished ? Codicon.chevronDown : Codicon.chevronRight, localize('picode.overview.finished', "Finished"));
			append(row, $('span.picode-overview-value')).textContent = String(board.finished.length);
			this.clickable(row, () => {
				this.showFinished = !this.showFinished;
				this.paint();
			});
			if (this.showFinished) {
				for (const task of board.finished) {
					this.taskRow(section, task).classList.add('nested');
				}
			}
		}
	}

	private taskRow(parent: HTMLElement, task: ITaskRow): HTMLElement {
		const row = this.row(parent, ThemeIcon.fromId(task.icon), task.title);
		append(row, $('span.picode-overview-value')).textContent = task.detail;
		if (task.agentId) {
			this.clickable(row, () => void this.commandService.executeCommand(TASKS_TRANSCRIPT_COMMAND, task.agentId), task.tooltip ?? localize('picode.overview.openAgent', "Follow what this agent does"));
		} else if (task.outputFile) {
			const output = URI.file(task.outputFile);
			this.clickable(row, () => void this.commandService.executeCommand('vscode.open', output), task.tooltip ?? localize('picode.overview.openOutput', "Open what this job prints"));
		} else if (task.tooltip) {
			row.title = task.tooltip;
		}
		return row;
	}

	/** What memory holds for the open folders, its search and its check: the connector's Memory block. */
	private renderMemory(parent: HTMLElement): void {
		if (this.contextKeyService.getContextKeyValue<boolean>(MEMORY_ENABLED_CONTEXT) !== true) {
			return;
		}
		const memory = knownMemory;
		const section = this.section(parent, localize('picode.overview.memory', "Memory"));
		if (memory === undefined || memory.state === 'loading') {
			this.row(section, Codicon.loading, localize('picode.overview.memoryStarting', "Memory is starting…")).classList.add('running');
			return;
		}
		if (memory.state === 'unavailable') {
			const row = this.row(section, Codicon.warning, localize('picode.overview.memoryDown', "Memory is not answering"));
			row.classList.add('attention');
			this.action(row, localize('picode.overview.memoryCheck', "Check"), () => void this.runAndRefresh(MEMORY_CHECK_COMMAND));
			return;
		}
		const heading = this.row(section, Codicon.database, memory.heading ?? '', memory.detail);
		if (memory.newerEngine) {
			this.action(heading, localize('picode.overview.memoryUpdate', "Update"), () => void this.runAndRefresh(MEMORY_UPDATE_COMMAND));
		}
		if (memory.search) {
			const results = this.row(section, Codicon.search, localize('picode.overview.memoryResults', "“{0}”", memory.search.query));
			append(results, $('span.picode-overview-value')).textContent = String(memory.search.total);
			this.action(results, localize('picode.overview.memoryClear', "Clear"), () => void this.runAndRefresh(MEMORY_CLEAR_SEARCH_COMMAND));
			for (const hit of memory.search.rows) {
				const row = this.row(section, ThemeIcon.fromId(hit.icon), hit.title, hit.when || undefined);
				row.classList.add('nested');
				this.clickable(row, () => void this.commandService.executeCommand(MEMORY_OPEN_COMMAND, { id: hit.id }), hit.project);
			}
		} else {
			for (const project of memory.projects ?? []) {
				const row = this.row(section, Codicon.folder, project.name);
				append(row, $('span.picode-overview-value')).textContent = String(project.memories);
			}
		}
		const search = this.row(section, Codicon.search, localize('picode.overview.memorySearch', "Search memories…"));
		this.clickable(search, () => void this.runAndRefresh(MEMORY_SEARCH_COMMAND));
		const check = this.row(section, Codicon.pulse, localize('picode.overview.memoryCheckRow', "Check memory"));
		this.clickable(check, () => void this.commandService.executeCommand(MEMORY_CHECK_COMMAND));
	}
}

/** The review bar's width while the changes are open: one column, Status as its tab. */
const CHANGES_REVIEW_WIDTH = 320;

const EXPLORER_CONTAINER_ID = 'workbench.view.explorer';

/** Whether the review side bar shows Status as its own column; its tab steps aside meanwhile. */
export const PICODE_STATUS_COLUMN_SHOWN = new RawContextKey<boolean>('picodeStatusColumnShown', false);

/**
 * Fills the side bar's status column while it shows, and stops reading once it hides. Status is
 * either the column (wide bar) or a tab of the bar (narrow bar), never both: the context key hides
 * the tab while the column is there.
 */
class PicodeSidebarStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.picodeSidebarStatus';

	private readonly overview = this._register(new MutableDisposable<PicodeAgentOverview>());
	private shownIn: HTMLElement | undefined;
	private readonly columnShown: IContextKey<boolean>;

	/** The changes tab opened last, and the review bar's width before it narrowed for it. */
	private changesTab: URI | undefined;
	private widthBeforeChanges: number | undefined;

	/** Status was the bar's open tab when the column took over; narrowing again brings it back. */
	private statusSteppedAside = false;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IEditorService private readonly editorService: IEditorService,
		@ISCMService private readonly scmService: ISCMService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(OPEN_CHANGES_COMMAND, () => this.openChanges()));
		// Closing the changes gives the review bar back the width it had, unless it was resized meanwhile.
		this._register(this.editorService.onDidCloseEditor(({ editor }) => {
			if (this.changesTab && editor.resource?.toString() === this.changesTab.toString() && this.editorService.findEditors(this.changesTab).length === 0) {
				this.changesTab = undefined;
				const width = this.widthBeforeChanges;
				this.widthBeforeChanges = undefined;
				if (width !== undefined && Math.abs(this.layoutService.getSize(Parts.SIDEBAR_PART).width - CHANGES_REVIEW_WIDTH) <= 2) {
					this.layoutService.setSize(Parts.SIDEBAR_PART, { width, height: this.layoutService.getSize(Parts.SIDEBAR_PART).height });
				}
			}
		}));
		this.columnShown = PICODE_STATUS_COLUMN_SHOWN.bindTo(contextKeyService);
		this._register(sidebarSideColumn.onDidChange(() => this.update()));
		// The bar restores its last view after this starts: a Status tab reopened beside the column gives way too.
		this._register(this.paneCompositeService.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
			if (viewContainerLocation !== ViewContainerLocation.Sidebar) {
				return;
			}
			if (composite.getId() === PICODE_STATUS_CONTAINER_ID) {
				this.leaveStatusTab();
			} else if (composite.getId() !== EXPLORER_CONTAINER_ID && sidebarSideColumn.visible) {
				// Another tab picked by hand while the bar is wide: that is the one to keep when it narrows.
				this.statusSteppedAside = false;
			}
		}));
		this.update();
	}

	private leaveStatusTab(): void {
		if (sidebarSideColumn.visible && this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === PICODE_STATUS_CONTAINER_ID) {
			this.statusSteppedAside = true;
			void this.paneCompositeService.openPaneComposite(EXPLORER_CONTAINER_ID, ViewContainerLocation.Sidebar);
		}
	}

	/** The bar narrowed again: the Status tab that stepped aside for the column comes back. */
	private returnToStatusTab(): void {
		if (!this.statusSteppedAside || sidebarSideColumn.visible) {
			return;
		}
		this.statusSteppedAside = false;
		// After the context key has shown the tab again.
		setTimeout(() => void this.paneCompositeService.openPaneComposite(PICODE_STATUS_CONTAINER_ID, ViewContainerLocation.Sidebar), 0);
	}

	/**
	 * Every uncommitted file in one tab, each with its diff, the way Claude Code lists changes. A
	 * file both staged and changed again shows once, as it is now on disk. The review bar narrows to
	 * a single column so the diff gets the room, with Status as its open tab; the tab is a snapshot,
	 * and opening it again replaces the previous one.
	 */
	private async openChanges(): Promise<void> {
		const byFile = new Map<string, { originalUri: URI | undefined; modifiedUri: URI | undefined }>();
		for (const repository of this.scmService.repositories) {
			for (const group of repository.provider.groups) {
				for (const resource of group.resources) {
					byFile.set(resource.sourceUri.toString(), { originalUri: resource.multiDiffEditorOriginalUri, modifiedUri: resource.multiDiffEditorModifiedUri });
				}
			}
		}
		if (byFile.size === 0) {
			return;
		}
		const previous = this.changesTab;
		this.changesTab = URI.parse(`multi-diff-editor:picode-changes-${Date.now()}`);
		if (previous) {
			await this.editorService.closeEditors(this.editorService.findEditors(previous));
		}
		await this.commandService.executeCommand('_workbench.openMultiDiffEditor', {
			title: localize('picode.overview.changesTitle', "Changes"),
			multiDiffSourceUri: this.changesTab,
			resources: [...byFile.values()],
		});

		const { width, height } = this.layoutService.getSize(Parts.SIDEBAR_PART);
		if (width > CHANGES_REVIEW_WIDTH) {
			this.widthBeforeChanges = width;
			this.layoutService.setSize(Parts.SIDEBAR_PART, { width: CHANGES_REVIEW_WIDTH, height });
		}
		// Narrow now (once the bar has laid out again), the bar has Status back as a tab: open it, so what changed stays in view.
		await new Promise(resolve => setTimeout(resolve, 0));
		await this.paneCompositeService.openPaneComposite(PICODE_STATUS_CONTAINER_ID, ViewContainerLocation.Sidebar);
	}

	private update(): void {
		const { element, visible } = sidebarSideColumn;
		this.columnShown.set(visible && !!element);
		// The Status tab was the open one: the column takes over, and the bar shows the files beside it;
		// narrower again, the Status tab comes back.
		this.leaveStatusTab();
		this.returnToStatusTab();
		if (!visible || !element) {
			this.overview.clear();
			this.shownIn = undefined;
			return;
		}
		if (this.shownIn !== element || !this.overview.value) {
			this.overview.clear();
			element.textContent = '';
			this.overview.value = this.instantiationService.createInstance(PicodeAgentOverview, element);
			this.shownIn = element;
		}
	}
}

// BlockRestore: the column is filled as the window first draws, not seconds after.
registerWorkbenchContribution2(PicodeSidebarStatusContribution.ID, PicodeSidebarStatusContribution, WorkbenchPhase.BlockRestore);
