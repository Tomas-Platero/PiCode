/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Tasks block of the PiCode panel: the work the chat has out, in the place you look while
 * you are not looking at the chat.
 *
 * It is a **block of the existing container**, like Memory — no second panel, no page, no window.
 * What it shows is exactly what the chat cannot: a list that stays put while you work in another
 * file, a running job's clock, and the subagents gentle-pi runs, each one opening to its own
 * facts instead of to a transcript you have to scroll.
 *
 * Two rules decide the shape of this file:
 *
 *  * **Nothing is invented.** The jobs come from the tracker the pill above the chat input reads;
 *    the agents from what gentle-pi last published.
 *  * **Opening is not reading.** The block refreshes while it is visible and stops when it is
 *    folded away, so a panel that nobody is looking at does no work.
 */

import * as vscode from 'vscode';
import type { AgentTaskRow } from './gentle-agents-store';
import type { BackgroundJobStatus } from './status-contract';
import { elapsedLabel, taskBoard, taskDetail, taskState, taskTitle, type TaskBoard, type TaskRow } from './tasks-rows';

/** The view id, which the manifest also declares: the two must not drift. */
export const TASKS_VIEW_ID = 'picode.status.tasks';

export const TASKS_REFRESH_COMMAND = 'picode.tasks.refresh';

/** How often a visible block asks again. Folded away, the timer is cleared. */
const REFRESH_MS = 5_000;

type TasksNode =
	| { readonly kind: 'heading' }
	| { readonly kind: 'message'; readonly text: string }
	| { readonly kind: 'group'; readonly group: 'running' | 'finished'; readonly count: number }
	| { readonly kind: 'row'; readonly row: TaskRow }
	| { readonly kind: 'fact'; readonly label: string; readonly detail: string; readonly icon: string; readonly tooltip?: string };

/** Where the block reads from. The jobs are the chat's own tracker, not a copy of it. */
export interface TasksViewDeps {
	readonly runningJobs: () => readonly BackgroundJobStatus[];
	/** The subagents gentle-pi last published. */
	readonly agents?: () => readonly AgentTaskRow[];
	/** Calls the listener when the agents change; returns how to stop. */
	readonly onAgentsChange?: (listener: () => void) => () => void;
	/** What "now" is, so the tests can hold a clock still. */
	readonly now?: () => number;
}

/** One icon per kind of row: a row's icon is read before its label is. */
function rowIcon(row: TaskRow): string {
	if (row.kind === 'job') {
		return 'terminal';
	}
	switch (row.agent.status) {
		case 'queued': return 'clock';
		case 'running': return 'sync';
		case 'waiting': return 'bell';
		case 'completed': return 'check';
		default: return 'error';
	}
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

	/** Reads the board from the tracker and from what gentle-pi published. */
	refresh(): void {
		this.board = taskBoard(this.deps.runningJobs(), this.deps.agents?.() ?? []);
		this.changed.fire();
	}

	/** Refreshes only while the block is on screen: a push must not start it asking by itself. */
	refreshIfVisible(): void {
		if (this.timer !== undefined) {
			this.refresh();
		}
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
				const board = this.board;
				const label = board === undefined
					? 'Tasks'
					: board.running.length === 0
						? 'Nothing running'
						: `${board.running.length} running`;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('dashboard');
				item.contextValue = 'picode.tasks.heading';
				item.tooltip = 'The work the chat has out: the background jobs it launched and the agents it started.';
				return item;
			}
			case 'message': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('info');
				item.contextValue = 'picode.tasks.message';
				return item;
			}
			case 'group': {
				const running = node.group === 'running';
				const item = new vscode.TreeItem(running ? 'Running' : 'Finished', running ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
				item.description = String(node.count);
				item.iconPath = new vscode.ThemeIcon(running ? 'sync' : 'history');
				item.contextValue = 'picode.tasks.group';
				item.tooltip = running
					? 'Happening now: the chat\'s background jobs and the agents still working.'
					: 'Agents that ended, newest first.';
				return item;
			}
			case 'row': {
				const item = new vscode.TreeItem(taskTitle(node.row), vscode.TreeItemCollapsibleState.Collapsed);
				item.description = taskDetail(node.row, this.now());
				item.iconPath = new vscode.ThemeIcon(rowIcon(node.row));
				if (node.row.kind === 'job') {
					item.contextValue = 'picode.tasks.job';
					item.tooltip = node.row.job.command === undefined
						? 'A background job of this chat; its report lands in the conversation when it ends.'
						: `${node.row.job.command}\n\nA background job of this chat; its report lands in the conversation when it ends.`;
				} else {
					item.contextValue = 'picode.tasks.agent';
					item.tooltip = 'An agent this chat started; its report lands in the conversation when it ends.';
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
		}
	}

	getChildren(node?: TasksNode): TasksNode[] {
		if (node === undefined) {
			return this.root();
		}
		switch (node.kind) {
			case 'group': {
				const rows = node.group === 'running' ? this.board?.running ?? [] : this.board?.finished ?? [];
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
		if (this.board === undefined) {
			return nodes;
		}
		if (this.board.running.length > 0) {
			nodes.push({ kind: 'group', group: 'running', count: this.board.running.length });
		}
		if (this.board.finished.length > 0) {
			nodes.push({ kind: 'group', group: 'finished', count: this.board.finished.length });
		}
		if (this.board.total === 0) {
			nodes.push({ kind: 'message', text: 'No background jobs or agents running.' });
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
		const { agent } = row;
		const facts: TasksNode[] = [
			{ kind: 'fact', label: 'State', detail: taskState(row), icon: rowIcon(row) },
		];
		if (agent.agent.length > 0) {
			facts.push({ kind: 'fact', label: 'Agent', detail: agent.agent, icon: 'person' });
		}
		if (agent.startedAt !== undefined) {
			facts.push({ kind: 'fact', label: agent.endedAt === undefined ? 'Running for' : 'Took', detail: elapsedLabel(agent.startedAt, agent.endedAt ?? this.now()), icon: 'watch' });
		}
		facts.push({ kind: 'fact', label: 'Steps', detail: `${agent.turns} ${agent.turns === 1 ? 'turn' : 'turns'} · ${agent.toolCalls} ${agent.toolCalls === 1 ? 'tool call' : 'tool calls'}`, icon: 'list-ordered' });
		if (agent.lastStep.length > 0) {
			facts.push({ kind: 'fact', label: 'Last step', detail: agent.lastStep, icon: 'history', tooltip: agent.lastStep });
		}
		if (agent.error !== undefined) {
			facts.push({ kind: 'fact', label: 'Problem', detail: agent.error, icon: 'warning', tooltip: agent.error });
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
		// The agents are pushed, and this block is polled: without this, an agent that just ended
		// kept its row at "running" for up to one tick.
		{ dispose: deps.onAgentsChange?.(() => provider.refreshIfVisible()) ?? (() => undefined) },
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
