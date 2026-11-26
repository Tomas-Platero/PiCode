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
	readonly model?: string;
	readonly activeTool?: string;
	readonly usedTokens?: number;
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

/**
 * What each task of a push said and did so far, keyed by task id, in the shape of gentle's own task
 * record (`{task, thread}`) so one page builder reads both. The push keeps only the latest steps
 * and cuts long outputs; `thread.dropped` says how many steps were left out.
 */
export function parseAgentRecords(lines: readonly string[]): Map<string, unknown> | undefined {
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
	const tasks = (parsed as { tasks?: unknown } | null)?.tasks;
	if (!Array.isArray(tasks)) {
		return undefined;
	}
	const records = new Map<string, unknown>();
	for (const entry of tasks) {
		const { summary, thread } = (entry ?? {}) as { summary?: { id?: unknown }; thread?: unknown };
		if (typeof summary?.id === 'string' && summary.id.length > 0) {
			records.set(summary.id, { task: summary, thread });
		}
	}
	return records;
}

/** One listener of the store's movement. */
type Listener = () => void;
type AgentProgress = { model?: string; activeTool?: string; usedTokens?: number };

/** The holder of the last answer, with listeners; one per window. */
export class GentleAgentsStore {
	private rows: readonly AgentTaskRow[] = [];
	private owner: string | undefined;
	private readonly progress = new Map<string | undefined, { source?: object; agents: Map<string, AgentProgress> }>();
	private records = new Map<string, unknown>();
	private readonly listeners = new Set<Listener>();

	/** What one task has said and done so far, as last published, or `undefined` when it is not in the last push. */
	record(id: string): unknown {
		return this.records.get(id);
	}

	/** The tasks as last published. */
	current(): readonly AgentTaskRow[] {
		return this.rows;
	}

	/** Takes one `setWidget` push; anything that is not gentle-pi's activity line is ignored. */
	publish(key: string, content: unknown, owner?: string): void {
		if (key !== GENTLE_AGENTS_WIDGET_KEY) {
			return;
		}
		if (content === undefined) {
			if (this.owner === owner) { this.clear(); }
			return;
		}
		if (!Array.isArray(content) || !content.every(entry => typeof entry === 'string')) {
			return;
		}
		const rows = parseAgentActivity(content as string[]);
		if (rows === undefined) {
			return;
		}
		this.owner = owner;
		const progress = this.progress.get(owner)?.agents;
		this.rows = rows.map(row => {
			const next = progress?.get(row.id);
			return next === undefined ? row : { ...row, ...next };
		});
		this.records = parseAgentRecords(content as string[]) ?? new Map();
		this.fire();
	}

	/** Bind progress to this particular session, invalidating a replaced session of the same chat. */
	beginProgress(owner: string, source: object): void {
		this.progress.set(owner, { source, agents: new Map() });
		this.clearVisibleProgress(owner);
	}

	/** Stop only the session that owns the retained reading. */
	endProgress(owner: string, source: object): void {
		if (this.progress.get(owner)?.source !== source) { return; }
		this.progress.delete(owner);
		this.clearVisibleProgress(owner);
	}

	private clearVisibleProgress(owner: string): void {
		if (owner !== this.owner) { return; }
		let changed = false;
		this.rows = this.rows.map(row => {
			if (row.model === undefined && row.activeTool === undefined && row.usedTokens === undefined) { return row; }
			changed = true;
			return { ...row, model: undefined, activeTool: undefined, usedTokens: undefined };
		});
		if (changed) { this.fire(); }
	}

	/** Retain only bounded, safe fields per session, even before its first widget arrives. */
	publishProgress(agents: readonly unknown[], owner?: string, source?: object): void {
		const existing = this.progress.get(owner);
		if (source !== undefined && existing?.source !== source) { return; }
		if (source === undefined && existing?.source !== undefined) { return; }
		const progress = new Map<string, AgentProgress>();
		for (const item of agents) {
			if (typeof item !== 'object' || item === null) { continue; }
			const value = item as { id?: unknown; model?: unknown; activeTool?: unknown; usage?: { total?: unknown } };
			if (typeof value.id !== 'string') { continue; }
			const model = typeof value.model === 'string' && /^[a-zA-Z0-9][\w./-]{0,127}$/.test(value.model) && !value.model.includes('..') ? value.model : undefined;
			const activeTool = typeof value.activeTool === 'string' && /^[\w.-]{1,80}$/.test(value.activeTool) ? value.activeTool : undefined;
			const total = value.usage?.total;
			const usedTokens = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : undefined;
			progress.set(value.id, { model, activeTool, usedTokens });
		}
		this.progress.set(owner, { source, agents: progress });
		if (owner !== this.owner) { return; }
		let changed = false;
		this.rows = this.rows.map(row => {
			const next = progress.get(row.id);
			if (next === undefined) {
				if (row.model === undefined && row.activeTool === undefined && row.usedTokens === undefined) { return row; }
				changed = true;
				return { ...row, model: undefined, activeTool: undefined, usedTokens: undefined };
			}
			if (row.model === next.model && row.activeTool === next.activeTool && row.usedTokens === next.usedTokens) { return row; }
			changed = true;
			return { ...row, ...next };
		});
		if (changed) { this.fire(); }
	}

	/** Forgets everything: the session that published it is gone. */
	clear(): void {
		this.owner = undefined;
		if (this.rows.length === 0) {
			return;
		}
		this.rows = [];
		this.records = new Map();
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
