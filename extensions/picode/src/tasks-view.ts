/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Tasks block of the PiCode panel: the work the chat has out, in the place you look while
 * you are not looking at the chat.
 *
 * It is a **block of the existing container**, like Memory — no second panel, no page, no window.
 * What it shows is exactly what the chat cannot: a list that stays put while you work in another
 * file, a running job's clock, and the tasks the chat delegated to the durable agent, each one
 * opening to its own facts instead of to a transcript you have to scroll.
 *
 * Three rules decide the shape of this file:
 *
 *  * **Nothing is invented.** The jobs come from the tracker the pill above the chat input reads;
 *    the tasks from the daemon's own answer. A daemon that does not answer is said as a row, not
 *    drawn as "no work".
 *  * **Opening is not reading.** The block refreshes the work it lists every few seconds while it
 *    is visible and stops when it is folded away, so a panel that nobody is looking at does not
 *    keep asking the durable agent anything.
 *  * **The words are ours.** No endpoint, no socket, no conversation internals reach the screen;
 *    the conversation id stays in the tooltip, where the export command wants it.
 */

import * as vscode from 'vscode';
import { openDurableConversation, readDurableStatus, type DurableStatus } from './durable';
import { onDurableChange } from './durable-signal';
import type { BackgroundJobStatus } from './status-contract';
import { elapsedLabel, newestLine, taskBoard, taskDetail, taskState, taskTitle, type TaskBoard, type TaskRow } from './tasks-rows';

/** The view id, which the manifest also declares: the two must not drift. */
export const TASKS_VIEW_ID = 'picode.status.tasks';

export const TASKS_REFRESH_COMMAND = 'picode.tasks.refresh';
export const TASKS_OPEN_COMMAND = 'picode.tasks.open';

/**
 * How often a visible block asks again.
 *
 * The status surface reads the same daemon on the same cadence, so the two cannot disagree by
 * more than one tick. Folded away, the timer is cleared: the answer only matters when it is on
 * screen.
 */
const REFRESH_MS = 5_000;

type TasksNode =
	| { readonly kind: 'heading' }
	| { readonly kind: 'message'; readonly text: string }
	| { readonly kind: 'group'; readonly group: 'running' | 'idle'; readonly count: number }
	| { readonly kind: 'row'; readonly row: TaskRow }
	| { readonly kind: 'fact'; readonly label: string; readonly detail: string; readonly icon: string; readonly tooltip?: string }
	| { readonly kind: 'open'; readonly row: TaskRow };

type TasksData =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready'; readonly board: TaskBoard; readonly durable: DurableStatus };

/** Where the block reads from. The jobs are the chat's own tracker, not a copy of it. */
export interface TasksViewDeps {
	readonly runningJobs: () => readonly BackgroundJobStatus[];
	/** What "now" is, so the tests can hold a clock still. */
	readonly now?: () => number;
}

/** One icon per kind of row: a row's icon is read before its label is. */
function rowIcon(row: TaskRow): string {
	if (row.kind === 'job') {
		return 'terminal';
	}
	if (row.work.inFlight === undefined) {
		return 'question';
	}
	return row.work.inFlight ? 'sync' : 'circle-outline';
}

class TasksProvider implements vscode.TreeDataProvider<TasksNode> {
	private readonly changed = new vscode.EventEmitter<TasksNode | undefined | void>();
	readonly onDidChangeTreeData = this.changed.event;

	private data: TasksData = { kind: 'loading' };
	private timer: ReturnType<typeof setInterval> | undefined;
	private reading = false;

	constructor(private readonly deps: TasksViewDeps) { }

	dispose(): void {
		this.stopTicking();
		this.changed.dispose();
	}

	/**
	 * Refreshes only while the block is on screen.
	 *
	 * The transcript tab announces a run starting or ending; folding the answer away means the
	 * block is not asking, and a notification must not start it asking behind the owner's back.
	 */
	refreshIfVisible(): void {
		if (this.timer !== undefined) {
			this.refresh();
		}
	}

	/** Reads the board. The previous answer stays on screen while the new one is read. */
	refresh(): void {
		if (this.reading) {
			return;
		}
		this.reading = true;
		void this.load();
	}

	/** Starts asking again: called when the block is opened, and only then. */
	startTicking(): void {
		this.stopTicking();
		this.refresh();
		this.timer = setInterval(() => this.refresh(), REFRESH_MS);
	}

	/** Stops asking: the block was folded away, or the window is going. */
	stopTicking(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async load(): Promise<void> {
		try {
			const jobs = this.deps.runningJobs();
			const durable = await readDurableStatus();
			this.data = { kind: 'ready', board: taskBoard(jobs, durable.work), durable };
		} catch (error) {
			// `readDurableStatus` answers a down daemon as data, so this is the unexpected case:
			// one honest row rather than a block that silently keeps its last answer forever.
			this.data = {
				kind: 'ready',
				board: taskBoard(this.deps.runningJobs(), undefined),
				durable: { up: false, endpoint: '', error: error instanceof Error ? error.message : String(error) },
			};
		} finally {
			this.reading = false;
			this.changed.fire();
		}
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	getTreeItem(node: TasksNode): vscode.TreeItem {
		switch (node.kind) {
			case 'heading': {
				const board = this.data.kind === 'ready' ? this.data.board : undefined;
				const label = board === undefined
					? 'Tasks'
					: board.total === 0
						? 'Nothing running'
						: `${board.running.length} running · ${board.idle.length} idle`;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('dashboard');
				item.contextValue = 'picode.tasks.heading';
				item.tooltip = 'The work the chat has out: background jobs it launched, and the tasks it handed to the durable agent.';
				return item;
			}
			case 'message': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('warning');
				item.contextValue = 'picode.tasks.message';
				return item;
			}
			case 'group': {
				const label = node.group === 'running' ? 'Running' : 'Waiting';
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
				item.description = String(node.count);
				item.iconPath = new vscode.ThemeIcon(node.group === 'running' ? 'sync' : 'clock');
				item.contextValue = 'picode.tasks.group';
				item.tooltip = node.group === 'running'
					? 'Happening now: the chat\'s background jobs and the tasks with a run in flight.'
					: 'Tasks that exist and are quiet. Open one to see what it holds.';
				return item;
			}
			case 'row': {
				const item = new vscode.TreeItem(taskTitle(node.row), vscode.TreeItemCollapsibleState.Collapsed);
				item.description = taskDetail(node.row, this.now());
				item.iconPath = new vscode.ThemeIcon(rowIcon(node.row));
				item.contextValue = node.row.kind === 'job' ? 'picode.tasks.job' : 'picode.tasks.task';
				if (node.row.kind === 'job') {
					item.tooltip = node.row.job.command === undefined
						? 'A background job of this chat; its report lands in the conversation when it ends.'
						: `${node.row.job.command}\n\nA background job of this chat; its report lands in the conversation when it ends.`;
				} else {
					item.tooltip = `Durable task in conversation ${node.row.work.conversationId}. A task is work the chat handed to the durable agent — one per batch of several things to do.`;
					item.command = { command: TASKS_OPEN_COMMAND, title: 'Open the task', arguments: [node.row] };
				}
				return item;
			}
			case 'fact': {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.description = node.detail;
				item.iconPath = new vscode.ThemeIcon(node.icon);
				item.contextValue = 'picode.tasks.fact';
				if (node.tooltip !== undefined) {
					item.tooltip = node.tooltip;
				}
				return item;
			}
			case 'open': {
				const item = new vscode.TreeItem('Open the transcript', vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('comment-discussion');
				item.contextValue = 'picode.tasks.open';
				item.command = { command: TASKS_OPEN_COMMAND, title: 'Open the task', arguments: [node.row] };
				item.tooltip = 'What this task holds, in a tab of its own.';
				return item;
			}
		}
	}

	getChildren(node?: TasksNode): TasksNode[] {
		if (node === undefined) {
			return this.root();
		}
		switch (node.kind) {
			case 'group': {
				const board = this.data.kind === 'ready' ? this.data.board : undefined;
				const rows = node.group === 'running' ? board?.running ?? [] : board?.idle ?? [];
				return rows.map(row => ({ kind: 'row', row }));
			}
			case 'row':
				return this.details(node.row);
			default:
				return [];
		}
	}

	private root(): TasksNode[] {
		const nodes: TasksNode[] = [{ kind: 'heading' }];
		if (this.data.kind === 'loading') {
			return nodes;
		}
		const { board, durable } = this.data;
		// The daemon down is not "no tasks": the jobs are still readable, and the tasks are not.
		if (!durable.up) {
			nodes.push({ kind: 'message', text: 'The durable agent is not answering, so its tasks cannot be listed.' });
		}
		if (board.running.length > 0) {
			nodes.push({ kind: 'group', group: 'running', count: board.running.length });
		}
		if (board.idle.length > 0) {
			nodes.push({ kind: 'group', group: 'idle', count: board.idle.length });
		}
		if (board.total === 0) {
			nodes.push({ kind: 'message', text: durable.up ? 'No work in flight.' : 'No background jobs running.' });
		}
		return nodes;
	}

	/** What a row opens to: the facts a person asks about work they did not start themselves. */
	private details(row: TaskRow): TasksNode[] {
		if (row.kind === 'job') {
			const facts: TasksNode[] = [
				{ kind: 'fact', label: 'Running for', detail: elapsedLabel(row.job.startedAt, this.now()), icon: 'watch' },
			];
			if (row.job.command !== undefined) {
				facts.push({ kind: 'fact', label: 'Command', detail: row.job.command, icon: 'symbol-field', tooltip: row.job.command });
			}
			return facts;
		}
		const work = row.work;
		const facts: TasksNode[] = [
			{ kind: 'fact', label: 'State', detail: taskState(row), icon: rowIcon(row) },
			{ kind: 'fact', label: 'Entries', detail: String(work.entries), icon: 'list-ordered' },
			{ kind: 'fact', label: 'Conversation', detail: String(work.conversationId), icon: 'comment-discussion' },
		];
		const newest = newestLine(work.newest);
		if (newest !== undefined) {
			facts.push({ kind: 'fact', label: 'Newest', detail: newest, icon: 'history', tooltip: work.newest });
		}
		facts.push({ kind: 'open', row });
		return facts;
	}
}

/** Registers the block and its two actions. */
export function registerTasksView(deps: TasksViewDeps): vscode.Disposable {
	const provider = new TasksProvider(deps);
	const view = vscode.window.createTreeView(TASKS_VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

	const disposables: vscode.Disposable[] = [
		provider,
		view,
		vscode.commands.registerCommand(TASKS_REFRESH_COMMAND, () => provider.refresh()),
		// The tab is event-driven and this block is polled: without this, a finished run kept this
		// row at "running" for up to one tick. The listener asks the daemon again — it carries no state.
		{ dispose: onDurableChange(() => provider.refreshIfVisible()) },
		vscode.commands.registerCommand(TASKS_OPEN_COMMAND, (row: TaskRow | undefined) => {
			if (row === undefined || row.kind !== 'task') {
				return undefined;
			}
			return openDurableConversation(row.work.conversationId);
		}),
		// Reading costs, so the clock runs only while the block is on screen: opening it reads
		// once and keeps asking; folding it away stops everything and leaves the last answer.
		view.onDidChangeVisibility(event => {
			if (event.visible) {
				provider.startTicking();
			} else {
				provider.stopTicking();
			}
		}),
	];

	if (view.visible) {
		provider.startTicking();
	}
	return vscode.Disposable.from(...disposables);
}
