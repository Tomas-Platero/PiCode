/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Memory block of the PiCode panel: what the engine holds, read without leaving the editor.
 *
 * It is a **view of the existing container**, like Host or MCP servers — no second panel, no page
 * of settings, no window of its own. The rows answer three questions in the order a person asks
 * them: what is in here (the counts), where (the projects), and what exactly (the memory, in a tab
 * of the editor).
 *
 * Two rules decide the shape of this file:
 *
 *  * **Nothing is invented.** A read that fails becomes one honest row ("not answering"), never an
 *    empty list that reads as "your memory is empty"; a session id never reaches the screen, only
 *    the name of the agent that wrote the memory.
 *  * **Nothing is fetched twice.** Projects, the review queue and conflicts arrive together; the
 *    memories of a project arrive when it is opened and stay cached until the next refresh. The
 *    engine has no working `offset`, so a further page asks for a longer list.
 *
 * The words are English, the icons are codicons, and the only number a folded block carries is in
 * its own rows — the editor draws the block's header, not us.
 */

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as os from 'os';
import { engramServerUrl } from './engram';
import { parseEngramHealth, parseEngramProjects } from './engram';
import { restartMemory } from './engram-activation';
import { compareVersions, fetchLatestRelease, installedEngineVersion, updateEngine } from './memory-update';
import type { EngramProject } from './engram';
import {
	memoryDetailMarkdown,
	memoryDoctorMarkdown,
	memoryWhen,
	parseMemoryConflicts,
	parseMemoryDetail,
	parseMemoryDoctor,
	parseMemoryReview,
	parseMemoryRows,
	type MemoryConflict,
	type MemoryConflictList,
	type MemoryReviewQueue,
	type MemoryRow
} from './memory-client';
import { isFiltering, matchesFilter, NO_FILTER, openProjects, remainingMemories, SEARCH_LIMIT, searchFilterParams, type MemoryFilter, type OpenFolder } from './memory-paging';
import { timed } from './perf-timings';

/** The view id, which the manifest also declares: the two must not drift. */
export const MEMORY_VIEW_ID = 'picode.status.memory';

export const MEMORY_REFRESH_COMMAND = 'picode.memory.refresh';
export const MEMORY_SEARCH_COMMAND = 'picode.memory.search';
export const MEMORY_CLEAR_SEARCH_COMMAND = 'picode.memory.clearSearch';
export const MEMORY_OPEN_COMMAND = 'picode.memory.open';
export const MEMORY_SHOW_MORE_COMMAND = 'picode.memory.showMore';
export const MEMORY_CHECK_COMMAND = 'picode.memory.check';
export const MEMORY_UPDATE_COMMAND = 'picode.memory.updateEngine';
export const MEMORY_COPY_COMMAND = 'picode.memory.copy';
export const MEMORY_DELETE_COMMAND = 'picode.memory.delete';

/** What the block shows, as plain data, for the Agent layout's status column. */
export const MEMORY_SUMMARY_COMMAND = 'picode.memory.summary';

/** Chooses what the lists and the search show, and lets it all through again. */
export const MEMORY_FILTER_COMMAND = 'picode.memory.filter';
export const MEMORY_CLEAR_FILTER_COMMAND = 'picode.memory.clearFilter';

/** One more stretch of a list in the status column: a project's, or the search's without a project. */
export const MEMORY_SHOW_MORE_IN_COLUMN_COMMAND = 'picode.memory.showMoreInColumn';

/** How old the block's last reading may be before the status column asks for a fresh one. */
const SUMMARY_STALE_MS = 30_000;

/** The context key that makes the "clear search" button appear only while a search is on. */
export const MEMORY_SEARCH_CONTEXT = 'picode.memory.searchActive';

/**
 * The context key the block hangs on, written from the setting of the same name: turned off, the
 * block is not there at all. A block that stayed, empty, explaining that memory was switched off
 * would be one more row to skip past for the rest of the installation's life.
 */
export const MEMORY_ENABLED_CONTEXT = 'picode.memory.enabled';

/** How many memories one page of a project holds. */
const PAGE_SIZE = 50;

/** How many rows of a list the status column shows at a time. */
const COLUMN_PAGE = 20;

/** How much of a project is read while a filter is on: the engine cannot narrow by type or date, so the rows are narrowed here. */
const FILTERED_READ = 500;

/** How many conflicts are resolved to their titles when the group is opened. */
const CONFLICT_TITLES = 10;

/** A count of memories, singular or plural, as one translatable message. */
function memoryCount(total: number): string {
	return total === 1 ? vscode.l10n.t('{0} memory', total) : vscode.l10n.t('{0} memories', total);
}

/** A count of projects, singular or plural, as one translatable message. */
function projectCount(total: number): string {
	return total === 1 ? vscode.l10n.t('{0} project', total) : vscode.l10n.t('{0} projects', total);
}

type MemoryNode =
	| { readonly kind: 'heading' }
	| { readonly kind: 'message'; readonly text: string }
	| { readonly kind: 'action'; readonly action: 'search' | 'clear' | 'check' | 'update' | 'filter' | 'clearFilter' }
	| { readonly kind: 'project'; readonly project: EngramProject }
	| { readonly kind: 'more'; readonly project: string; readonly remaining: number }
	| { readonly kind: 'memory'; readonly row: MemoryRow; readonly showProject?: boolean }
	| { readonly kind: 'section'; readonly section: 'search' | 'review' | 'conflicts'; readonly count: number }
	| { readonly kind: 'conflict'; readonly conflict: MemoryConflict; readonly titles?: readonly [string, string] };

type MemoryData =
	| { readonly kind: 'loading' }
	| { readonly kind: 'unavailable' }
	| {
		readonly kind: 'ready';
		readonly total: number;
		readonly projects: readonly EngramProject[];
		readonly review?: MemoryReviewQueue;
		readonly conflicts?: MemoryConflictList;
		/** What the engine says it is, and when the newest memory was written. */
		readonly version?: string;
		readonly lastSaved?: string;
		/** The newer engine version, only once one is known to exist. */
		readonly newerEngine?: string;
	};

/** One icon per kind of memory, because a row's icon is read before its title is. */
function memoryTypeIcon(type: string): string {
	switch (type.toLowerCase()) {
		case 'decision':
			return 'lightbulb';
		case 'session-summary':
			return 'history';
		case 'bugfix':
			return 'bug';
		case 'pattern':
			return 'note';
		case 'preference':
			return 'settings-gear';
		case 'learning':
			return 'book';
		case 'discovery':
			return 'search';
		default:
			return 'circle-small-filled';
	}
}

/** What a search answered, and whether a project's answer hit the engine's ceiling. */
interface MemorySearch {
	readonly query: string;
	readonly rows: readonly MemoryRow[];
	readonly capped: boolean;
}

/** The choices of the filter, in the words the person reads; the types are the engine's. */
function filterChoices(): { readonly group: 'type' | 'scope' | 'days'; readonly value: string; readonly label: string }[] {
	return [
		{ group: 'type', value: 'decision', label: vscode.l10n.t('Decisions') },
		{ group: 'type', value: 'bugfix', label: vscode.l10n.t('Bug fixes') },
		{ group: 'type', value: 'pattern', label: vscode.l10n.t('Patterns') },
		{ group: 'type', value: 'preference', label: vscode.l10n.t('Preferences') },
		{ group: 'type', value: 'learning', label: vscode.l10n.t('Learnings') },
		{ group: 'type', value: 'discovery', label: vscode.l10n.t('Discoveries') },
		{ group: 'type', value: 'session-summary', label: vscode.l10n.t('Session summaries') },
		{ group: 'scope', value: 'project', label: vscode.l10n.t('Project') },
		{ group: 'scope', value: 'personal', label: vscode.l10n.t('Personal') },
		{ group: 'scope', value: 'global', label: vscode.l10n.t('Global') },
		{ group: 'days', value: '7', label: vscode.l10n.t('Last 7 days') },
		{ group: 'days', value: '30', label: vscode.l10n.t('Last 30 days') },
	];
}

/** The URL of a folder's `origin`, if it has one. */
function originOf(folder: string): Promise<string | undefined> {
	return new Promise(resolve => {
		try {
			execFile('git', ['config', '--get', 'remote.origin.url'], { cwd: folder, windowsHide: true, timeout: 5_000 }, (error, stdout) => resolve(error ? undefined : stdout));
		} catch {
			resolve(undefined);
		}
	});
}

/** One row as the status column draws it. */
function columnRow(row: MemoryRow) {
	return { id: row.id, title: row.title, project: row.project, when: memoryWhen(row.updatedAt) || memoryWhen(row.createdAt), icon: memoryTypeIcon(row.type) };
}

class MemoryProvider implements vscode.TreeDataProvider<MemoryNode> {
	private readonly changed = new vscode.EventEmitter<MemoryNode | undefined | void>();
	readonly onDidChangeTreeData = this.changed.event;

	private data: MemoryData = { kind: 'loading' };
	private loadedAt = 0;
	private readonly pages = new Map<string, number>();
	private readonly rows = new Map<string, readonly MemoryRow[]>();
	/** How long a list each project's `rows` was asked for: a shorter answer means it has no more. */
	private readonly askedFor = new Map<string, number>();
	/** How many rows the status column shows per project. */
	private readonly columnLimits = new Map<string, number>();
	private searchColumnLimit = COLUMN_PAGE;
	private filter: MemoryFilter = NO_FILTER;
	/** Bumped when the filter changes: a read begun under the old one must not fill the cache. */
	private filterEpoch = 0;
	/** Lives apart from `data`: a reading that fails or arrives late must not lose or revive it. */
	private activeSearch: MemorySearch | undefined;
	/** Only the newest reading publishes. */
	private loadSequence = 0;
	/** The store's project behind each open folder, as of the last reading. */
	private openProjectNames: readonly string[] | undefined;
	private readonly origins = new Map<string, Promise<string | undefined>>();
	private askingLatestEngine = false;
	private readonly titles = new Map<number, string>();
	/** Projects unfolded in the status column, whose memories its summary lists. */
	private readonly expanded = new Set<string>();
	private retried = false;
	/** The newest engine release, asked at most once an hour: GitHub rate-limits anonymous reads. */
	private latestEngine: { readonly version: string | undefined; readonly at: number } | undefined;

	/** The rows the filter lets through. */
	private visible(rows: readonly MemoryRow[]): readonly MemoryRow[] {
		if (!isFiltering(this.filter)) {
			return rows;
		}
		const now = Date.now();
		return rows.filter(row => matchesFilter(row, this.filter, now));
	}

	/** How long a list to ask a project for, at the least. */
	private readLimit(wanted: number): number {
		return isFiltering(this.filter) ? Math.max(wanted, FILTERED_READ) : wanted;
	}

	/** What is left to show of a project: a filter has already read all it can narrow. */
	private remainingIn(project: EngramProject, shown: number, passing: number, loaded: number): number {
		return isFiltering(this.filter) ? passing - shown : remainingMemories(shown, loaded, this.askedFor.get(project.name) ?? PAGE_SIZE, project.memories);
	}

	/** What the filter is set to, as the row beside it says it. */
	private filterDetail(): string | undefined {
		const on = filterChoices().filter(choice => choice.group === 'type' ? this.filter.types.includes(choice.value)
			: choice.group === 'scope' ? this.filter.scopes.includes(choice.value)
				: this.filter.days === Number(choice.value));
		return on.length === 0 ? undefined : on.map(choice => choice.label).join(' · ');
	}

	/** Asks what to show, in one list: several of a kind add up, and no choice on a side leaves it open. */
	async chooseFilter(): Promise<void> {
		const separator = (label: string): vscode.QuickPickItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
		const row = (choice: ReturnType<typeof filterChoices>[number], picked: boolean) => ({ label: choice.label, picked, choice });
		const choices = filterChoices();
		const items: (vscode.QuickPickItem & { choice?: ReturnType<typeof filterChoices>[number] })[] = [
			separator(vscode.l10n.t('Type')),
			...choices.filter(choice => choice.group === 'type').map(choice => row(choice, this.filter.types.includes(choice.value))),
			separator(vscode.l10n.t('Scope')),
			...choices.filter(choice => choice.group === 'scope').map(choice => row(choice, this.filter.scopes.includes(choice.value))),
			separator(vscode.l10n.t('Date')),
			...choices.filter(choice => choice.group === 'days').map(choice => row(choice, this.filter.days === Number(choice.value))),
		];
		const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: vscode.l10n.t('Show only these memories') });
		if (picked === undefined) {
			return;
		}
		const of = (group: string) => picked.flatMap(item => item.choice?.group === group ? [item.choice.value] : []);
		const days = of('days').map(Number);
		await this.setFilter({ types: of('type'), scopes: of('scope'), ...(days.length === 0 ? {} : { days: Math.max(...days) }) });
	}

	async clearFilter(): Promise<void> {
		await this.setFilter(NO_FILTER);
	}

	/** The lists are read again for the new filter, and a search asked again: its ceiling applies after the narrowing. */
	private async setFilter(filter: MemoryFilter): Promise<void> {
		this.filter = filter;
		this.filterEpoch++;
		this.rows.clear();
		this.askedFor.clear();
		this.columnLimits.clear();
		this.searchColumnLimit = COLUMN_PAGE;
		await this.load();
	}

	/** The folders this window has open: the only projects the panel shows. */
	private async openFolders(): Promise<OpenFolder[]> {
		return Promise.all((vscode.workspace.workspaceFolders ?? []).map(async folder => {
			const path = folder.uri.fsPath;
			let origin = this.origins.get(path);
			if (origin === undefined) {
				origin = originOf(path);
				this.origins.set(path, origin);
			}
			return { name: folder.name, remote: await origin };
		}));
	}

	/** The newer engine, from what is known now: an update already downloaded is not offered again, what is missing is the restart. */
	private newerEngine(installed: string | undefined): string | undefined {
		const latest = this.latestEngine?.version;
		if (installed === undefined || latest === undefined) {
			return undefined;
		}
		const downloaded = installedEngineVersion(os.homedir());
		const have = downloaded !== undefined && compareVersions(downloaded, installed) > 0 ? downloaded : installed;
		return compareVersions(have, latest) < 0 ? latest : undefined;
	}

	/** Asks GitHub in the background, at most once an hour, so a slow network never holds the counts back. */
	private async askLatestEngine(): Promise<void> {
		if (this.askingLatestEngine || (this.latestEngine !== undefined && Date.now() - this.latestEngine.at <= 3_600_000)) {
			return;
		}
		this.askingLatestEngine = true;
		let version: string | undefined;
		try {
			version = (await fetchLatestRelease())?.version;
		} catch {
			version = undefined;
		}
		this.askingLatestEngine = false;
		this.latestEngine = { version, at: Date.now() };
		if (this.data.kind === 'ready') {
			const newerEngine = this.newerEngine(this.data.version);
			if (newerEngine !== this.data.newerEngine) {
				this.data = { ...this.data, newerEngine };
				this.changed.fire();
			}
		}
	}

	/** A search limited to the open projects; the engine's answer is narrowed again here to be safe. */
	private async searchOpenProjects(query: string): Promise<Omit<MemorySearch, 'query'> | undefined> {
		const names = this.openProjectNames ?? (await this.openFolders()).map(folder => folder.name);
		if (names.length === 0) {
			return { rows: [], capped: false };
		}
		const answers = await Promise.all(names.map(name => this.getJson(`/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(name)}&limit=${SEARCH_LIMIT}${searchFilterParams(this.filter)}`)));
		if (answers.every(answer => answer === undefined)) {
			return undefined;
		}
		const wanted = new Set(names.map(name => name.toLowerCase()));
		const seen = new Set<number>();
		const rows: MemoryRow[] = [];
		let capped = false;
		for (const answer of answers) {
			const answered = parseMemoryRows(answer) ?? [];
			capped ||= answered.length >= SEARCH_LIMIT;
			for (const row of answered) {
				if (wanted.has(row.project.toLowerCase()) && !seen.has(row.id)) {
					seen.add(row.id);
					rows.push(row);
				}
			}
		}
		return { rows, capped };
	}

	dispose(): void {
		this.changed.dispose();
	}

	/** Reads the three facts the panel is grouped by, and keeps whatever search is on. */
	refresh(): void {
		this.pages.clear();
		this.rows.clear();
		this.askedFor.clear();
		this.columnLimits.clear();
		this.openProjectNames = undefined;
		void this.load();
	}

	private load(): Promise<void> {
		return timed('memory: reading', () => this.readAll());
	}

	private async readAll(): Promise<void> {
		const sequence = ++this.loadSequence;
		const [projectsJson, reviewJson, conflictsJson, healthJson, newestJson, folders] = await Promise.all([
			this.getJson('/projects'),
			this.getJson('/review'),
			this.getJson('/conflicts'),
			this.getJson('/health'),
			this.getJson('/observations?limit=1'),
			this.openFolders(),
		]);
		if (sequence !== this.loadSequence) {
			return;
		}
		const listed = parseEngramProjects(projectsJson);
		if (listed === undefined) {
			this.data = { kind: 'unavailable' };
			this.changed.fire();
			// The engine is started at activation and may still be waking: one retry, once, is
			// the difference between a panel that says "not answering" on every start and one
			// that simply fills a second later. A second failure is reported as it is.
			if (!this.retried) {
				this.retried = true;
				setTimeout(() => void this.load(), 2_000);
			}
			return;
		}
		// Only the folders open in this window, in the order they were opened; one with nothing saved yet still shows, at zero.
		const projects = openProjects(folders, listed.projects);
		this.openProjectNames = projects.map(project => project.name);
		// The status column's unfolded lists follow the counts beside them.
		const unfolded = projects.filter(project => this.expanded.has(project.name)).map(project => this.readProjectRows(project.name, this.askedFor.get(project.name) ?? this.readLimit(PAGE_SIZE)));
		// A search stays on across a refresh, and is asked again: a deleted memory must leave the
		// results, or the panel would keep handing out a row that no longer exists.
		const asked = this.activeSearch;
		const answered = asked === undefined ? undefined : await this.searchOpenProjects(asked.query);
		await Promise.all(unfolded);
		if (sequence !== this.loadSequence) {
			return;
		}
		// Cleared or replaced while the engine was answering: the person's last word stands.
		if (asked !== undefined && answered !== undefined && this.activeSearch?.query === asked.query) {
			this.activeSearch = { query: asked.query, ...answered };
		}
		const newest = parseMemoryRows(newestJson)?.[0];
		const version = parseEngramHealth(healthJson)?.version;
		this.data = {
			kind: 'ready',
			total: projects.reduce((sum, project) => sum + project.memories, 0),
			projects,
			newerEngine: this.newerEngine(version),
			review: parseMemoryReview(reviewJson),
			conflicts: parseMemoryConflicts(conflictsJson),
			version,
			lastSaved: newest === undefined ? undefined : newest.updatedAt || newest.createdAt,
		};
		this.loadedAt = Date.now();
		this.changed.fire();
		if (version !== undefined) {
			void this.askLatestEngine();
		}
	}

	/**
	 * The block as plain data: the heading's count and engine, the open projects, an active search's
	 * results, and whether the engine has a newer version. Reads again when the last reading is old,
	 * so the status column stays current with the tree folded away or hidden.
	 */
	summary(): object {
		if (Date.now() - this.loadedAt > SUMMARY_STALE_MS) {
			this.loadedAt = Date.now(); // one reading at a time
			void this.load();
		}
		const data = this.data;
		if (data.kind !== 'ready') {
			return { state: data.kind, retried: this.retried };
		}
		const search = this.activeSearch;
		const searchRows = search === undefined ? [] : this.visible(search.rows);
		return {
			state: 'ready',
			heading: data.total === 0 ? vscode.l10n.t('Nothing saved yet') : `${memoryCount(data.total)} · ${projectCount(data.projects.length)}`,
			detail: data.lastSaved === undefined ? undefined : vscode.l10n.t('last {0}', memoryWhen(data.lastSaved)),
			projects: data.projects.map(project => {
				const open = this.expanded.has(project.name);
				if (!open) {
					return { name: project.name, memories: project.memories, open };
				}
				if (!this.rows.has(project.name)) {
					void this.readProjectRows(project.name, this.readLimit(PAGE_SIZE));
				}
				const loaded = this.rows.get(project.name) ?? [];
				const passing = this.visible(loaded);
				const rows = passing.slice(0, this.columnLimits.get(project.name) ?? COLUMN_PAGE);
				const remaining = this.remainingIn(project, rows.length, passing.length, loaded.length);
				return {
					name: project.name,
					memories: project.memories,
					open,
					rows: rows.map(columnRow),
					emptyLabel: isFiltering(this.filter) && this.rows.has(project.name) && rows.length === 0 ? vscode.l10n.t('Nothing matches that.') : undefined,
					moreLabel: remaining > 0 ? vscode.l10n.t('Show {0} more', Math.min(COLUMN_PAGE, remaining)) : undefined,
				};
			}),
			search: search === undefined ? undefined : {
				query: search.query,
				rows: searchRows.slice(0, this.searchColumnLimit).map(columnRow),
				total: searchRows.length,
				capped: search.capped,
				emptyLabel: searchRows.length === 0 ? vscode.l10n.t('Nothing matches that.') : undefined,
				moreLabel: searchRows.length > this.searchColumnLimit ? vscode.l10n.t('Show {0} more', Math.min(COLUMN_PAGE, searchRows.length - this.searchColumnLimit)) : undefined,
			},
			filter: { label: vscode.l10n.t('Filter memories…'), detail: this.filterDetail(), clearLabel: isFiltering(this.filter) ? vscode.l10n.t('Clear filter') : undefined },
			newerEngine: data.newerEngine,
		};
	}

	/** One more stretch of a list in the status column; without a project, the search's. */
	async showMoreInColumn(project: string | undefined): Promise<void> {
		if (project === undefined) {
			this.searchColumnLimit += COLUMN_PAGE;
			return;
		}
		const limit = (this.columnLimits.get(project) ?? COLUMN_PAGE) + COLUMN_PAGE;
		this.columnLimits.set(project, limit);
		const asked = this.askedFor.get(project) ?? 0;
		if (limit > asked) {
			await this.readProjectRows(project, asked + PAGE_SIZE);
		}
	}

	getTreeItem(node: MemoryNode): vscode.TreeItem {
		switch (node.kind) {
			case 'heading': {
				const ready = this.data.kind === 'ready' ? this.data : undefined;
				const label = ready === undefined
					? vscode.l10n.t('Memory')
					: ready.total === 0
						? vscode.l10n.t('Nothing saved yet')
						: `${memoryCount(ready.total)} · ${projectCount(ready.projects.length)}`;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('database');
				item.contextValue = 'picode.memory.heading';
				// The engine and the last write, on the same line as the count: one row answers
				// "what is in here, and is it alive" without a second row saying the same thing.
				item.description = ready === undefined
					? undefined
					: [ready.version, ready.lastSaved === undefined ? '' : vscode.l10n.t('last {0}', memoryWhen(ready.lastSaved))]
						.filter(part => part !== '')
						.join(' · ') || undefined;
				item.tooltip = ready === undefined ? undefined : vscode.l10n.t('Everything this machine remembers, shared with any other agent using the same store.');
				return item;
			}
			case 'message': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('warning');
				return item;
			}
			case 'action': {
				const label = node.action === 'filter'
					? vscode.l10n.t('Filter memories…')
					: node.action === 'clearFilter'
						? vscode.l10n.t('Clear filter')
						: node.action === 'search'
					? vscode.l10n.t('Search memories…')
					: node.action === 'clear'
						? vscode.l10n.t('Clear search')
						: node.action === 'check'
							? vscode.l10n.t('Check memory')
							: vscode.l10n.t('Update memory engine');
				const icon = node.action === 'filter'
					? 'filter'
					: node.action === 'clearFilter'
						? 'clear-all'
						: node.action === 'search'
					? 'search'
					: node.action === 'clear'
						? 'close'
						: node.action === 'check'
							? 'pulse'
							: 'cloud-download';
				const command = node.action === 'filter'
					? MEMORY_FILTER_COMMAND
					: node.action === 'clearFilter'
						? MEMORY_CLEAR_FILTER_COMMAND
						: node.action === 'search'
					? MEMORY_SEARCH_COMMAND
					: node.action === 'clear'
						? MEMORY_CLEAR_SEARCH_COMMAND
						: node.action === 'check'
							? MEMORY_CHECK_COMMAND
							: MEMORY_UPDATE_COMMAND;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon(icon);
				item.command = { command, title: label };
				item.description = node.action === 'filter' ? this.filterDetail() : undefined;
				item.contextValue = 'picode.memory.action';
				return item;
			}
			case 'project': {
				const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = String(node.project.memories);
				item.iconPath = new vscode.ThemeIcon('folder');
				item.contextValue = 'picode.memory.project';
				item.tooltip = `${node.project.name} · ${memoryCount(node.project.memories)}`;
				return item;
			}
			case 'more': {
				const item = new vscode.TreeItem(vscode.l10n.t('Show {0} more', Math.min(PAGE_SIZE, node.remaining)), vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('ellipsis');
				item.command = { command: MEMORY_SHOW_MORE_COMMAND, title: vscode.l10n.t('Show more'), arguments: [node.project] };
				item.contextValue = 'picode.memory.action';
				return item;
			}
			case 'memory': {
				const when = memoryWhen(node.row.updatedAt) || memoryWhen(node.row.createdAt);
				const item = new vscode.TreeItem(node.row.title, vscode.TreeItemCollapsibleState.None);
				// The project is only said where the rows are not already under it: in a search or
				// the review queue, where a row can come from anywhere.
				item.description = [node.showProject === true ? node.row.project : '', when].filter(part => part !== '').join(' · ');
				item.iconPath = new vscode.ThemeIcon(memoryTypeIcon(node.row.type));
				item.tooltip = new vscode.MarkdownString(`**${node.row.title}**\n\n${node.row.type} · ${node.row.project}`);
				item.command = { command: MEMORY_OPEN_COMMAND, title: vscode.l10n.t('Open memory'), arguments: [node.row] };
				item.contextValue = 'picode.memory.row';
				return item;
			}
			case 'section': {
				const label = node.section === 'search'
					? vscode.l10n.t('Search results')
					: node.section === 'review'
						? vscode.l10n.t('Needs review')
						: vscode.l10n.t('Conflicts');
				const icon = node.section === 'search' ? 'search' : node.section === 'review' ? 'eye' : 'warning';
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
				item.description = node.section === 'search' && this.activeSearch?.capped ? `${node.count}+` : String(node.count);
				item.iconPath = new vscode.ThemeIcon(icon);
				item.contextValue = 'picode.memory.section';
				return item;
			}
			case 'conflict': {
				const [from, to] = node.titles ?? [`#${node.conflict.fromId}`, `#${node.conflict.toId}`];
				const item = new vscode.TreeItem(`${from} ↔ ${to}`, vscode.TreeItemCollapsibleState.None);
				item.description = node.conflict.relationType;
				item.iconPath = new vscode.ThemeIcon('warning');
				item.command = { command: MEMORY_OPEN_COMMAND, title: vscode.l10n.t('Open memory'), arguments: [{ id: node.conflict.fromId }] };
				item.contextValue = 'picode.memory.conflict';
				return item;
			}
		}
	}

	async getChildren(element?: MemoryNode): Promise<MemoryNode[]> {
		if (this.data.kind === 'loading') {
			return [];
		}
		if (this.data.kind === 'unavailable') {
			return [{ kind: 'message', text: this.retried ? vscode.l10n.t('Memory is not answering. The engine may have stopped.') : vscode.l10n.t('Memory is starting…') }];
		}
		const data = this.data;
		if (element === undefined) {
			const nodes: MemoryNode[] = [{ kind: 'heading' }];
			if (this.activeSearch !== undefined) {
				nodes.push({ kind: 'section', section: 'search', count: this.visible(this.activeSearch.rows).length });
			} else {
				nodes.push({ kind: 'action', action: 'search' });
			}
			nodes.push({ kind: 'action', action: 'filter' });
			if (isFiltering(this.filter)) {
				nodes.push({ kind: 'action', action: 'clearFilter' });
			}
			for (const project of data.projects) {
				nodes.push({ kind: 'project', project });
			}
			if (data.review !== undefined && data.review.count > 0) {
				nodes.push({ kind: 'section', section: 'review', count: data.review.count });
			}
			if (data.conflicts !== undefined && data.conflicts.total > 0) {
				nodes.push({ kind: 'section', section: 'conflicts', count: data.conflicts.total });
			}
			nodes.push({ kind: 'action', action: 'check' });
			if (data.newerEngine !== undefined) {
				nodes.push({ kind: 'action', action: 'update' });
			}
			return nodes;
		}
		switch (element.kind) {
			case 'project':
				return this.projectChildren(element.project);
			case 'section':
				if (element.section === 'search') {
					const rows = this.visible(this.activeSearch?.rows ?? []);
					return rows.length === 0
						? [{ kind: 'message', text: vscode.l10n.t('Nothing matches that.') }]
						: [...rows.map(row => ({ kind: 'memory' as const, row, showProject: true })), { kind: 'action', action: 'clear' as const }];
				}
				if (element.section === 'review') {
					return (data.review?.rows ?? []).map(row => ({ kind: 'memory' as const, row, showProject: true }));
				}
				return this.conflictChildren(data.conflicts);
			default:
				return [];
		}
	}

	/** A project's memories, fifty at a time, read once and kept until the next refresh. */
	private async projectChildren(project: EngramProject): Promise<MemoryNode[]> {
		const limit = (this.pages.get(project.name) ?? 1) * PAGE_SIZE;
		let rows = this.rows.get(project.name);
		if (rows === undefined || (this.askedFor.get(project.name) ?? 0) < limit) {
			rows = await this.readProjectRows(project.name, this.readLimit(limit));
			if (rows === undefined) {
				// A failed read is said as a failed read. Showing "nothing here yet" over a project
				// the engine counted a moment ago would be the panel telling a lie about memory.
				return [{ kind: 'message', text: vscode.l10n.t('These memories could not be read. Try again in a moment.') }];
			}
		}
		const passing = this.visible(rows);
		const nodes: MemoryNode[] = passing.slice(0, limit).map(row => ({ kind: 'memory' as const, row }));
		const remaining = this.remainingIn(project, nodes.length, passing.length, rows.length);
		if (remaining > 0) {
			nodes.push({ kind: 'more', project: project.name, remaining });
		}
		if (nodes.length === 0) {
			nodes.push({ kind: 'message', text: isFiltering(this.filter) ? vscode.l10n.t('Nothing matches that.') : vscode.l10n.t('Nothing here yet.') });
		}
		return nodes;
	}

	/** Conflicts with their two titles, fetched once: "decision A ↔ decision B" says something. */
	private async conflictChildren(conflicts: MemoryConflictList | undefined): Promise<MemoryNode[]> {
		const rows = (conflicts?.rows ?? []).slice(0, CONFLICT_TITLES);
		return Promise.all(rows.map(async conflict => {
			const [from, to] = await Promise.all([this.titleOf(conflict.fromId), this.titleOf(conflict.toId)]);
			return {
				kind: 'conflict' as const,
				conflict,
				titles: from === undefined || to === undefined ? undefined : [from, to] as const,
			};
		}));
	}

	private async titleOf(id: number): Promise<string | undefined> {
		const known = this.titles.get(id);
		if (known !== undefined) {
			return known;
		}
		const detail = parseMemoryDetail(await this.getJson(`/observations/${id}`));
		if (detail === undefined) {
			return undefined;
		}
		this.titles.set(id, detail.title);
		return detail.title;
	}

	/** A search's answer sits above the project rows while it is on. */
	async search(): Promise<void> {
		const current = this.activeSearch?.query;
		const query = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Search the memories of the projects open in this window'),
			placeHolder: vscode.l10n.t('a decision, a convention, a trap you hit before…'),
			value: current ?? '',
		});
		if (query === undefined || query.trim() === '') {
			return;
		}
		const answer = await this.searchOpenProjects(query.trim());
		if (answer === undefined) {
			void vscode.window.showWarningMessage(vscode.l10n.t('The memory engine did not answer the search. Nothing was changed.'));
			return;
		}
		this.activeSearch = { query: query.trim(), ...answer };
		this.searchColumnLimit = COLUMN_PAGE;
		await vscode.commands.executeCommand('setContext', MEMORY_SEARCH_CONTEXT, true);
		this.changed.fire();
	}

	async clearSearch(): Promise<void> {
		if (this.activeSearch === undefined) {
			return;
		}
		this.activeSearch = undefined;
		await vscode.commands.executeCommand('setContext', MEMORY_SEARCH_CONTEXT, false);
		this.changed.fire();
	}

	/** Unfolds or folds one project in the status column. */
	async toggleProject(project: string): Promise<void> {
		if (this.expanded.delete(project)) {
			return;
		}
		this.expanded.add(project);
		await this.readProjectRows(project, this.askedFor.get(project) ?? this.readLimit(PAGE_SIZE));
	}

	/** Reads one project's list and keeps it; a failed read leaves what was there. */
	private async readProjectRows(project: string, limit: number): Promise<readonly MemoryRow[] | undefined> {
		const epoch = this.filterEpoch;
		const json = await this.getJson(`/observations?project=${encodeURIComponent(project)}&limit=${limit}`);
		if (json === undefined) {
			return undefined;
		}
		const rows = parseMemoryRows(json) ?? [];
		if (epoch !== this.filterEpoch) {
			return rows;
		}
		this.rows.set(project, rows);
		this.askedFor.set(project, limit);
		return rows;
	}

	showMore(project: string): void {
		this.pages.set(project, (this.pages.get(project) ?? 1) + 1);
		this.changed.fire();
	}

	/** The memory itself, in a preview tab: the body as written, the facts underneath. */
	async open(row: Pick<MemoryRow, 'id'>): Promise<void> {
		const detail = parseMemoryDetail(await this.getJson(`/observations/${row.id}`));
		if (detail === undefined) {
			void vscode.window.showWarningMessage(vscode.l10n.t('That memory could not be read. It may have been removed since the list was read.'));
			return;
		}
		this.titles.set(detail.id, detail.title);
		const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: memoryDetailMarkdown(detail) });
		await vscode.window.showTextDocument(document, { preview: true });
	}

	/** The engine's own check, in a tab: what it looked at and what it found. */
	async openDoctor(): Promise<void> {
		const report = parseMemoryDoctor(await this.getJson('/doctor'));
		if (report === undefined) {
			void vscode.window.showWarningMessage(vscode.l10n.t('The memory engine did not answer its check.'));
			return;
		}
		const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: memoryDoctorMarkdown(report) });
		await vscode.window.showTextDocument(document, { preview: true });
	}

	/**
	 * Downloads a newer memory engine into the owner's profile and leaves the running one alone.
	 *
	 * Nothing here touches the store or the installation: the new binary lands in `~/.picode/memory`
	 * and is picked up on the next start. The engine is asked first, so a person who clicks on a
	 * whim learns what would happen before anything is downloaded.
	 */
	async updateEngine(): Promise<void> {
		const currentVersion = this.data.kind === 'ready' ? this.data.version : undefined;
		const result = await updateEngine({
			home: os.homedir(),
			currentVersion,
			confirm: async message => {
				const update = vscode.l10n.t('Update');
				const answer = await vscode.window.showInformationMessage(message, { modal: true }, update);
				return answer === update;
			},
			progress: line => console.log(`[memory] ${line}`)
		});
		if (result.ok && result.restart === true) {
			const restart = vscode.l10n.t('Restart engine');
			const answer = await vscode.window.showInformationMessage(result.message, restart);
			if (answer === restart) {
				await this.restartEngine();
			}
		} else if (result.ok) {
			void vscode.window.showInformationMessage(result.message);
		} else {
			void vscode.window.showWarningMessage(result.message);
		}
		this.refresh();
	}

	/** Starts the engine again so the downloaded version is the one that runs; one somebody else started is left alone. */
	private async restartEngine(): Promise<void> {
		const outcome = await restartMemory(line => console.log(`[memory] ${line}`));
		if (outcome === 'restarted') {
			void vscode.window.showInformationMessage(vscode.l10n.t('The memory engine was restarted.'));
		} else if (outcome === 'not-ours') {
			void vscode.window.showWarningMessage(vscode.l10n.t('The memory engine was started by another program, so PiCode does not stop it. Close all PiCode windows to use the new version.'));
		} else {
			void vscode.window.showWarningMessage(vscode.l10n.t('The memory engine did not start again.'));
		}
		this.refresh();
	}

	/** The memory as text, for pasting somewhere else: a title and its body, nothing of ours. */
	async copy(row: MemoryRow): Promise<void> {
		const detail = parseMemoryDetail(await this.getJson(`/observations/${row.id}`));
		if (detail === undefined) {
			void vscode.window.showWarningMessage(vscode.l10n.t('That memory could not be read, so nothing was copied.'));
			return;
		}
		await vscode.env.clipboard.writeText(`# ${detail.title}\n\n${detail.content.trim()}\n`);
		void vscode.window.showInformationMessage(vscode.l10n.t('Memory copied to the clipboard.'));
	}

	/**
	 * Deleting asks once, in the editor's own modal, and says what disappears.
	 *
	 * It is the only action here that cannot be undone from PiCode, so the confirmation names the
	 * memory instead of asking "are you sure?" about nothing.
	 */
	async remove(row: MemoryRow): Promise<void> {
		const remove = vscode.l10n.t('Delete');
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t('Delete “{0}” from memory?', row.title),
			{ modal: true, detail: vscode.l10n.t('It disappears from every agent that shares this memory. This cannot be undone here.') },
			remove
		);
		if (answer !== remove) {
			return;
		}
		const deleted = await this.send('DELETE', `/observations/${row.id}?expected_project=${encodeURIComponent(row.project)}`);
		if (!deleted) {
			void vscode.window.showWarningMessage(vscode.l10n.t('That memory could not be deleted. It may already be gone.'));
			return;
		}
		void vscode.window.showInformationMessage(vscode.l10n.t('Memory deleted.'));
		this.refresh();
	}

	/** One write, answered as a yes or a no — never a rejection, for the same reason reads never are. */
	private async send(method: 'DELETE', path: string): Promise<boolean> {
		try {
			const response = await fetch(`${engramServerUrl(process.env)}${path}`, { method, signal: AbortSignal.timeout(5_000) });
			return response.ok;
		} catch {
			return false;
		}
	}

	/** One read, never a rejection: a panel is not a place to throw. */
	private async getJson(path: string): Promise<unknown | undefined> {
		try {
			const response = await fetch(`${engramServerUrl(process.env)}${path}`, { signal: AbortSignal.timeout(5_000) });
			if (!response.ok) {
				return undefined;
			}
			return await response.json();
		} catch {
			return undefined;
		}
	}
}

/** Registers the block, its six actions and the one context key the clear button hangs on. */
export function registerMemoryView(): vscode.Disposable {
	const provider = new MemoryProvider();
	const view = vscode.window.createTreeView(MEMORY_VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

	void vscode.commands.executeCommand('setContext', MEMORY_SEARCH_CONTEXT, false);

	const disposables: vscode.Disposable[] = [
		provider,
		view,
		vscode.commands.registerCommand(MEMORY_REFRESH_COMMAND, () => provider.refresh()),
		vscode.commands.registerCommand(MEMORY_SUMMARY_COMMAND, () => provider.summary()),
		vscode.commands.registerCommand(MEMORY_FILTER_COMMAND, () => provider.chooseFilter()),
		vscode.commands.registerCommand(MEMORY_CLEAR_FILTER_COMMAND, () => provider.clearFilter()),
		vscode.commands.registerCommand(MEMORY_SHOW_MORE_IN_COLUMN_COMMAND, (project: string | undefined) => provider.showMoreInColumn(project)),
		vscode.commands.registerCommand(MEMORY_SEARCH_COMMAND, () => provider.search()),
		vscode.commands.registerCommand(MEMORY_CLEAR_SEARCH_COMMAND, () => provider.clearSearch()),
		vscode.commands.registerCommand('picode.memory.toggleProject', (project: string) => provider.toggleProject(project)),
		vscode.commands.registerCommand(MEMORY_OPEN_COMMAND, (row: Pick<MemoryRow, 'id'> | undefined) => {
			if (row !== undefined && typeof row.id === 'number') {
				return provider.open(row);
			}
			return undefined;
		}),
		vscode.commands.registerCommand(MEMORY_SHOW_MORE_COMMAND, (project: string | undefined) => {
			if (project !== undefined) {
				provider.showMore(project);
			}
		}),
		vscode.commands.registerCommand(MEMORY_CHECK_COMMAND, () => provider.openDoctor()),
		vscode.commands.registerCommand(MEMORY_UPDATE_COMMAND, () => provider.updateEngine()),
		vscode.commands.registerCommand(MEMORY_COPY_COMMAND, (row: MemoryRow | undefined) => {
			if (row !== undefined && typeof row.id === 'number') {
				return provider.copy(row);
			}
			return undefined;
		}),
		vscode.commands.registerCommand(MEMORY_DELETE_COMMAND, (row: MemoryRow | undefined) => {
			if (row !== undefined && typeof row.id === 'number') {
				return provider.remove(row);
			}
			return undefined;
		}),
		// Reading is what costs: with the block folded, nothing is asked of the engine. Opening it
		// re-reads once, so a memory saved by another agent meanwhile shows up without a reload.
		view.onDidChangeVisibility(event => {
			if (event.visible) {
				provider.refresh();
			}
		}),
		// The switch is a fact of the settings: flicked on, the block reads again; flicked off,
		// the manifest hides it and there is nothing left to read.
		// Other folders, other projects: what the last reading resolved no longer holds.
		vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('picode.memory.enabled')) {
				provider.refresh();
			}
		}),
	];

	// The first reading waits for the engine's start only as long as it has to: activation wakes it
	// in the background, and this is the same moment the view is being drawn.
	provider.refresh();
	return vscode.Disposable.from(...disposables);
}
