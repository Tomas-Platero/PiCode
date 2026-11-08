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
 *  * **An open job is running by definition.** The tracker's open jobs are the ones whose completion
 *    has not arrived, so they lead; a job that just ended is listed among the finished, with its
 *    time, and its report is already in the conversation.
 *  * **An agent says its own state.** A queued, running or waiting agent is out; a finished one
 *    is listed apart, newest first and capped, so its outcome is not lost the moment it ends.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import type { AgentTaskRow } from './gentle-agents-store';
import type { BackgroundJobStatus } from './status-contract';
import { l10n } from './l10n.ts';
import { GENERIC_PROVIDER_ERROR } from './subagent-failure.ts';

/** One row of the Tasks block: a background job, or a subagent. */
export type TaskRow =
	| { readonly kind: 'job'; readonly job: BackgroundJobStatus & { readonly endedAt?: number } }
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

/** Builds the board from the chat's running jobs, the subagents' last published state and the jobs that just ended. */
export function taskBoard(jobs: readonly BackgroundJobStatus[], agents: readonly AgentTaskRow[] = [], endedJobs: ReadonlyArray<BackgroundJobStatus & { readonly endedAt: number }> = []): TaskBoard {
	const running: TaskRow[] = jobs.map(job => ({ kind: 'job', job }));
	const finished: TaskRow[] = [];
	for (const agent of agents) {
		if (isActive(agent.status)) {
			running.push({ kind: 'agent', agent });
		} else {
			finished.push({ kind: 'agent', agent });
		}
	}
	// Ended jobs sit among the finished agents, newest first; without any, the agents keep the order they came in.
	if (endedJobs.length > 0) {
		finished.push(...endedJobs.map((job): TaskRow => ({ kind: 'job', job })));
		const endedAt = (row: TaskRow): number => (row.kind === 'job' ? row.job.endedAt : row.agent.endedAt) ?? 0;
		finished.sort((a, b) => endedAt(b) - endedAt(a));
	}
	const shown = finished.slice(0, FINISHED_AGENTS_SHOWN);
	return { running, finished: shown, total: running.length + shown.length };
}

/** The row's name: the job's or the agent's own label, or what it is. */
export function taskTitle(row: TaskRow): string {
	if (row.kind === 'job') {
		return row.job.label ?? l10n.t('Background job {0}', row.job.jobNumber);
	}
	return row.agent.label.length > 0 ? row.agent.label : row.agent.agent.length > 0 ? row.agent.agent : l10n.t('Agent {0}', row.agent.id);
}

/** What the row is doing, in one word that is true. */
export function taskState(row: TaskRow): string {
	if (row.kind === 'job') {
		return row.job.endedAt === undefined ? l10n.t('running') : l10n.t('done');
	}
	switch (row.agent.status) {
		case 'queued': return l10n.t('queued');
		case 'running': return l10n.t('running');
		case 'waiting': return l10n.t('waiting for you');
		case 'completed': return l10n.t('done');
		case 'failed': return l10n.t('failed');
		case 'cancelled': return l10n.t('stopped');
		case 'timed_out': return l10n.t('timed out');
	}
}

/**
 * The line after the name: how long a job has been out; for an agent, its role and how long it
 * worked or has been working.
 */
export function taskDetail(row: TaskRow, now: number): string {
	if (row.kind === 'job') {
		return `${taskState(row)} · ${elapsedLabel(row.job.startedAt, row.job.endedAt ?? now)}`;
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
		return l10n.t('{0}s', seconds);
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return l10n.t('{0}m', minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return l10n.t('{0}h {1}m', hours, minutes % 60);
	}
	return l10n.t('{0}d {1}h', Math.floor(hours / 24), hours % 24);
}

/** The line that sums the board up: what is out right now. */
export function taskSummary(board: TaskBoard): string {
	return board.running.length === 0 ? l10n.t('Nothing running') : l10n.t('{0} running', board.running.length);
}

/** One icon per kind of row: a row's icon is read before its label is. */
export function rowIcon(row: TaskRow): string {
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

/** One fact under an open row. */
export interface TaskFact {
	readonly label: string;
	readonly detail: string;
	/** A codicon name. */
	readonly icon: string;
	readonly tooltip?: string;
	/** A file that opens on a click: a job's live output. */
	readonly openFile?: string;
}

/**
 * What a row opens to: the facts a person asks about work they did not start themselves.
 * `explainFailure` says why an agent failed, in the provider's terms, when gentle-pi only recorded that it did.
 */
export function taskFacts(row: TaskRow, now: number, explainFailure?: (id: string) => string | undefined): TaskFact[] {
	if (row.kind === 'job') {
		const facts: TaskFact[] = [
			{ label: row.job.endedAt === undefined ? l10n.t('Running for') : l10n.t('Ran for'), detail: elapsedLabel(row.job.startedAt, row.job.endedAt ?? now), icon: 'watch' },
		];
		if (row.job.command !== undefined) {
			facts.push({ label: l10n.t('Command'), detail: row.job.command, icon: 'symbol-field', tooltip: row.job.command });
		}
		if (row.job.outputPath !== undefined) {
			facts.push({ label: l10n.t('Live output'), detail: l10n.t('Open'), icon: 'output', tooltip: l10n.t('Opens what the job prints; it keeps updating while the job runs.'), openFile: row.job.outputPath });
		}
		return facts;
	}
	const { agent } = row;
	const facts: TaskFact[] = [
		{ label: l10n.t('State'), detail: taskState(row), icon: rowIcon(row) },
	];
	if (agent.agent.length > 0) {
		facts.push({ label: l10n.t('Agent'), detail: agent.agent, icon: 'person' });
	}
	if (agent.startedAt !== undefined) {
		facts.push({ label: agent.endedAt === undefined ? l10n.t('Running for') : l10n.t('Took'), detail: elapsedLabel(agent.startedAt, agent.endedAt ?? now), icon: 'watch' });
	}
	const turns = agent.turns === 1 ? l10n.t('{0} turn', agent.turns) : l10n.t('{0} turns', agent.turns);
	const calls = agent.toolCalls === 1 ? l10n.t('{0} tool call', agent.toolCalls) : l10n.t('{0} tool calls', agent.toolCalls);
	facts.push({ label: l10n.t('Steps'), detail: `${turns} · ${calls}`, icon: 'list-ordered' });
	// A failed task's last step is its error: one row says it.
	if (agent.lastStep.length > 0 && agent.lastStep !== agent.error) {
		facts.push({ label: l10n.t('Last step'), detail: agent.lastStep, icon: 'history', tooltip: agent.lastStep });
	}
	if (agent.error !== undefined) {
		const problem = (agent.error === GENERIC_PROVIDER_ERROR ? explainFailure?.(agent.id) : undefined) ?? agent.error;
		facts.push({ label: l10n.t('Problem'), detail: problem, icon: 'warning', tooltip: problem });
	}
	return facts;
}
