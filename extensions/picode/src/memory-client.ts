/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading memory, and turning what comes back into words a person reads.
 *
 * The engine answers HTTP on the same machine: lists, one memory, conflicts, the review queue and
 * the doctor's report. This file knows the *shapes* of those answers and nothing else — no
 * `vscode`, no fetching, no clock — so every rule about "what counts as a memory" is pinned by
 * tests that run without an editor. `memory-view.ts` does the drawing.
 *
 * Why parse at all instead of trusting the JSON: this reads a store that another agent may have
 * been writing to minutes ago, from an engine PiCode did not build. A half-written row must become
 * *nothing on screen*, never a row with `undefined` in its title.
 */

/** One memory as the list shows it: enough for a row, not the whole body. */
export interface MemoryRow {
	readonly id: number;
	readonly title: string;
	readonly type: string;
	readonly project: string;
	readonly scope: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly revisions: number;
	readonly duplicates: number;
	readonly sessionId?: string;
}

/** One memory with its body: what the detail tab prints. */
export interface MemoryDetail extends MemoryRow {
	readonly content: string;
}

/** A disagreement the engine kept instead of resolving on its own. */
export interface MemoryConflict {
	readonly id: number;
	readonly fromId: number;
	readonly toId: number;
	readonly relationType: string;
}

export interface MemoryConflictList {
	readonly total: number;
	readonly rows: readonly MemoryConflict[];
}

export interface MemoryReviewQueue {
	readonly count: number;
	readonly rows: readonly MemoryRow[];
}

export interface MemoryDoctorCheck {
	readonly id: string;
	readonly result: string;
	readonly severity: string;
	readonly message: string;
	/** The engine's sentence on *why* the check exists — what makes a failure readable. */
	readonly why: string;
}

export interface MemoryDoctorReport {
	readonly status: string;
	readonly summary: { readonly total: number; readonly ok: number; readonly warnings: number; readonly blocked: number; readonly errors: number };
	readonly checks: readonly MemoryDoctorCheck[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stamp(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** One row, or `undefined` when it is not a memory this editor can show. */
function memoryRow(value: unknown): MemoryRow | undefined {
	const row = record(value);
	if (row === undefined) {
		return undefined;
	}
	const id = row['id'];
	const title = text(row['title']);
	if (typeof id !== 'number' || !Number.isFinite(id) || title === undefined || title.trim() === '') {
		return undefined;
	}
	const type = text(row['type']) ?? 'memory';
	const project = text(row['project']) ?? '—';
	const scope = text(row['scope']) ?? '';
	return {
		id,
		title: title.trim(),
		type,
		project,
		scope,
		createdAt: stamp(row['created_at']),
		updatedAt: stamp(row['updated_at'] ?? row['last_seen_at']),
		revisions: count(row['revision_count']),
		duplicates: count(row['duplicate_count']),
		sessionId: text(row['session_id']),
	};
}

/**
 * A list of memories. `undefined` means "this was not a list", which is different from an empty
 * one: the view says "nothing here yet" for the second and nothing at all for the first.
 */
export function parseMemoryRows(value: unknown): readonly MemoryRow[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const rows: MemoryRow[] = [];
	for (const entry of value) {
		const row = memoryRow(entry);
		if (row !== undefined) {
			rows.push(row);
		}
	}
	return rows;
}

export function parseMemoryDetail(value: unknown): MemoryDetail | undefined {
	const row = memoryRow(value);
	const body = record(value);
	if (row === undefined || body === undefined) {
		return undefined;
	}
	return { ...row, content: text(body['content']) ?? '' };
}

/**
 * The conflicts the engine kept. Both spellings are accepted because the pair arrives from a
 * different agent's writes: `from_id`/`to_id` is what this version answers, the bare `from`/`to`
 * is what a store written by an older engine holds, and a relationship either way is still worth
 * showing.
 */
export function parseMemoryConflicts(value: unknown): MemoryConflictList | undefined {
	const body = record(value);
	const list = body === undefined ? undefined : body['relations'];
	if (!Array.isArray(list)) {
		return undefined;
	}
	const rows: MemoryConflict[] = [];
	for (const entry of list) {
		const row = record(entry);
		if (row === undefined) {
			continue;
		}
		const id = row['id'];
		const from = row['from_id'] ?? row['from'];
		const to = row['to_id'] ?? row['to'];
		const relationType = text(row['relation_type'] ?? row['type']) ?? 'related';
		if (typeof id !== 'number' || typeof from !== 'number' || typeof to !== 'number') {
			continue;
		}
		rows.push({ id, fromId: from, toId: to, relationType });
	}
	const total = typeof body?.['total'] === 'number' ? body['total'] as number : rows.length;
	return { total, rows };
}

export function parseMemoryReview(value: unknown): MemoryReviewQueue | undefined {
	const body = record(value);
	const list = body === undefined ? undefined : body['observations'];
	const rows = parseMemoryRows(list ?? []);
	if (body === undefined || rows === undefined) {
		return undefined;
	}
	return { count: typeof body['count'] === 'number' ? body['count'] as number : rows.length, rows };
}

export function parseMemoryDoctor(value: unknown): MemoryDoctorReport | undefined {
	const body = record(value);
	const summary = record(body?.['summary']);
	const list = body?.['checks'];
	if (body === undefined || summary === undefined || !Array.isArray(list)) {
		return undefined;
	}
	const checks: MemoryDoctorCheck[] = [];
	for (const entry of list) {
		const row = record(entry);
		const id = text(row?.['check_id']);
		const result = text(row?.['result']);
		if (row === undefined || id === undefined || result === undefined) {
			continue;
		}
		checks.push({
			id,
			result,
			severity: text(row['severity']) ?? 'info',
			message: text(row['message']) ?? '',
			why: text(row['why']) ?? '',
		});
	}
	return {
		status: text(body['status']) ?? 'unknown',
		summary: {
			total: count(summary['total']),
			ok: count(summary['ok']),
			warnings: count(summary['warnings']),
			blocked: count(summary['blocked']),
			errors: count(summary['errors']),
		},
		checks,
	};
}

/** `2026-10-09 12:04`, in the reader's own timezone; empty when the engine sent no valid date. */
export function memoryWhen(iso: string): string {
	const at = new Date(iso);
	if (iso === '' || Number.isNaN(at.getTime())) {
		return '';
	}
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Who wrote a memory, in words: the session id's suffix is the name the writing agent gave itself
 * (`…@PiCode`). The identifier itself is never printed — it is machinery, and the owner's question
 * is "where did this come from", which "a PiCode session" already answers.
 */
export function memoryClientName(sessionId: string | undefined): string | undefined {
	if (sessionId === undefined) {
		return undefined;
	}
	const at = sessionId.lastIndexOf('@');
	const name = at === -1 ? '' : sessionId.slice(at + 1).trim();
	return name === '' ? undefined : name;
}

/**
 * The detail tab.
 *
 * The body comes first and untouched — it is the memory, and rewriting someone's decision text is
 * how a reader stops trusting the reader. The facts underneath are the same ones the row shows,
 * said once each: no id, no sync id, no file names.
 */
export function memoryDetailMarkdown(detail: MemoryDetail): string {
	const lines: string[] = [`# ${detail.title}`, '', detail.content.trim(), '', '---', ''];
	const facts: [string, string][] = [
		['Project', detail.project],
		['Type', detail.type],
		['Scope', detail.scope],
		['Saved', memoryWhen(detail.createdAt)],
		['Last seen', memoryWhen(detail.updatedAt)],
		['Revisions', detail.revisions > 1 ? String(detail.revisions) : ''],
		['Duplicates', detail.duplicates > 0 ? String(detail.duplicates) : ''],
		['Came from', memoryClientName(detail.sessionId) === undefined ? '' : `a ${memoryClientName(detail.sessionId)} session`],
	];
	for (const [label, value] of facts) {
		if (value !== '') {
			lines.push(`- **${label}:** ${value}`);
		}
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * The doctor's report, as the tab shows it.
 *
 * A check list of ten rows is a wall; what a person needs is the verdict, the failing rows with a
 * reason, and nothing else. Passing checks collapse into one line — their names are machinery, and
 * ten "ok"s have never comforted anybody.
 *
 * One failure deserves its sentence: a store whose cloud sync was once enrolled keeps rows for a
 * target that no longer exists, and the engine calls that an error. PiCode's memory never leaves
 * this machine, so the tab says so, instead of sending the owner to repair something harmless.
 */
export function memoryDoctorMarkdown(report: MemoryDoctorReport): string {
	const { summary } = report;
	const failing = report.checks.filter(check => check.result !== 'ok');
	// Cloud sync is not used here: PiCode's memory never leaves this machine. What the engine says
	// about it is a leftover, not a fault, so it is told apart from what needs the owner's attention.
	const cloud = failing.filter(check => check.id.startsWith('sync_'));
	const real = failing.filter(check => !check.id.startsWith('sync_'));
	if (failing.length === 0) {
		return `# Memory check\n\nEverything checked out: ${summary.total} checks, no problems.\n`;
	}
	const lines: string[] = ['# Memory check', ''];
	if (real.length === 0) {
		lines.push(`✅ Everything that matters checked out (${report.checks.length - cloud.length} of ${summary.total} checks).`);
	} else {
		lines.push(`${real.length} of ${summary.total} ${summary.total === 1 ? 'check needs' : 'checks need'} attention.`, '');
		for (const check of real) {
			const mark = check.severity === 'error' ? '❌' : check.severity === 'blocked' ? '⛔' : '⚠️';
			lines.push(`${mark} **${check.id.replace(/_/g, ' ')}** — ${check.message || 'needs attention'}`);
			if (check.why !== '') {
				lines.push('', `> ${check.why}`, '');
			}
		}
		const passed = report.checks.length - failing.length;
		if (passed > 0) {
			lines.push(`✅ ${passed} other ${passed === 1 ? 'check' : 'checks'} passed.`);
		}
	}
	if (cloud.length > 0) {
		lines.push(
			'',
			'☁️ Not used: cloud sync. Memory lives on this machine and PiCode keeps its cloud off, so',
			"the engine's note about it (leftover sync rows) changes nothing.",
		);
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
