/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The work the chat has out, as one list: its background jobs.
 *
 * This is the third reader of a fact that already existed — the pill above the chat input holds
 * the running jobs (`background-jobs.ts`) — and it adds no new source of truth: the list is the
 * answer to the one question a person asks ("what is still running?").
 *
 * **A job is running by definition.** The tracker only holds jobs whose completion has not
 * arrived, so every row leads; a finished job's report is already in the conversation.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import type { BackgroundJobStatus } from './status-contract';

/** One row of the Tasks block: a background job. */
export type TaskRow = { readonly kind: 'job'; readonly job: BackgroundJobStatus };

/** The rows, split by the only state that changes what a person does next. */
export interface TaskBoard {
	/** Work happening now: every open job. */
	readonly running: readonly TaskRow[];
	readonly total: number;
}

/** Builds the board from the chat's running jobs. */
export function taskBoard(jobs: readonly BackgroundJobStatus[]): TaskBoard {
	const running: TaskRow[] = jobs.map(job => ({ kind: 'job', job }));
	return { running, total: running.length };
}

/** The row's name: the job's own label, or its number when it has none. */
export function taskTitle(row: TaskRow): string {
	return row.job.label ?? `Background job ${row.job.jobNumber}`;
}

/** What the row is doing, in one word that is true. */
export function taskState(_row: TaskRow): string {
	return 'running';
}

/**
 * The line after the name: how long a job has been out. A background job counts time because
 * that is the only thing it can be late at.
 */
export function taskDetail(row: TaskRow, now: number): string {
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
