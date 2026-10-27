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
 *    memories of a project arrive when it is opened, fifty at a time, and stay cached until the
 *    next refresh.
 *
 * The words are English, the icons are codicons, and the only number a folded block carries is in
 * its own rows — the editor draws the block's header, not us.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import { engramServerUrl } from './engram';
import { parseEngramHealth, parseEngramProjects } from './engram';
import { updateEngine } from './memory-update';
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

/** How many conflicts are resolved to their titles when the group is opened. */
const CONFLICT_TITLES = 10;

type MemoryNode =
	| { readonly kind: 'heading' }
	| { readonly kind: 'message'; readonly text: string }
	| { readonly kind: 'action'; readonly action: 'search' | 'clear' | 'check' | 'update' }
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
		readonly search?: { readonly query: string; readonly rows: readonly MemoryRow[] };
		/** What the engine says it is, and when the newest memory was written. */
		readonly version?: string;
		readonly lastSaved?: string;
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

class MemoryProvider implements vscode.TreeDataProvider<MemoryNode> {
	private readonly changed = new vscode.EventEmitter<MemoryNode | undefined | void>();
	readonly onDidChangeTreeData = this.changed.event;

	private data: MemoryData = { kind: 'loading' };
	private readonly pages = new Map<string, number>();
	private readonly rows = new Map<string, readonly MemoryRow[]>();
	private readonly titles = new Map<number, string>();
	private retried = false;

	dispose(): void {
		this.changed.dispose();
	}

	/** Reads the three facts the panel is grouped by, and keeps whatever search is on. */
	refresh(): void {
		this.pages.clear();
		this.rows.clear();
		void this.load();
	}

	private async load(): Promise<void> {
		const previous = this.data.kind === 'ready' ? this.data.search : undefined;
		const [projectsJson, reviewJson, conflictsJson, healthJson, newestJson] = await Promise.all([
			this.getJson('/projects'),
			this.getJson('/review'),
			this.getJson('/conflicts'),
			this.getJson('/health'),
			this.getJson('/observations?limit=1'),
		]);
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
		// A search stays on across a refresh, and is asked again: a deleted memory must leave the
		// results, or the panel would keep handing out a row that no longer exists.
		let search = previous;
		if (previous !== undefined) {
			const answered = await this.getJson(`/search?q=${encodeURIComponent(previous.query)}`);
			if (answered !== undefined) {
				search = { query: previous.query, rows: parseMemoryRows(answered) ?? [] };
			}
		}
		const newest = parseMemoryRows(newestJson)?.[0];
		this.data = {
			kind: 'ready',
			total: listed.total,
			projects: [...listed.projects].sort((a, b) => b.memories - a.memories || a.name.localeCompare(b.name)),
			review: parseMemoryReview(reviewJson),
			conflicts: parseMemoryConflicts(conflictsJson),
			search,
			version: parseEngramHealth(healthJson)?.version,
			lastSaved: newest === undefined ? undefined : newest.updatedAt || newest.createdAt,
		};
		this.changed.fire();
	}

	getTreeItem(node: MemoryNode): vscode.TreeItem {
		switch (node.kind) {
			case 'heading': {
				const ready = this.data.kind === 'ready' ? this.data : undefined;
				const label = ready === undefined
					? 'Memory'
					: ready.total === 0
						? 'Nothing saved yet'
						: `${ready.total} ${ready.total === 1 ? 'memory' : 'memories'} · ${ready.projects.length} ${ready.projects.length === 1 ? 'project' : 'projects'}`;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('database');
				item.contextValue = 'picode.memory.heading';
				// The engine and the last write, on the same line as the count: one row answers
				// "what is in here, and is it alive" without a second row saying the same thing.
				item.description = ready === undefined
					? undefined
					: [ready.version, ready.lastSaved === undefined ? '' : `last ${memoryWhen(ready.lastSaved)}`]
						.filter(part => part !== '')
						.join(' · ') || undefined;
				item.tooltip = ready === undefined ? undefined : 'Everything this machine remembers, shared with any other agent using the same store.';
				return item;
			}
			case 'message': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('warning');
				return item;
			}
			case 'action': {
				const label = node.action === 'search'
					? 'Search memories…'
					: node.action === 'clear'
						? 'Clear search'
						: node.action === 'check'
							? 'Check memory'
							: 'Update memory engine…';
				const icon = node.action === 'search'
					? 'search'
					: node.action === 'clear'
						? 'close'
						: node.action === 'check'
							? 'pulse'
							: 'cloud-download';
				const command = node.action === 'search'
					? MEMORY_SEARCH_COMMAND
					: node.action === 'clear'
						? MEMORY_CLEAR_SEARCH_COMMAND
						: node.action === 'check'
							? MEMORY_CHECK_COMMAND
							: MEMORY_UPDATE_COMMAND;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon(icon);
				item.command = { command, title: label };
				item.contextValue = 'picode.memory.action';
				return item;
			}
			case 'project': {
				const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = String(node.project.memories);
				item.iconPath = new vscode.ThemeIcon('folder');
				item.contextValue = 'picode.memory.project';
				item.tooltip = `${node.project.name} · ${node.project.memories} ${node.project.memories === 1 ? 'memory' : 'memories'}`;
				return item;
			}
			case 'more': {
				const item = new vscode.TreeItem(`Show ${Math.min(PAGE_SIZE, node.remaining)} more`, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('ellipsis');
				item.command = { command: MEMORY_SHOW_MORE_COMMAND, title: 'Show more', arguments: [node.project] };
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
				item.command = { command: MEMORY_OPEN_COMMAND, title: 'Open memory', arguments: [node.row] };
				item.contextValue = 'picode.memory.row';
				return item;
			}
			case 'section': {
				const label = node.section === 'search'
					? 'Search results'
					: node.section === 'review'
						? 'Needs review'
						: 'Conflicts';
				const icon = node.section === 'search' ? 'search' : node.section === 'review' ? 'eye' : 'warning';
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
				item.description = String(node.count);
				item.iconPath = new vscode.ThemeIcon(icon);
				item.contextValue = 'picode.memory.section';
				return item;
			}
			case 'conflict': {
				const [from, to] = node.titles ?? [`#${node.conflict.fromId}`, `#${node.conflict.toId}`];
				const item = new vscode.TreeItem(`${from} ↔ ${to}`, vscode.TreeItemCollapsibleState.None);
				item.description = node.conflict.relationType;
				item.iconPath = new vscode.ThemeIcon('warning');
				item.command = { command: MEMORY_OPEN_COMMAND, title: 'Open memory', arguments: [{ id: node.conflict.fromId }] };
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
			return [{ kind: 'message', text: this.retried ? 'Memory is not answering. The engine may have stopped.' : 'Memory is starting…' }];
		}
		const data = this.data;
		if (element === undefined) {
			const nodes: MemoryNode[] = [{ kind: 'heading' }];
			if (data.search !== undefined) {
				nodes.push({ kind: 'section', section: 'search', count: data.search.rows.length });
			} else {
				nodes.push({ kind: 'action', action: 'search' });
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
			nodes.push({ kind: 'action', action: 'update' });
			return nodes;
		}
		switch (element.kind) {
			case 'project':
				return this.projectChildren(element.project);
			case 'section':
				if (element.section === 'search') {
					const rows = data.search?.rows ?? [];
					return rows.length === 0
						? [{ kind: 'message', text: 'Nothing matches that.' }]
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
		const page = this.pages.get(project.name) ?? 1;
		const limit = page * PAGE_SIZE;
		let rows = this.rows.get(project.name);
		if (rows === undefined || rows.length < limit) {
			const json = await this.getJson(`/observations?project=${encodeURIComponent(project.name)}&limit=${limit}`);
			if (json === undefined) {
				// A failed read is said as a failed read. Showing "nothing here yet" over a project
				// the engine counted a moment ago would be the panel telling a lie about memory.
				return [{ kind: 'message', text: 'These memories could not be read. Try again in a moment.' }];
			}
			rows = parseMemoryRows(json) ?? [];
			this.rows.set(project.name, rows);
		}
		const nodes: MemoryNode[] = rows.slice(0, limit).map(row => ({ kind: 'memory' as const, row }));
		if (project.memories > nodes.length) {
			nodes.push({ kind: 'more', project: project.name, remaining: project.memories - nodes.length });
		}
		if (nodes.length === 0) {
			nodes.push({ kind: 'message', text: 'Nothing here yet.' });
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

	/** A search replaces the project rows while it is on: the answer, where the question was. */
	async search(): Promise<void> {
		const current = this.data.kind === 'ready' ? this.data.search?.query : undefined;
		const query = await vscode.window.showInputBox({
			prompt: 'Search everything this machine remembers',
			placeHolder: 'a decision, a convention, a trap you hit before…',
			value: current ?? '',
		});
		if (query === undefined || query.trim() === '') {
			return;
		}
		const json = await this.getJson(`/search?q=${encodeURIComponent(query.trim())}`);
		if (json === undefined) {
			void vscode.window.showWarningMessage('The memory engine did not answer the search. Nothing was changed.');
			return;
		}
		const rows = parseMemoryRows(json) ?? [];
		if (this.data.kind !== 'ready') {
			return;
		}
		this.data = { ...this.data, search: { query: query.trim(), rows } };
		await vscode.commands.executeCommand('setContext', MEMORY_SEARCH_CONTEXT, true);
		this.changed.fire();
	}

	async clearSearch(): Promise<void> {
		if (this.data.kind !== 'ready' || this.data.search === undefined) {
			return;
		}
		this.data = { ...this.data, search: undefined };
		await vscode.commands.executeCommand('setContext', MEMORY_SEARCH_CONTEXT, false);
		this.changed.fire();
	}

	showMore(project: string): void {
		this.pages.set(project, (this.pages.get(project) ?? 1) + 1);
		this.changed.fire();
	}

	/** The memory itself, in a preview tab: the body as written, the facts underneath. */
	async open(row: Pick<MemoryRow, 'id'>): Promise<void> {
		const detail = parseMemoryDetail(await this.getJson(`/observations/${row.id}`));
		if (detail === undefined) {
			void vscode.window.showWarningMessage('That memory could not be read. It may have been removed since the list was read.');
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
			void vscode.window.showWarningMessage('The memory engine did not answer its check.');
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
				const answer = await vscode.window.showInformationMessage(message, { modal: true }, 'Update', 'Cancel');
				return answer === 'Update';
			},
			progress: line => console.log(`[memory] ${line}`)
		});
		if (result.ok) {
			void vscode.window.showInformationMessage(result.message);
		} else {
			void vscode.window.showWarningMessage(result.message);
		}
		this.refresh();
	}

	/** The memory as text, for pasting somewhere else: a title and its body, nothing of ours. */
	async copy(row: MemoryRow): Promise<void> {
		const detail = parseMemoryDetail(await this.getJson(`/observations/${row.id}`));
		if (detail === undefined) {
			void vscode.window.showWarningMessage('That memory could not be read, so nothing was copied.');
			return;
		}
		await vscode.env.clipboard.writeText(`# ${detail.title}\n\n${detail.content.trim()}\n`);
		void vscode.window.showInformationMessage('Memory copied to the clipboard.');
	}

	/**
	 * Deleting asks once, in the editor's own modal, and says what disappears.
	 *
	 * It is the only action here that cannot be undone from PiCode, so the confirmation names the
	 * memory instead of asking "are you sure?" about nothing.
	 */
	async remove(row: MemoryRow): Promise<void> {
		const answer = await vscode.window.showWarningMessage(
			`Delete “${row.title}” from memory?`,
			{ modal: true, detail: 'It disappears from every agent that shares this memory. This cannot be undone here.' },
			'Delete'
		);
		if (answer !== 'Delete') {
			return;
		}
		const deleted = await this.send('DELETE', `/observations/${row.id}?expected_project=${encodeURIComponent(row.project)}`);
		if (!deleted) {
			void vscode.window.showWarningMessage('That memory could not be deleted. It may already be gone.');
			return;
		}
		void vscode.window.showInformationMessage('Memory deleted.');
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
		vscode.commands.registerCommand(MEMORY_SEARCH_COMMAND, () => provider.search()),
		vscode.commands.registerCommand(MEMORY_CLEAR_SEARCH_COMMAND, () => provider.clearSearch()),
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
