/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The work the chat has out, as one list: its background jobs and the tasks it handed to the
 * durable agent.
 *
 * This is the third reader of facts that already existed — the pill above the chat input holds
 * the running jobs (`background-jobs.ts`), the status surface holds the durable work
 * (`durable-tasks.ts`) — and it adds no new source of truth: the two lists are merged into the
 * one question a person asks ("what is still running?").
 *
 * Two rules decide the shape:
 *
 *  * **A job is running by definition.** The tracker only holds jobs whose completion has not
 *    arrived, so every job row leads; a finished job's report is already in the conversation.
 *  * **A task that could not be read is not idle.** `inFlight === undefined` means the snapshot
 *    did not answer, and the row says so instead of guessing in either direction.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import type { DurableWorkRow } from './durable-tasks';
import type { BackgroundJobStatus } from './status-contract';

/** One row of the Tasks block: a background job, or a durable conversation worth a row. */
export type TaskRow =
	| { readonly kind: 'job'; readonly job: BackgroundJobStatus }
	| { readonly kind: 'task'; readonly work: DurableWorkRow };

/** The rows, split by the only state that changes what a person does next. */
export interface TaskBoard {
	/** Work happening now: every open job, then the tasks with a run in flight. */
	readonly running: readonly TaskRow[];
	/** Tasks that exist and are quiet — delegated work waiting, and nothing else. */
	readonly idle: readonly TaskRow[];
	readonly total: number;
}

/**
 * Merges the two lists into the board.
 *
 * `work` is absent when the durable agent is down, which is not the same as "no work": the
 * caller draws that difference, so here an absent list simply contributes nothing.
 */
export function taskBoard(jobs: readonly BackgroundJobStatus[], work: readonly DurableWorkRow[] | undefined): TaskBoard {
	const running: TaskRow[] = [];
	const idle: TaskRow[] = [];
	for (const job of jobs) {
		running.push({ kind: 'job', job });
	}
	for (const row of work ?? []) {
		if (row.inFlight === true) {
			running.push({ kind: 'task', work: row });
		} else {
			idle.push({ kind: 'task', work: row });
		}
	}
	return { running, idle, total: running.length + idle.length };
}

/**
 * The row's name: the job's own label, the task's own id, and — when durable gave neither —
 * the conversation it lives in, which is still a real thing the owner can open.
 */
export function taskTitle(row: TaskRow): string {
	if (row.kind === 'job') {
		return row.job.label ?? `Background job ${row.job.jobNumber}`;
	}
	return row.work.taskId === undefined
		? `Conversation ${row.work.conversationId}`
		: `Task ${row.work.taskId}`;
}

/** What the row is doing, in one word that is true: `running`, `idle`, or could not be read. */
export function taskState(row: TaskRow): string {
	if (row.kind === 'job') {
		return 'running';
	}
	if (row.work.inFlight === undefined) {
		return 'state unavailable';
	}
	return row.work.inFlight ? 'running' : 'idle';
}

/**
 * The line after the name: how long a job has been out, how much a task holds.
 *
 * A job counts time because that is the only thing a background job can be late at; a task
 * counts entries because that is how much work it has kept.
 */
export function taskDetail(row: TaskRow, now: number): string {
	if (row.kind === 'task') {
		const entries = row.work.entries;
		return `${taskState(row)} · ${entries} ${entries === 1 ? 'entry' : 'entries'}`;
	}
	return `${taskState(row)} · ${elapsedLabel(row.job.startedAt, now)}`;
}

/** How long ago something started, in the shortest words that are still true. */
export function elapsedLabel(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ${minutes % 60}m`;
	}
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The newest thing a task holds, cut to one line.
 *
 * Durable's `newest` is one entry in its own words ("entry 12 (pi.assistant)"), which can be
 * long enough to push the row's description off the panel; the first line, capped, is what a
 * panel can carry. Nothing is rewritten — only shortened.
 */
export function newestLine(newest: string | undefined, cap = 60): string | undefined {
	if (newest === undefined) {
		return undefined;
	}
	const firstLine = newest.split('\n', 1)[0].trim();
	if (firstLine.length === 0) {
		return undefined;
	}
	return firstLine.length <= cap ? firstLine : `${firstLine.slice(0, cap - 1)}…`;
}
