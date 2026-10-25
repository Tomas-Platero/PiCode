/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Tasks block of the PiCode panel: the work the chat has out, in the place you look while
 * you are not looking at the chat.
 *
 * It is a **block of the existing container**, like Memory — no second panel, no page, no window.
 * What it shows is exactly what the chat cannot: a list that stays put while you work in another
 * file, and a running job's clock.
 *
 * Two rules decide the shape of this file:
 *
 *  * **Nothing is invented.** The jobs come from the tracker the pill above the chat input reads.
 *  * **Opening is not reading.** The block refreshes while it is visible and stops when it is
 *    folded away, so a panel that nobody is looking at does no work.
 */

import * as vscode from 'vscode';
import type { BackgroundJobStatus } from './status-contract';
import { elapsedLabel, taskBoard, taskDetail, taskTitle, type TaskBoard, type TaskRow } from './tasks-rows';

/** The view id, which the manifest also declares: the two must not drift. */
export const TASKS_VIEW_ID = 'picode.status.tasks';

export const TASKS_REFRESH_COMMAND = 'picode.tasks.refresh';

/** How often a visible block asks again. Folded away, the timer is cleared. */
const REFRESH_MS = 5_000;

type TasksNode =
	| { readonly kind: 'heading' }
	| { readonly kind: 'message'; readonly text: string }
	| { readonly kind: 'group'; readonly count: number }
	| { readonly kind: 'row'; readonly row: TaskRow }
	| { readonly kind: 'fact'; readonly label: string; readonly detail: string; readonly icon: string; readonly tooltip?: string };

/** Where the block reads from. The jobs are the chat's own tracker, not a copy of it. */
export interface TasksViewDeps {
	readonly runningJobs: () => readonly BackgroundJobStatus[];
	/** What "now" is, so the tests can hold a clock still. */
	readonly now?: () => number;
}

class TasksProvider implements vscode.TreeDataProvider<TasksNode> {
	private readonly changed = new vscode.EventEmitter<TasksNode | undefined | void>();
	readonly onDidChangeTreeData = this.changed.event;

	private board: TaskBoard | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly deps: TasksViewDeps) { }

	dispose(): void {
		this.stopTicking();
		this.changed.dispose();
	}

	/** Reads the board from the tracker. */
	refresh(): void {
		this.board = taskBoard(this.deps.runningJobs());
		this.changed.fire();
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

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	getTreeItem(node: TasksNode): vscode.TreeItem {
		switch (node.kind) {
			case 'heading': {
				const label = this.board === undefined
					? 'Tasks'
					: this.board.total === 0
						? 'Nothing running'
						: `${this.board.running.length} running`;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('dashboard');
				item.contextValue = 'picode.tasks.heading';
				item.tooltip = 'The work the chat has out: the background jobs it launched.';
				return item;
			}
			case 'message': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('info');
				item.contextValue = 'picode.tasks.message';
				return item;
			}
			case 'group': {
				const item = new vscode.TreeItem('Running', vscode.TreeItemCollapsibleState.Expanded);
				item.description = String(node.count);
				item.iconPath = new vscode.ThemeIcon('sync');
				item.contextValue = 'picode.tasks.group';
				item.tooltip = 'Happening now: the chat\'s background jobs.';
				return item;
			}
			case 'row': {
				const item = new vscode.TreeItem(taskTitle(node.row), vscode.TreeItemCollapsibleState.Collapsed);
				item.description = taskDetail(node.row, this.now());
				item.iconPath = new vscode.ThemeIcon('terminal');
				item.contextValue = 'picode.tasks.job';
				item.tooltip = node.row.job.command === undefined
					? 'A background job of this chat; its report lands in the conversation when it ends.'
					: `${node.row.job.command}\n\nA background job of this chat; its report lands in the conversation when it ends.`;
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
		}
	}

	getChildren(node?: TasksNode): TasksNode[] {
		if (node === undefined) {
			return this.root();
		}
		switch (node.kind) {
			case 'group':
				return (this.board?.running ?? []).map(row => ({ kind: 'row', row }));
			case 'row':
				return this.details(node.row);
			default:
				return [];
		}
	}

	private root(): TasksNode[] {
		const nodes: TasksNode[] = [{ kind: 'heading' }];
		if (this.board === undefined) {
			return nodes;
		}
		if (this.board.running.length > 0) {
			nodes.push({ kind: 'group', count: this.board.running.length });
		} else {
			nodes.push({ kind: 'message', text: 'No background jobs running.' });
		}
		return nodes;
	}

	/** What a row opens to: the facts a person asks about work they did not start themselves. */
	private details(row: TaskRow): TasksNode[] {
		const facts: TasksNode[] = [
			{ kind: 'fact', label: 'Running for', detail: elapsedLabel(row.job.startedAt, this.now()), icon: 'watch' },
		];
		if (row.job.command !== undefined) {
			facts.push({ kind: 'fact', label: 'Command', detail: row.job.command, icon: 'symbol-field', tooltip: row.job.command });
		}
		return facts;
	}
}

/** Registers the block and its refresh action. */
export function registerTasksView(deps: TasksViewDeps): vscode.Disposable {
	const provider = new TasksProvider(deps);
	const view = vscode.window.createTreeView(TASKS_VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

	const disposables: vscode.Disposable[] = [
		provider,
		view,
		vscode.commands.registerCommand(TASKS_REFRESH_COMMAND, () => provider.refresh()),
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
