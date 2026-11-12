/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../base/common/resources.js';
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
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { ISCMService } from '../../scm/common/scm.js';
import { onDidChangePicodeAgentStatus } from './picodeAgentStatusPill.js';
import { createServiceLogo, displayNameOf } from './picodeServiceLogo.js';
import { PicodeStatusIssues } from './account/issues/picodeStatusIssues.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { areAllStatusSectionsHidden, decorateStatusSectionTitle, isStatusSectionFolded, isStatusSectionHidden, onDidChangePicodeStatusSections, PicodeStatusSectionId, showAllStatusSections } from './picodeStatusSections.js';

/**
 * The Agent layout's status column, the first half of the review side bar once it is wide enough: where the agent works, how
 * full its context is, which MCPs it has, what changed and what is still running.
 *
 * Every row is read from what the editor already knows — the workspace, source control, the chat's
 * last answer, pi's own MCP list (`picode.setup.mcpServers`) and the jobs the connector pushes — and
 * nothing is guessed: a fact that is not there is left out rather than shown as a zero.
 */
const MCP_SERVERS_COMMAND = 'picode.setup.mcpServers';
const DIFF_STAT_COMMAND = 'picode.git.diffStat';

/** How often the panel re-reads what has no event of its own (context use, pi's connectors). */
const REFRESH_MS = 4000;

/** The same, with the window in the background: still current, at a fraction of the work. */
const BACKGROUND_REFRESH_MS = 30_000;

/** The line count follows file changes; this is only the safety net for a change no event told of. */
const DIFF_SAFETY_MS = 60_000;

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
/** One fact under an open row of the Tasks block. */
interface ITaskFact {
	readonly label: string;
	readonly detail: string;
	readonly icon: string;
	readonly tooltip?: string;
	readonly openFile?: string;
}

interface ITaskRow {
	readonly title: string;
	readonly detail: string;
	readonly icon: string;
	readonly agentId?: string;
	readonly outputFile?: string;
	readonly tooltip?: string;
	readonly facts?: readonly ITaskFact[];
}

/** The connector's task board: what its Tasks block shows. */
/** The agent's own task list: `progress` is `2/5`, each row is one step of its plan. */
interface ITaskTodos {
	readonly progress: string;
	readonly rows: readonly { readonly title: string; readonly status: string; readonly icon: string; readonly detail?: string; readonly working?: boolean }[];
}

interface ITaskBoard {
	/** `Nothing running` or `2 running`. */
	readonly summary?: string;
	readonly running: readonly ITaskRow[];
	readonly finished: readonly ITaskRow[];
	readonly todos?: ITaskTodos;
}

/** What the connector's Memory block shows (`picode.memory.summary`). */
interface IMemorySummary {
	readonly state: 'loading' | 'unavailable' | 'ready';
	readonly retried?: boolean;
	readonly heading?: string;
	readonly detail?: string;
	readonly projects?: readonly { readonly name: string; readonly memories: number; readonly open?: boolean; readonly moreLabel?: string; readonly emptyLabel?: string; readonly rows?: readonly { readonly id: number; readonly title: string; readonly when: string; readonly icon: string }[] }[];
	readonly search?: { readonly query: string; readonly total: number; readonly capped?: boolean; readonly emptyLabel?: string; readonly moreLabel?: string; readonly rows: readonly { readonly id: number; readonly title: string; readonly project: string; readonly when: string; readonly icon: string }[] };
	readonly newerEngine?: string;
	readonly filter?: { readonly label: string; readonly detail?: string; readonly clearLabel?: string };
}

const TASKS_DATA_COMMAND = 'picode.tasks.data';
const TASKS_TRANSCRIPT_COMMAND = 'picode.tasks.openTranscript';
const MEMORY_SUMMARY_COMMAND = 'picode.memory.summary';
const MEMORY_SEARCH_COMMAND = 'picode.memory.search';
const MEMORY_CLEAR_SEARCH_COMMAND = 'picode.memory.clearSearch';
const MEMORY_OPEN_COMMAND = 'picode.memory.open';
const MEMORY_TOGGLE_PROJECT_COMMAND = 'picode.memory.toggleProject';
const MEMORY_SHOW_MORE_COMMAND = 'picode.memory.showMoreInColumn';
const MEMORY_FILTER_COMMAND = 'picode.memory.filter';
const MEMORY_CLEAR_FILTER_COMMAND = 'picode.memory.clearFilter';
const MEMORY_CHECK_COMMAND = 'picode.memory.check';
const MEMORY_UPDATE_COMMAND = 'picode.memory.updateEngine';

/** Whether memory is on (the connector sets it). */
const MEMORY_ENABLED_CONTEXT = 'picode.memory.enabled';

/** Where a chat's context goes, as the connector estimates it (`context-breakdown.ts`). */
type ContextPartId = 'messages' | 'project' | 'pi' | 'skills' | 'other' | 'tools' | 'mcp';

interface IContextBreakdown {
	readonly window: number;
	readonly used: number;
	readonly exact: boolean;
	readonly parts: readonly { readonly id: ContextPartId; readonly tokens: number }[];
	readonly reserve: number;
	readonly free: number;
	readonly untilCompaction: number;
}

const CONTEXT_BREAKDOWN_COMMAND = 'picode.context.breakdown';
const CONTEXT_COMPACT_COMMAND = 'picode.context.compact';

/** The focused chat's context as last read, shared like the MCPs. */
let knownContext: IContextBreakdown | undefined;

function contextPartLabel(id: ContextPartId): string {
	switch (id) {
		case 'messages': return localize('picode.overview.contextMessages', "Messages");
		case 'project': return localize('picode.overview.contextProject', "Project instructions");
		case 'pi': return localize('picode.overview.contextPi', "pi instructions");
		case 'skills': return localize('picode.overview.contextSkills', "Skills");
		case 'other': return localize('picode.overview.contextOther', "Other instructions");
		case 'tools': return localize('picode.overview.contextTools', "pi tools");
		case 'mcp': return localize('picode.overview.contextMcp', "MCP tools");
	}
}

/** 573,912 as 573.9k, 1,000,000 as 1M. */
function compactTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	}
	if (tokens >= 1_000) {
		return `${Number((tokens / 1_000).toFixed(1))}k`;
	}
	return String(Math.round(tokens));
}

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
	private readonly issuesHost: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	/** Whether the finished tasks are unfolded. */
	private showRunning = true;
	private showFinished = false;
	/** The task rows opened to their facts: they stay open while the board repaints. */
	private readonly openTasks = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	/** The readings still waiting for an answer: a slow one is not asked again on top of itself. */
	private readonly reading = new Set<string>();
	/** Files changed since the line count was read. */
	private diffStale = true;
	private diffReadAt = 0;
	/** What the column last drew, so a reading that changed nothing leaves it (and its hover) alone. */
	private painted: string | undefined;

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
		@IHostService private readonly hostService: IHostService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IFileService fileService: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
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
		// The issue panels draw and refresh themselves; the column only puts their host back after each repaint.
		this.issuesHost = $('.picode-overview-issues');
		this._register(instantiationService.createInstance(PicodeStatusIssues, this.issuesHost, true));

		// What the agent is doing changed: the plan says so without waiting for the next reading.
		this._register(onDidChangePicodeAgentStatus(() => {
			this.paint();
			void this.readTasks();
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this.diffStale = true;
			this.paint();
		}));
		this._register(fileService.onDidFilesChange(event => {
			const folder = this.workspaceService.getWorkspace().folders[0];
			if (folder && event.affects(folder.uri)) {
				this.diffStale = true;
			}
		}));
		this._register(this.hostService.onDidChangeFocus(() => this.setLive(true)));
		this._register(this.scmService.onDidAddRepository(() => this.paint()));
		this._register(this.scmService.onDidRemoveRepository(() => this.paint()));
		this._register(this.chatWidgetService.onDidChangeFocusedSession(() => {
			this.paint();
			// Another chat in front: its context, not the previous one's.
			void this.read('context', () => this.readContext());
		}));
		// A section hidden, shown, folded or unfolded, here or in the other Status of the window.
		this._register(onDidChangePicodeStatusSections(() => this.paint()));
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
			this.refresh();
			this.timer = setInterval(() => this.refresh(), this.hostService.hasFocus ? REFRESH_MS : BACKGROUND_REFRESH_MS);
		}
	}

	private disposed = false;

	override dispose(): void {
		this.disposed = true;
		this.setLive(false);
		super.dispose();
	}

	private refresh(): void {
		void this.read('connectors', async () => {
			const servers = await this.commandService.executeCommand<readonly IConnector[]>(MCP_SERVERS_COMMAND);
			knownConnectors = Array.isArray(servers) ? servers : [];
		});
		void this.readTasks();
		void this.read('memory', () => this.readMemory());
		if (!isStatusSectionHidden(this.storageService, 'context')) {
			void this.read('context', () => this.readContext());
		}
		// Only counted where it is drawn: with no changed file the column shows no lines at all.
		if (this.changedFiles() > 0 && (this.diffStale || Date.now() - this.diffReadAt > DIFF_SAFETY_MS)) {
			void this.read('diff', async () => {
				this.diffStale = false;
				this.diffReadAt = Date.now();
				const folder = this.workspaceService.getWorkspace().folders[0];
				knownDiff = folder ? await this.commandService.executeCommand<{ added: number; removed: number }>(DIFF_STAT_COMMAND, folder.uri.fsPath) : undefined;
			});
		}
		// Nothing to read for these, but the tick is what notices them.
		this.publish();
	}

	private readTasks(): Promise<void> {
		return this.read('tasks', async () => {
			knownTasks = await this.commandService.executeCommand<ITaskBoard>(TASKS_DATA_COMMAND) ?? knownTasks;
		});
	}

	/** One reading at a time per kind. pi not answering yet is no fault: what it said last stands. */
	private async read(kind: string, work: () => Promise<void>): Promise<void> {
		if (this.reading.has(kind)) {
			return;
		}
		this.reading.add(kind);
		try {
			await work();
		} catch {
			// See above.
		} finally {
			this.reading.delete(kind);
		}
		this.publish();
	}

	private async readMemory(): Promise<void> {
		const memory = await this.commandService.executeCommand<IMemorySummary>(MEMORY_SUMMARY_COMMAND);
		// While the engine wakes, what it said last stands; its first answer replaces it.
		if (memory && (memory.state === 'ready' || knownMemory === undefined)) {
			knownMemory = memory;
		}
	}

	/** Keeps what was read for the next start, and draws it if it differs from what is on screen. */
	private publish(): void {
		if (this.disposed) {
			return;
		}
		const lastSeen = JSON.stringify({ connectors: knownConnectors, diff: knownDiff, memory: knownMemory?.state === 'ready' ? { ...knownMemory, search: undefined } : undefined });
		if (lastSeen !== this.storageService.get(LAST_SEEN_KEY, StorageScope.WORKSPACE)) {
			this.storageService.store(LAST_SEEN_KEY, lastSeen, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		if (this.fingerprint() !== this.painted) {
			this.paint();
		}
	}

	/** Everything `paint` draws from, apart from the folds, which repaint by themselves. */
	private fingerprint(): string {
		return JSON.stringify([
			knownConnectors, knownDiff, knownTasks, knownMemory, knownContext,
			this.changedFiles(), this.currentBranch(), this.contextUsage(),
			this.workspaceService.getWorkspace().folders[0]?.uri.toString(),
			this.contextKeyService.getContextKeyValue<boolean>(MEMORY_ENABLED_CONTEXT),
		]);
	}

	private paint(): void {
		// A refresh still waiting for pi can answer after the column was closed.
		if (this.disposed) {
			return;
		}
		this.painted = this.fingerprint();
		this.renderDisposables.clear();
		clearNode(this.root);
		if (areAllStatusSectionsHidden(this.storageService)) {
			const row = this.row(this.section(this.root, undefined), Codicon.eyeClosed, localize('picode.overview.allHidden', "All sections are hidden"));
			this.action(row, localize('picode.overview.showSections', "Show"), () => showAllStatusSections(this.storageService));
			return;
		}
		this.renderEnvironment(this.root);
		this.renderContext(this.root);
		this.renderConnectors(this.root);
		this.renderChanges(this.root);
		this.renderTasks(this.root);
		this.root.appendChild(this.issuesHost);
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

	/** Runs one of memory's commands and shows its effect at once, without waiting on anything else. */
	private async runMemoryCommand(command: string, ...args: unknown[]): Promise<void> {
		await this.commandService.executeCommand(command, ...args);
		try {
			await this.readMemory();
		} catch {
			// Not answering: the row that says so comes with the next reading.
		}
		this.publish();
	}

	private section(parent: HTMLElement, title: string | undefined): HTMLElement {
		const section = append(parent, $('.picode-overview-section'));
		if (title) {
			append(section, $('.picode-overview-title')).textContent = title;
		}
		return section;
	}

	/**
	 * A section with its title, its arrow and its right-click menu, or nothing when the person hid
	 * it. `open` says whether its content is drawn: folded, only the title shows.
	 */
	private titledSection(parent: HTMLElement, id: PicodeStatusSectionId, title: string): { readonly section: HTMLElement; readonly heading: HTMLElement; readonly open: boolean } | undefined {
		if (isStatusSectionHidden(this.storageService, id)) {
			return undefined;
		}
		const section = append(parent, $('.picode-overview-section'));
		const heading = append(section, $('.picode-overview-title'));
		append(heading, $('span.picode-overview-title-label')).textContent = title;
		decorateStatusSectionTitle(heading, id, this.renderDisposables, this.contextMenuService, this.storageService);
		return { section, heading, open: !isStatusSectionFolded(this.storageService, id) };
	}

	private changedFiles(): number {
		let files = 0;
		for (const repository of this.scmService.repositories) {
			for (const group of repository.provider.groups) {
				files += group.resources.length;
			}
		}
		return files;
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
		const titled = this.titledSection(parent, 'environment', localize('picode.overview.environment', "Environment"));
		if (!titled) {
			return;
		}
		const section = titled.section;
		const remote = this.environmentService.remoteAuthority;
		this.row(section, remote ? Codicon.remote : Codicon.vm, remote ? remote : localize('picode.overview.thisComputer', "This computer"));

		const folder = this.workspaceService.getWorkspace().folders[0];
		if (folder) {
			// The folder's parent says which "PiCode-Website" this is, without the whole path.
			const parent = basename(dirname(folder.uri));
			this.row(section, Codicon.folder, folder.name, parent && parent !== folder.name ? parent : undefined);
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
		const breakdown = knownContext;
		if (breakdown && breakdown.window > 0) {
			this.renderContextBreakdown(parent, breakdown);
			return;
		}
		const usage = this.contextUsage();
		if (usage === undefined) {
			return;
		}
		const titled = this.titledSection(parent, 'context', localize('picode.overview.context', "Context"));
		if (!titled?.open) {
			return;
		}
		const section = titled.section;
		const row = append(section, $('.picode-overview-row.picode-overview-meter-row'));
		append(row, $('span.picode-overview-label')).textContent = localize('picode.overview.contextUsed', "Used by this conversation");
		append(row, $('span.picode-overview-value')).textContent = `${usage}%`;
		const meter = append(section, $('.picode-overview-meter'));
		append(meter, $('.picode-overview-meter-fill')).style.width = `${Math.min(100, usage)}%`;
	}

	/**
	 * Where the focused chat's context goes, as Claude Code shows it: the share used over the window,
	 * a bar with one colour per part, one row per part, and the room left before pi compacts with a
	 * button to compact now. The parts are estimates (marked «~»); the total is pi's when it has one.
	 * Folded, only the share and the bar stay.
	 */
	private renderContextBreakdown(parent: HTMLElement, breakdown: IContextBreakdown): void {
		const titled = this.titledSection(parent, 'context', localize('picode.overview.context', "Context"));
		if (!titled) {
			return;
		}
		const { section, open } = titled;
		const percent = (tokens: number) => breakdown.window > 0 ? (tokens / breakdown.window) * 100 : 0;
		const share = (tokens: number) => `${percent(tokens).toFixed(1)}%`;
		const head = append(section, $('.picode-overview-row.picode-overview-meter-row'));
		append(head, $('span.picode-overview-label')).textContent = localize('picode.overview.contextPercent', "{0}% used", Math.round(percent(breakdown.used)));
		append(head, $('span.picode-overview-value')).textContent = `${breakdown.exact ? '' : '~'}${compactTokens(breakdown.used)} / ${compactTokens(breakdown.window)}`;
		const bar = append(section, $('.picode-overview-meter.picode-overview-context-bar'));
		for (const part of breakdown.parts) {
			const piece = append(bar, $(`.picode-overview-context-piece.${part.id}`));
			piece.style.width = `${percent(part.tokens)}%`;
		}
		const reservePiece = append(bar, $('.picode-overview-context-piece.reserve'));
		reservePiece.style.width = `${percent(breakdown.reserve)}%`;
		if (!open) {
			return;
		}
		const line = (css: string, label: string, tokens: number, estimated: boolean) => {
			const row = append(section, $('.picode-overview-row.picode-overview-context-row'));
			append(row, $(`span.picode-overview-context-swatch.${css}`));
			append(row, $('span.picode-overview-label')).textContent = label;
			append(row, $('span.picode-overview-value')).textContent = `${estimated ? '~' : ''}${compactTokens(tokens)}`;
			append(row, $('span.picode-overview-context-share')).textContent = share(tokens);
		};
		for (const part of breakdown.parts) {
			// The messages are exact when pi gave the total: they are what the other parts leave.
			line(part.id, contextPartLabel(part.id), part.tokens, !(part.id === 'messages' && breakdown.exact));
		}
		line('reserve', localize('picode.overview.contextReserve', "Kept for compacting"), breakdown.reserve, false);
		const free = append(section, $('.picode-overview-row.picode-overview-context-row'));
		append(free, $('span.picode-overview-context-swatch.free'));
		append(free, $('span.picode-overview-label')).textContent = localize('picode.overview.contextFree', "Room before compacting");
		append(free, $('span.picode-overview-value')).textContent = compactTokens(breakdown.untilCompaction);
		append(free, $('span.picode-overview-context-share')).textContent = share(breakdown.untilCompaction);
		// Only the button: a sentence beside it said the same thing, got cut off and looked clickable.
		const compact = append(section, $('.picode-overview-row'));
		this.action(compact, localize('picode.overview.contextCompact', "Compact session"), () => void this.compactContext());
		compact.lastElementChild?.setAttribute('title', localize('picode.overview.contextCompactHint', "Summarise the conversation to free room"));
	}

	private async compactContext(): Promise<void> {
		await this.commandService.executeCommand(CONTEXT_COMPACT_COMMAND, this.focusedChatKey());
		void this.read('context', () => this.readContext());
	}

	/** The chat the person last looked at, as the connector keys its conversations. */
	private focusedChatKey(): string | undefined {
		return this.chatWidgetService.lastFocusedWidget?.viewModel?.model.sessionResource.toString();
	}

	private async readContext(): Promise<void> {
		knownContext = await this.commandService.executeCommand<IContextBreakdown>(CONTEXT_BREAKDOWN_COMMAND, this.focusedChatKey()) ?? undefined;
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
		const titled = this.titledSection(parent, 'connectors', localize('picode.overview.connectors', "MCPs"));
		if (!titled) {
			return;
		}
		const { section, heading, open } = titled;
		if (connectors.length === 0) {
			if (open) {
				const row = this.row(section, Codicon.plug, localize('picode.overview.noConnectors', "No MCPs yet"));
				this.action(row, localize('picode.overview.addConnector', "Add"), () => void this.commandService.executeCommand('picode.mcp.addServer'));
			}
			return;
		}
		// Folded by default: only the ones that need the user (sign in, off) stay visible.
		append(heading, $('span.picode-overview-value')).textContent = String(connectors.length);
		for (const connector of connectors) {
			const needsYou = connector.signIn === 'needed' || connector.on === false;
			if (!open && !needsYou) {
				continue;
			}
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
		const files = this.changedFiles();
		if (isStatusSectionHidden(this.storageService, 'changes')) {
			return;
		}
		// Nothing changed is one quiet line: a title over it would only repeat the word.
		let section: HTMLElement;
		if (files === 0) {
			section = this.section(parent, undefined);
		} else {
			const titled = this.titledSection(parent, 'changes', localize('picode.overview.changes', "Changes"))!;
			if (!titled.open) {
				return;
			}
			section = titled.section;
		}
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

	/** The same block as the connector's Tasks view: the plan, what is running, and what finished. */
	private renderTasks(parent: HTMLElement): void {
		const titled = this.titledSection(parent, 'tasks', localize('picode.overview.tasks', "Tasks"));
		if (!titled) {
			return;
		}
		const section = titled.section;
		const running = knownTasks?.running ?? [];
		if (!titled.open) {
			// Folded, the title still says whether something runs.
			if (running.length > 0) {
				append(titled.heading, $('span.picode-overview-value')).textContent = String(running.length);
			}
			return;
		}
		const finished = knownTasks?.finished ?? [];
		const todos = knownTasks?.todos;
		this.row(section, Codicon.dashboard, knownTasks?.summary ?? localize('picode.overview.idle', "Nothing running"));
		if (todos) {
			const plan = this.row(section, Codicon.checklist, localize('picode.overview.plan', "Plan"));
			append(plan, $('span.picode-overview-value')).textContent = todos.progress;
			for (const step of todos.rows) {
				const row = this.row(section, ThemeIcon.fromId(step.icon), step.title, step.detail);
				row.classList.add('nested', `todo-${step.status}`);
				row.title = step.detail ? `${step.title}\n${step.detail}` : step.title;
				if (step.working) {
					row.classList.add('running');
				}
			}
		}
		this.taskGroup(section, localize('picode.overview.running', "Running"), Codicon.sync, running, this.showRunning, () => this.showRunning = !this.showRunning);
		this.taskGroup(section, localize('picode.overview.finished', "Finished"), Codicon.history, finished, this.showFinished, () => this.showFinished = !this.showFinished);
	}

	private taskGroup(section: HTMLElement, label: string, icon: ThemeIcon, tasks: readonly ITaskRow[], open: boolean, toggle: () => void): void {
		if (tasks.length === 0) {
			return;
		}
		const row = this.foldRow(section, open, icon, label, toggle);
		append(row, $('span.picode-overview-value')).textContent = String(tasks.length);
		if (open) {
			for (const task of tasks) {
				this.taskRow(section, task);
			}
		}
	}

	/** A row with the arrow that opens and closes what is under it. */
	private foldRow(parent: HTMLElement, open: boolean, icon: ThemeIcon, label: string, toggle: () => void): HTMLElement {
		const row = this.row(parent, icon, label);
		row.prepend($(`span.picode-overview-twistie${ThemeIcon.asCSSSelector(open ? Codicon.chevronDown : Codicon.chevronRight)}`));
		this.clickable(row, () => {
			toggle();
			this.paint();
		});
		return row;
	}

	/** "Show N more" under a list of memories: a project's, or the search's without one. */
	private moreRow(parent: HTMLElement, label: string, project?: string): void {
		const row = this.row(parent, Codicon.ellipsis, label);
		row.classList.add('nested');
		this.clickable(row, () => void this.runMemoryCommand(MEMORY_SHOW_MORE_COMMAND, project));
	}

	private taskRow(parent: HTMLElement, task: ITaskRow): void {
		const key = task.agentId ?? task.outputFile ?? task.title;
		const open = this.openTasks.has(key);
		const row = this.foldRow(parent, open, ThemeIcon.fromId(task.icon), task.title, () => {
			if (!this.openTasks.delete(key)) {
				this.openTasks.add(key);
			}
		});
		row.classList.add('nested');
		append(row, $('span.picode-overview-value')).textContent = task.detail;
		if (task.tooltip) {
			row.title = task.tooltip;
		}
		if (task.agentId) {
			const agentId = task.agentId;
			const follow = append(row, $(`button.picode-overview-icon-action${ThemeIcon.asCSSSelector(Codicon.book)}`, { type: 'button', title: localize('picode.overview.openAgent', "Follow what this agent does") }));
			this.renderDisposables.add(addDisposableListener(follow, EventType.CLICK, () => void this.commandService.executeCommand(TASKS_TRANSCRIPT_COMMAND, agentId)));
		}
		if (open) {
			for (const fact of task.facts ?? []) {
				const line = this.row(parent, ThemeIcon.fromId(fact.icon), fact.label, fact.detail);
				line.classList.add('nested-deep');
				if (fact.tooltip) {
					line.title = fact.tooltip;
				}
				if (fact.openFile) {
					const output = URI.file(fact.openFile);
					this.clickable(line, () => void this.commandService.executeCommand('vscode.open', output), fact.tooltip);
				}
			}
		}
	}

	/** What memory holds for the open folders, its search and its check: the connector's Memory block. */
	private renderMemory(parent: HTMLElement): void {
		if (this.contextKeyService.getContextKeyValue<boolean>(MEMORY_ENABLED_CONTEXT) !== true) {
			return;
		}
		const memory = knownMemory;
		const titled = this.titledSection(parent, 'memory', localize('picode.overview.memory', "Memory"));
		if (!titled?.open) {
			return;
		}
		const section = titled.section;
		if (memory === undefined || memory.state === 'loading') {
			this.row(section, Codicon.loading, localize('picode.overview.memoryStarting', "Memory is starting…")).classList.add('running');
			return;
		}
		if (memory.state === 'unavailable') {
			const row = this.row(section, Codicon.warning, localize('picode.overview.memoryDown', "Memory is not answering"));
			row.classList.add('attention');
			this.action(row, localize('picode.overview.memoryCheck', "Check"), () => void this.runMemoryCommand(MEMORY_CHECK_COMMAND));
			return;
		}
		const heading = this.row(section, Codicon.database, memory.heading ?? '', memory.detail);
		if (memory.newerEngine) {
			this.action(heading, localize('picode.overview.memoryUpdate', "Update"), () => void this.runMemoryCommand(MEMORY_UPDATE_COMMAND));
		}
		if (memory.search) {
			const results = this.row(section, Codicon.search, localize('picode.overview.memoryResults', "“{0}”", memory.search.query));
			append(results, $('span.picode-overview-value')).textContent = `${memory.search.total}${memory.search.capped ? '+' : ''}`;
			this.action(results, localize('picode.overview.memoryClear', "Clear"), () => void this.runMemoryCommand(MEMORY_CLEAR_SEARCH_COMMAND));
			for (const hit of memory.search.rows) {
				const row = this.row(section, ThemeIcon.fromId(hit.icon), hit.title, hit.when || undefined);
				row.classList.add('nested');
				this.clickable(row, () => void this.commandService.executeCommand(MEMORY_OPEN_COMMAND, { id: hit.id }), hit.project);
			}
			if (memory.search.emptyLabel) {
				this.row(section, Codicon.circleSlash, memory.search.emptyLabel).classList.add('nested');
			}
			if (memory.search.moreLabel) {
				this.moreRow(section, memory.search.moreLabel);
			}
		} else {
			for (const project of memory.projects ?? []) {
				const row = this.row(section, project.open ? Codicon.folderOpened : Codicon.folder, project.name);
				// With one project the heading already says how many memories there are.
				if ((memory.projects?.length ?? 0) > 1) {
					append(row, $('span.picode-overview-value')).textContent = String(project.memories);
				}
				this.clickable(row, () => void this.runMemoryCommand(MEMORY_TOGGLE_PROJECT_COMMAND, project.name));
				for (const hit of project.open ? project.rows ?? [] : []) {
					const memoryRow = this.row(section, ThemeIcon.fromId(hit.icon), hit.title, hit.when || undefined);
					memoryRow.classList.add('nested');
					this.clickable(memoryRow, () => void this.commandService.executeCommand(MEMORY_OPEN_COMMAND, { id: hit.id }));
				}
				if (project.open && project.emptyLabel) {
					this.row(section, Codicon.circleSlash, project.emptyLabel).classList.add('nested');
				}
				if (project.open && project.moreLabel) {
					this.moreRow(section, project.moreLabel, project.name);
				}
			}
		}
		const search = this.row(section, Codicon.search, localize('picode.overview.memorySearch', "Search memories…"));
		this.clickable(search, () => void this.runMemoryCommand(MEMORY_SEARCH_COMMAND));
		if (memory.filter) {
			const filter = this.row(section, Codicon.filter, memory.filter.label, memory.filter.detail);
			this.clickable(filter, () => void this.runMemoryCommand(MEMORY_FILTER_COMMAND));
			if (memory.filter.clearLabel) {
				this.action(filter, memory.filter.clearLabel, () => void this.runMemoryCommand(MEMORY_CLEAR_FILTER_COMMAND));
			}
		}
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
		// Pressed again while the changes are open: close them instead of refreshing.
		if (previous && this.editorService.findEditors(previous).length > 0) {
			await this.editorService.closeEditors(this.editorService.findEditors(previous));
			return;
		}
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
