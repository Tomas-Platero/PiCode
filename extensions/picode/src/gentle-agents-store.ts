/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The subagents gentle-pi runs, as the chat can see them.
 *
 * gentle-pi publishes the live state of its subagents to an interactive host through pi's one
 * structured push, `setWidget(key, lines)`: under the key `gentle-agents`, one JSON line shaped
 * `gentle-agents.activity/v1` (a summary and one entry per task). It does so only when pi runs
 * with the interactive-host signal (`product-env.ts`) in a mode that has a UI. This module reads
 * that line into rows the Tasks block can draw, and holds the last answer.
 *
 * Nothing is invented: a line that is not that schema, or is malformed, leaves what was known
 * untouched. Only a whitelisted handful of fields is kept — the prompt, the thread and the tool
 * output never reach the screen from here.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** The widget key gentle-pi publishes under. */
export const GENTLE_AGENTS_WIDGET_KEY = 'gentle-agents';

/** The schema tag every published line carries. */
export const GENTLE_AGENTS_SCHEMA = 'gentle-agents.activity/v1';

/** The states a task can be in, as gentle-pi names them. */
export type AgentTaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

const STATUSES: readonly AgentTaskStatus[] = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'timed_out'];

/** One subagent task, reduced to what a person asks about it. */
export interface AgentTaskRow {
	readonly id: string;
	/** The role that runs it (`review-risk`, `gentle-ai-worker`…). */
	readonly agent: string;
	/** Three to six words naming the work, as the parent gave them; may be empty. */
	readonly label: string;
	readonly status: AgentTaskStatus;
	readonly startedAt: number | undefined;
	readonly endedAt: number | undefined;
	/** The last thing the task did: a tool name, `responded`, an error. */
	readonly lastStep: string;
	readonly turns: number;
	readonly toolCalls: number;
	readonly error: string | undefined;
}

/** Whether a status means the task is still going. */
export function isActiveStatus(status: AgentTaskStatus): boolean {
	return status === 'queued' || status === 'running' || status === 'waiting';
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stamp(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** One task from its published summary, or `undefined` when it does not name a task. */
function rowOf(summary: unknown): AgentTaskRow | undefined {
	if (typeof summary !== 'object' || summary === null) {
		return undefined;
	}
	const record = summary as Record<string, unknown>;
	const id = text(record['id']);
	const status = STATUSES.find(candidate => candidate === record['status']);
	if (id.length === 0 || status === undefined) {
		return undefined;
	}
	const error = text(record['error']);
	return {
		id,
		agent: text(record['agent']),
		label: text(record['label']),
		status,
		startedAt: stamp(record['startedAt']),
		endedAt: stamp(record['endedAt']),
		lastStep: text(record['lastStep']),
		turns: count(record['turns']),
		toolCalls: count(record['toolCalls']),
		error: error.length === 0 ? undefined : error,
	};
}

/**
 * The tasks a push carries, in the order gentle-pi published them (running first, then waiting,
 * queued, and the finished ones newest first), or `undefined` when the push is not an activity
 * line this reader understands.
 */
export function parseAgentActivity(lines: readonly string[]): AgentTaskRow[] | undefined {
	const line = lines.find(candidate => candidate.includes(GENTLE_AGENTS_SCHEMA));
	if (line === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const activity = parsed as { schema?: unknown; tasks?: unknown };
	if (activity.schema !== GENTLE_AGENTS_SCHEMA || !Array.isArray(activity.tasks)) {
		return undefined;
	}
	const rows: AgentTaskRow[] = [];
	for (const task of activity.tasks) {
		const row = rowOf(typeof task === 'object' && task !== null ? (task as { summary?: unknown }).summary : undefined);
		if (row !== undefined) {
			rows.push(row);
		}
	}
	return rows;
}

/** One listener of the store's movement. */
type Listener = () => void;

/** The holder of the last answer, with listeners; one per window. */
export class GentleAgentsStore {
	private rows: readonly AgentTaskRow[] = [];
	private readonly listeners = new Set<Listener>();

	/** The tasks as last published. */
	current(): readonly AgentTaskRow[] {
		return this.rows;
	}

	/** Takes one `setWidget` push; anything that is not gentle-pi's activity line is ignored. */
	publish(key: string, content: unknown): void {
		if (key !== GENTLE_AGENTS_WIDGET_KEY) {
			return;
		}
		if (content === undefined) {
			this.clear();
			return;
		}
		if (!Array.isArray(content) || !content.every(entry => typeof entry === 'string')) {
			return;
		}
		const rows = parseAgentActivity(content as string[]);
		if (rows === undefined) {
			return;
		}
		this.rows = rows;
		this.fire();
	}

	/** Forgets everything: the session that published it is gone. */
	clear(): void {
		if (this.rows.length === 0) {
			return;
		}
		this.rows = [];
		this.fire();
	}

	/** Calls `listener` whenever the tasks change; returns how to stop. */
	onDidChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private fire(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A listener that throws is that listener's problem.
			}
		}
	}
}

/** The window's one store: the chat's bridge writes it, the Tasks block reads it. */
export const gentleAgents = new GentleAgentsStore();
