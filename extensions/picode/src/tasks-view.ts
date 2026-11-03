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
import { GENERIC_PROVIDER_ERROR } from './subagent-failure';

/** The view id, which the manifest also declares: the two must not drift. */
export const TASKS_VIEW_ID = 'picode.status.tasks';

export const TASKS_REFRESH_COMMAND = 'picode.tasks.refresh';
export const TASKS_TRANSCRIPT_COMMAND = 'picode.tasks.openTranscript';

/** The same board as plain data, for the Agent layout's status column (the editor draws it there). */
export const TASKS_DATA_COMMAND = 'picode.tasks.data';

/** One row of the board as the editor draws it. */
export interface TaskDataRow {
	readonly title: string;
	readonly detail: string;
	/** A codicon name. */
	readonly icon: string;
	/** An agent's task id: its transcript opens on a click. */
	readonly agentId?: string;
	/** A job's live output file: it opens on a click. */
	readonly outputFile?: string;
	/** Hover text: a job's command, an agent's problem. */
	readonly tooltip?: string;
}

/** The board as plain data; the rows read the same as the tree's. */
export function taskBoardData(deps: TasksViewDeps): { readonly running: readonly TaskDataRow[]; readonly finished: readonly TaskDataRow[] } {
	const board = taskBoard(deps.runningJobs(), deps.agents?.() ?? [], deps.finishedJobs?.() ?? []);
	const now = deps.now?.() ?? Date.now();
	const toData = (row: TaskRow): TaskDataRow => row.kind === 'job'
		? { title: taskTitle(row), detail: taskDetail(row, now), icon: rowIcon(row), outputFile: row.job.outputPath, tooltip: row.job.command }
		: { title: taskTitle(row), detail: taskDetail(row, now), icon: rowIcon(row), agentId: row.agent.id, tooltip: row.agent.error ?? (row.agent.lastStep.length > 0 ? row.agent.lastStep : undefined) };
	return { running: board.running.map(toData), finished: board.finished.map(toData) };
}

/** How often a visible block asks again. Folded away, the timer is cleared. */
const REFRESH_MS = 5_000;

type TasksNode =
	| { readonly kind: 'heading' }
	| { readonly kind: 'message'; readonly text: string }
	| { readonly kind: 'group'; readonly group: 'running' | 'finished'; readonly count: number }
	| { readonly kind: 'row'; readonly row: TaskRow }
	| { readonly kind: 'fact'; readonly label: string; readonly detail: string; readonly icon: string; readonly tooltip?: string; readonly openFile?: string };

/** Where the block reads from. The jobs are the chat's own tracker, not a copy of it. */
export interface TasksViewDeps {
	readonly runningJobs: () => readonly BackgroundJobStatus[];
	/** The jobs that ended most recently, newest first. */
	readonly finishedJobs?: () => ReadonlyArray<BackgroundJobStatus & { readonly endedAt: number }>;
	/** The subagents gentle-pi last published. */
	readonly agents?: () => readonly AgentTaskRow[];
	/** Calls the listener when the agents change; returns how to stop. */
	readonly onAgentsChange?: (listener: () => void) => () => void;
	/** Opens the page that follows what one agent does (by its task id). */
	readonly openTranscript?: (id: string) => void;
	/** Why a finished agent failed, in the provider's terms, when gentle-pi only recorded that it did. */
	readonly explainFailure?: (id: string) => string | undefined;
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
		this.board = taskBoard(this.deps.runningJobs(), this.deps.agents?.() ?? [], this.deps.finishedJobs?.() ?? []);
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
					? vscode.l10n.t('Tasks')
					: board.running.length === 0
						? vscode.l10n.t('Nothing running')
						: vscode.l10n.t('{0} running', board.running.length);
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('dashboard');
				item.contextValue = 'picode.tasks.heading';
				item.tooltip = vscode.l10n.t('The work the chat has out: the background jobs it launched and the agents it started.');
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
				const item = new vscode.TreeItem(running ? vscode.l10n.t('Running') : vscode.l10n.t('Finished'), running ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
				item.description = String(node.count);
				item.iconPath = new vscode.ThemeIcon(running ? 'sync' : 'history');
				item.contextValue = 'picode.tasks.group';
				item.tooltip = running
					? vscode.l10n.t('Happening now: the chat\'s background jobs and the agents still working.')
					: vscode.l10n.t('Agents that ended, newest first.');
				return item;
			}
			case 'row': {
				const item = new vscode.TreeItem(taskTitle(node.row), vscode.TreeItemCollapsibleState.Collapsed);
				item.description = taskDetail(node.row, this.now());
				item.iconPath = new vscode.ThemeIcon(rowIcon(node.row));
				if (node.row.kind === 'job') {
					item.contextValue = 'picode.tasks.job';
					const note = vscode.l10n.t('A background job of this chat; its report lands in the conversation when it ends.');
					item.tooltip = node.row.job.command === undefined ? note : `${node.row.job.command}\n\n${note}`;
				} else {
					item.contextValue = 'picode.tasks.agent';
					item.tooltip = vscode.l10n.t('An agent this chat started; its report lands in the conversation when it ends. Open its transcript to follow what it did.');
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
				if (node.openFile !== undefined) {
					// The editor reloads an open file as it grows, so this is the job's live output.
					item.command = { command: 'vscode.open', title: vscode.l10n.t('Open live output'), arguments: [vscode.Uri.file(node.openFile)] };
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
			nodes.push({ kind: 'message', text: vscode.l10n.t('No background jobs or agents running.') });
		}
		return nodes;
	}

	/** What a row opens to: the facts a person asks about work they did not start themselves. */
	private details(row: TaskRow): TasksNode[] {
		if (row.kind === 'job') {
			const facts: TasksNode[] = [
				{ kind: 'fact', label: row.job.endedAt === undefined ? vscode.l10n.t('Running for') : vscode.l10n.t('Ran for'), detail: elapsedLabel(row.job.startedAt, row.job.endedAt ?? this.now()), icon: 'watch' },
			];
			if (row.job.command !== undefined) {
				facts.push({ kind: 'fact', label: vscode.l10n.t('Command'), detail: row.job.command, icon: 'symbol-field', tooltip: row.job.command });
			}
			if (row.job.outputPath !== undefined) {
				facts.push({ kind: 'fact', label: vscode.l10n.t('Live output'), detail: vscode.l10n.t('Open'), icon: 'output', tooltip: vscode.l10n.t('Opens what the job prints; it keeps updating while the job runs.'), openFile: row.job.outputPath });
			}
			return facts;
		}
		const { agent } = row;
		const facts: TasksNode[] = [
			{ kind: 'fact', label: vscode.l10n.t('State'), detail: taskState(row), icon: rowIcon(row) },
		];
		if (agent.agent.length > 0) {
			facts.push({ kind: 'fact', label: vscode.l10n.t('Agent'), detail: agent.agent, icon: 'person' });
		}
		if (agent.startedAt !== undefined) {
			facts.push({ kind: 'fact', label: agent.endedAt === undefined ? vscode.l10n.t('Running for') : vscode.l10n.t('Took'), detail: elapsedLabel(agent.startedAt, agent.endedAt ?? this.now()), icon: 'watch' });
		}
		const turns = agent.turns === 1 ? vscode.l10n.t('{0} turn', agent.turns) : vscode.l10n.t('{0} turns', agent.turns);
		const calls = agent.toolCalls === 1 ? vscode.l10n.t('{0} tool call', agent.toolCalls) : vscode.l10n.t('{0} tool calls', agent.toolCalls);
		facts.push({ kind: 'fact', label: vscode.l10n.t('Steps'), detail: `${turns} · ${calls}`, icon: 'list-ordered' });
		// A failed task's last step is its error: one row says it.
		if (agent.lastStep.length > 0 && agent.lastStep !== agent.error) {
			facts.push({ kind: 'fact', label: vscode.l10n.t('Last step'), detail: agent.lastStep, icon: 'history', tooltip: agent.lastStep });
		}
		if (agent.error !== undefined) {
			const problem = (agent.error === GENERIC_PROVIDER_ERROR ? this.deps.explainFailure?.(agent.id) : undefined) ?? agent.error;
			facts.push({ kind: 'fact', label: vscode.l10n.t('Problem'), detail: problem, icon: 'warning', tooltip: problem });
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
		vscode.commands.registerCommand(TASKS_DATA_COMMAND, () => taskBoardData(deps)),
		vscode.commands.registerCommand(TASKS_TRANSCRIPT_COMMAND, (node?: TasksNode | string) => {
			// The status column passes the task id itself.
			if (typeof node === 'string') {
				deps.openTranscript?.(node);
				return;
			}
			if (node?.kind !== 'row' || node.row.kind !== 'agent') {
				return;
			}
			deps.openTranscript?.(node.row.agent.id);
		}),
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
