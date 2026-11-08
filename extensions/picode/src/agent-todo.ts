/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The task list the agent keeps while it works (gentle-pi's `todo` tool), as the chat can see it.
 *
 * The tool answers every call with the whole list in the result's details, so the list is read
 * from there: nothing is replayed and nothing is invented. A result that does not carry that shape
 * leaves what was known untouched.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import { l10n } from './l10n.ts';

/** The tool's name, as gentle-pi registers it. */
export const TODO_TOOL_NAME = 'todo';

/** The states a task can be in, as gentle-pi names them. */
export type TodoStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'dropped';

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'dropped'];

/** One task of the list. */
export interface TodoRow {
	readonly id: number;
	readonly title: string;
	readonly status: TodoStatus;
	/** What the agent wrote about how the task is going. */
	readonly note?: string;
}

/** The list as the status column reads it. */
export interface TodoBoard {
	readonly tasks: readonly TodoRow[];
	/** When the agent last changed the list (epoch milliseconds). */
	readonly updatedAt: number;
	/** Whether a turn is in flight: a step in progress with no turn behind it is not being worked on. */
	readonly working?: boolean;
	/** What the agent is doing this instant (`read src/app.ts`). */
	readonly activity?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The tasks a `todo` call answered with, or `undefined` when the answer is not a list (an error, a
 * result of another tool). An empty list is an answer: the agent cleared it.
 */
export function todoFromResult(result: unknown): TodoRow[] | undefined {
	const tasks = record(record(record(result)?.details)?.gentleTodo)?.tasks;
	if (!Array.isArray(tasks)) {
		return undefined;
	}
	const rows: TodoRow[] = [];
	for (const task of tasks) {
		const item = record(task);
		const title = typeof item?.title === 'string' ? item.title.trim() : '';
		const status = STATUSES.find(candidate => candidate === item?.status);
		if (title.length === 0 || status === undefined) {
			continue;
		}
		const note = typeof item?.note === 'string' ? item.note.trim() : '';
		rows.push({ id: typeof item?.id === 'number' ? item.id : rows.length + 1, title, status, ...(note.length === 0 ? {} : { note }) });
	}
	return rows;
}

/** How long a list whose tasks are all finished stays in the column: long enough to read how it ended. */
export const FINISHED_LIST_SHOWN_MS = 5 * 60 * 1000;

/** Whether a status still needs work. */
export function isOpen(status: TodoStatus): boolean {
	return status === 'pending' || status === 'in_progress' || status === 'blocked';
}

/** Holds the last list the agent wrote. */
export class TodoTracker {
	private board: TodoBoard | undefined;

	/** Records the list a `todo` call answered with. */
	set(tasks: readonly TodoRow[], now: number): void {
		this.board = tasks.length === 0 ? undefined : { tasks, updatedAt: now };
	}

	/**
	 * The list to show: while any task is open, and for a few minutes after the last one finished.
	 * Later, it is the past and the column drops it.
	 */
	current(now: number): TodoBoard | undefined {
		const board = this.board;
		if (board === undefined) {
			return undefined;
		}
		return board.tasks.some(task => isOpen(task.status)) || now - board.updatedAt < FINISHED_LIST_SHOWN_MS ? board : undefined;
	}
}

/** `2/5`: the tasks done out of the tasks that count (a dropped one no longer does). */
export function todoProgress(tasks: readonly TodoRow[]): string {
	const counted = tasks.filter(task => task.status !== 'dropped');
	return `${counted.filter(task => task.status === 'done').length}/${counted.length}`;
}

/** The line beside a step: for the one in progress, what is happening right now. Finished and pending steps say nothing. */
export function todoDetail(task: TodoRow, board: Pick<TodoBoard, 'working' | 'activity'>): string | undefined {
	switch (task.status) {
		case 'in_progress':
			return board.working === true ? board.activity ?? task.note ?? l10n.t('Working…') : task.note ?? l10n.t('Paused');
		case 'blocked':
			return task.note ?? l10n.t('Blocked');
		default:
			return undefined;
	}
}

/** The codicon that says each state. A step in progress turns only while a turn is working on it. */
export function todoIcon(status: TodoStatus, working = false): string {
	switch (status) {
		case 'done': return 'check';
		case 'in_progress': return working ? 'loading' : 'debug-pause';
		case 'blocked': return 'warning';
		case 'dropped': return 'circle-slash';
		case 'pending': return 'circle-outline';
	}
}
