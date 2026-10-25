/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The work the chat has out, as one list: its background jobs and the subagents gentle-pi runs.
 *
 * This is a reader of facts that already existed — the pill above the chat input holds the
 * running jobs (`background-jobs.ts`), and gentle-pi publishes its subagents
 * (`gentle-agents-store.ts`) — and it adds no new source of truth: the two lists are merged into
 * the one question a person asks ("what is still running?").
 *
 * Two rules decide the shape:
 *
 *  * **A job is running by definition.** The tracker only holds jobs whose completion has not
 *    arrived, so every job row leads; a finished job's report is already in the conversation.
 *  * **An agent says its own state.** A queued, running or waiting agent is out; a finished one
 *    is listed apart, newest first and capped, so its outcome is not lost the moment it ends.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import type { AgentTaskRow } from './gentle-agents-store';
import type { BackgroundJobStatus } from './status-contract';

/** One row of the Tasks block: a background job, or a subagent. */
export type TaskRow =
	| { readonly kind: 'job'; readonly job: BackgroundJobStatus }
	| { readonly kind: 'agent'; readonly agent: AgentTaskRow };

/**
 * Whether an agent is still going. Written here, not imported: this file has only type imports so
 * `node --test` can run it straight, and the rule is three words.
 */
function isActive(status: AgentTaskRow['status']): boolean {
	return status === 'queued' || status === 'running' || status === 'waiting';
}

/** How many finished agents the block keeps listing. */
export const FINISHED_AGENTS_SHOWN = 5;

/** The rows, split by the only state that changes what a person does next. */
export interface TaskBoard {
	/** Work happening now: every open job, then the agents still going. */
	readonly running: readonly TaskRow[];
	/** Agents that ended, newest first, capped. */
	readonly finished: readonly TaskRow[];
	readonly total: number;
}

/** Builds the board from the chat's running jobs and the subagents' last published state. */
export function taskBoard(jobs: readonly BackgroundJobStatus[], agents: readonly AgentTaskRow[] = []): TaskBoard {
	const running: TaskRow[] = jobs.map(job => ({ kind: 'job', job }));
	const finished: TaskRow[] = [];
	for (const agent of agents) {
		if (isActive(agent.status)) {
			running.push({ kind: 'agent', agent });
		} else {
			finished.push({ kind: 'agent', agent });
		}
	}
	const shown = finished.slice(0, FINISHED_AGENTS_SHOWN);
	return { running, finished: shown, total: running.length + shown.length };
}

/** The row's name: the job's or the agent's own label, or what it is. */
export function taskTitle(row: TaskRow): string {
	if (row.kind === 'job') {
		return row.job.label ?? `Background job ${row.job.jobNumber}`;
	}
	return row.agent.label.length > 0 ? row.agent.label : row.agent.agent.length > 0 ? row.agent.agent : `Agent ${row.agent.id}`;
}

/** What the row is doing, in one word that is true. */
export function taskState(row: TaskRow): string {
	if (row.kind === 'job') {
		return 'running';
	}
	switch (row.agent.status) {
		case 'queued': return 'queued';
		case 'running': return 'running';
		case 'waiting': return 'waiting for you';
		case 'completed': return 'done';
		case 'failed': return 'failed';
		case 'cancelled': return 'stopped';
		case 'timed_out': return 'timed out';
	}
}

/**
 * The line after the name: how long a job has been out; for an agent, its role and how long it
 * worked or has been working.
 */
export function taskDetail(row: TaskRow, now: number): string {
	if (row.kind === 'job') {
		return `${taskState(row)} · ${elapsedLabel(row.job.startedAt, now)}`;
	}
	const { agent } = row;
	const parts = [taskState(row)];
	if (agent.label.length > 0 && agent.agent.length > 0) {
		parts.push(agent.agent);
	}
	if (agent.startedAt !== undefined) {
		parts.push(elapsedLabel(agent.startedAt, agent.endedAt ?? now));
	}
	return parts.join(' · ');
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
