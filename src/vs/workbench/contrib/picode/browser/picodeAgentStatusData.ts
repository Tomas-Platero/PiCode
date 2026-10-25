/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License. See License.txt
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent-status pill, read as data.
 *
 * The pill above the chat input answers, in one line each: what the agent is doing right
 * now, how many requests of this window are waiting for their slot (with the way to cancel
 * them), and which background jobs are still running (`background-jobs.ts` keeps them).
 * What the core draws from a push is decided here, so the shapes stay honest without a
 * chat window: a job with no label names itself by its number, a push that is not a status
 * reads as nothing, and the elapsed time is computed on the reader's own clock — a row
 * never carries a stale "5m" with it.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

/** One row as the connector pushes it (`background-jobs.ts` `BackgroundJobRow`). */
export interface PillJobRow {
	readonly jobNumber: string;
	readonly label?: string;
	readonly command?: string;
	readonly startedAt: number;
}

/** The whole status the connector pushes (`agent.ts` `AgentStatusPush`). */
export interface PillStatus {
	readonly jobs: readonly PillJobRow[];
	readonly running: boolean;
	readonly activity?: string;
	readonly queued: number;
}

/** A non-empty string from an unknown value, or `undefined`. */
function textOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Whether an unknown value is the list of rows the pill was told about. */
function isPillJobRows(value: unknown): value is readonly PillJobRow[] {
	if (!Array.isArray(value)) {
		return false;
	}
	return value.every(row => {
		const record = typeof row === 'object' && row !== null ? row as Record<string, unknown> : undefined;
		return record !== undefined && typeof record['jobNumber'] === 'string' && record['jobNumber'].length > 0;
	});
}

/** The rows actually usable by the pill: well-formed rows in, junk dropped. */
export function pillRowsOf(value: unknown): readonly PillJobRow[] {
	if (!isPillJobRows(value)) {
		return [];
	}
	const rows: PillJobRow[] = [];
	for (const row of value) {
		if (!Number.isFinite(row.startedAt)) {
			continue;
		}
		const label = textOf(row.label);
		const command = textOf(row.command);
		rows.push({
			jobNumber: row.jobNumber,
			...(label === undefined ? {} : { label }),
			...(command === undefined ? {} : { command }),
			startedAt: row.startedAt,
		});
	}
	return rows;
}

/**
 * The push the connector sent, as the pill reads it.
 *
 * A push that is not a status object — an older connector carrying the old background-only
 * shape, or junk — yields jobs only when they are readable, and never invents running or
 * queued facts. The status is only replaced by a push that is understood.
 */
export function agentStatusOf(raw: unknown): PillStatus | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const running = record['running'] === true;
	const queuedRaw = record['queued'];
	const queued = typeof queuedRaw === 'number' && Number.isInteger(queuedRaw) && queuedRaw > 0 ? queuedRaw : 0;
	const activity = textOf(record['activity']);
	const jobs = pillRowsOf(record['backgroundJobs']);
	if (!running && queued === 0 && activity === undefined && jobs.length === 0) {
		return undefined;
	}
	return {
		jobs,
		running,
		...(activity === undefined ? {} : { activity }),
		queued,
	};
}

/** Milliseconds as a short human sentence: "45s", "5m", "2h". */
export function elapsedLabel(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h`;
}

/** What the pill's jobs row shows: the count, and the oldest job's name when there is one. */
export function pillFace(rows: readonly PillJobRow[], now: number): { count: number; detail?: string } {
	if (rows.length === 0) {
		return { count: 0 };
	}
	// The oldest job is found, not assumed to be first: the push's order is not a contract.
	const oldest = rows.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
	const name = textOf(oldest.label) ?? textOf(oldest.command) ?? `job ${oldest.jobNumber}`;
	const shown = name.length > 40 ? `${name.slice(0, 39)}…` : name;
	return { count: rows.length, detail: `${shown} · ${elapsedLabel(oldest.startedAt, now)}` };
}

/** The line one job's tooltip carries: what it is called, what it runs, how long. */
export function pillTooltipLine(row: PillJobRow, now: number): string {
	const name = textOf(row.label) ?? textOf(row.command) ?? `job ${row.jobNumber}`;
	const command = textOf(row.command);
	const suffix = command !== undefined && command !== name ? ` — ${command}` : '';
	return `${name}${suffix} · ${elapsedLabel(row.startedAt, now)}`;
}
