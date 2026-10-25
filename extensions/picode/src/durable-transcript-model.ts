/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * One durable conversation, as the transcript tab draws it.
 *
 * Pure on purpose (no `vscode`), so `node --test` runs it directly and the shape of a transcript
 * is pinned by tests rather than by looking at a window.
 *
 * ## What it reads
 *
 * The daemon's own snapshot (`subscribe` answers with it) and the events it pushes afterwards.
 * Both carry `entries` in the durable storage format:
 *
 *   { id, kind, model: [Message], data?, conversationId, byTaskId? }
 *
 * with `kind` one of `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`,
 * `pi.compaction`, and `model[0]` the pi-ai message (`role`, `content`, `timestamp`, and for a
 * tool result `toolName` / `isError` / `durationMs`).
 *
 * ## What it produces
 *
 * A flat list of rows a person reads: the prompt, the answer (as markdown), one row per tool
 * CALL (name, the command it ran, its size and duration, folded to one line), and a notice for the
 * context marks. Nothing here knows about HTML.
 *
 * ## How a tool call and its result become one row
 *
 * The two halves are separate entries: `pi.assistant` carries `content[]` blocks of
 * `{ type: 'toolCall', id, name, arguments }`, and `pi.tool-result` carries
 * `model[0] = { role: 'toolResult', toolCallId, toolName, content, isError, durationMs }`. The
 * `id` of the call and the `toolCallId` of the result are the same string, so that is the link —
 * checked against a real conversation (281): 43 calls, 43 results, all 43 paired, none left over.
 * `byTaskId` is NOT the link: in that same conversation it disagreed with the call's entry on all
 * 43 (the call's entry belongs to one task, each result's entry to its own tool task).
 *
 * A call with no result yet is a row of its own (`status: 'running'`), and a call whose run ended
 * without a result is `status: 'no-result'` — the honest shape of a tool that was cancelled or
 * lost. Neither case occurs in 281; both are reachable (a Stop mid-tool), so they are modelled.
 *
 * ## Two limits, both said out loud
 *
 *  * The list keeps the newest `MAX_ROWS` rows and reports how many it dropped, because a
 *    transcript of 10 000 entries must not be pushed through a webview on every event.
 *  * A tool result larger than `MAX_TOOL_BYTES` is cut and flagged, because one `bash` that dumps
 *    a log must not freeze the tab.
 */

/** The newest rows a transcript keeps. Older ones are counted in `omitted`. */
export const MAX_ROWS = 500;

/** The largest tool output kept, in UTF-8 bytes. */
export const MAX_TOOL_BYTES = 128 * 1024;

export interface TranscriptToolCall {
	/** `content[].id` of the call: the string `pi.tool-result` repeats as `toolCallId`. */
	readonly id: string;
	/** The tool's name, as the model called it. */
	readonly name: string;
	/** One line for the folded row: the command it ran, or the arguments, shortened. */
	readonly summary: string;
	/** What the row shows when it is opened: the whole command, or the arguments in full. */
	readonly details: string;
}

export type TranscriptRow =
	/** What the person asked. Right-aligned bubble. */
	| { readonly kind: 'user'; readonly id: string; readonly text: string; readonly at?: number }
	/** What the agent answered, as markdown, plus the tools it announced in the same message. */
	| {
		readonly kind: 'assistant';
		readonly id: string;
		readonly markdown: string;
		/** Its reasoning, when the model produced any. Folded in the UI. */
		readonly thinking?: string;
		readonly toolCalls: readonly TranscriptToolCall[];
		readonly at?: number;
	}
	/**
	 * One tool CALL, folded to a summary line — result and call are the same row.
	 *
	 * `summary` is the one line the folded row shows (the command it ran), `details` what the
	 * opened row shows in full. Both come from the call; a result with no call in the frame (older
	 * than the kept window) simply has neither. `status` is present only while there is no result:
	 * `running` while the run is in flight, `no-result` once it ended without one.
	 */
	| {
		readonly kind: 'tool';
		readonly id: string;
		readonly name: string;
		readonly text: string;
		readonly lines: number;
		readonly bytes: number;
		readonly isError: boolean;
		readonly durationMs?: number;
		readonly truncated?: true;
		/** The call's id: the link to `pi.tool-result`'s `toolCallId`. */
		readonly toolCallId?: string;
		readonly summary?: string;
		readonly details?: string;
		readonly status?: 'running' | 'no-result';
		readonly at?: number;
	}
	/** A streak of tool calls, folded to one line. Its members are whole tool rows. */
	| {
		readonly kind: 'tool-group';
		readonly id: string;
		readonly calls: readonly TranscriptRow[];
		/** `bash ×3, read ×1`: what the folded line says it did. */
		readonly names: string;
		readonly totalBytes: number;
		readonly at?: number;
	}
	/** A context mark: the prompt was rebuilt, the context reset, or older entries were summarized. */
	| { readonly kind: 'notice'; readonly id: string; readonly text: string; readonly at?: number };

export interface TranscriptView {
	readonly conversationId: number;
	/** The rows to draw: calls paired with their results, and streaks gathered. */
	readonly rows: readonly TranscriptRow[];
	/**
	 * The rows as the entries built them, before pairing and grouping.
	 *
	 * Kept because a live entry has to be added to an unpaired list: pairing a row that was already
	 * paired, or grouping a group, would count the same call twice. It is not on the wire.
	 */
	readonly unpaired: readonly TranscriptRow[];
	/** How many entries the conversation has, whether or not they all fit in `rows`. */
	readonly entries: number;
	/** How many of the oldest entries `rows` does not show. */
	readonly omitted: number;
	/** Whether a run is in flight right now: the snapshot's own `run`. */
	readonly running: boolean;
	/** When the current (or last) run started, from the newest user entry's own timestamp. */
	readonly startedAt?: number;
	/** When this view was last computed, so the header's clock has an origin. */
	readonly at: number;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function numberOr(value: unknown, fallback?: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function textOf(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** The entries a snapshot or an event carries, without trusting either. */
function entriesOf(value: unknown): readonly unknown[] {
	const record = recordOf(value);
	return Array.isArray(record?.entries) ? record.entries : [];
}

/** `entry.model[0]`, falling back to `entry.data[0]`: the two places a message lives. */
function messageOf(entry: unknown): Record<string, unknown> | undefined {
	const record = recordOf(entry);
	for (const key of ['model', 'data']) {
		const list = record?.[key];
		if (Array.isArray(list) && list.length > 0) {
			return recordOf(list[0]);
		}
	}
	return undefined;
}

/**
 * The text of a message.
 *
 * `content` is either a string (user and system messages) or an array of blocks, of which only
 * `text` contributes to prose: `thinking` is collected apart and `toolCall` becomes a chip, so a
 * single message can carry all three without losing any of them.
 */
function blocksOf(message: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
	const content = message?.content;
	if (!Array.isArray(content)) {
		return [];
	}
	return content.map(recordOf).filter((block): block is Record<string, unknown> => block !== undefined);
}

function proseOf(message: Record<string, unknown> | undefined): string {
	const content = message?.content;
	if (typeof content === 'string') {
		return content;
	}
	return blocksOf(message)
		.filter(block => block.type === 'text')
		.map(block => textOf(block.text))
		.join('\n')
		.trim();
}

function thinkingOf(message: Record<string, unknown> | undefined): string {
	return blocksOf(message)
		.filter(block => block.type === 'thinking')
		.map(block => textOf(block.text) || textOf(block.thinking))
		.join('\n')
		.trim();
}

/** The first line that says something, shortened: what a folded row can show. */
function oneLine(text: string, limit = 120): string {
	const line = text.split('\n').find(candidate => candidate.trim().length > 0)?.trim() ?? '';
	return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * A call's two presentations: the one line a folded row shows, and the full text it opens to.
 *
 * A shell tool puts what the reader wants in `arguments.command` — the command, not JSON with the
 * command inside it — so that is preferred when it is there. Anything else is its arguments, as
 * JSON on one line for the summary and indented for the opened row.
 */
function callPresentations(argumentsValue: unknown): { summary: string; details: string } {
	const args = recordOf(argumentsValue);
	const command = typeof args?.command === 'string' ? args.command : undefined;
	if (command !== undefined && command.trim().length > 0) {
		return { summary: oneLine(command), details: command };
	}
	let compact = '';
	let indented = '';
	try {
		compact = typeof argumentsValue === 'string' ? argumentsValue : JSON.stringify(argumentsValue ?? {});
	} catch {
		compact = '';
	}
	try {
		indented = typeof argumentsValue === 'string' ? argumentsValue : JSON.stringify(argumentsValue ?? {}, null, 2);
	} catch {
		indented = compact;
	}
	return { summary: oneLine(compact), details: indented };
}

/** The tool calls a message announced, each with the id its result will repeat. */
function toolCallsOf(message: Record<string, unknown> | undefined): TranscriptToolCall[] {
	return blocksOf(message)
		.filter(block => block.type === 'toolCall')
		.map(block => ({
			id: textOf(block.id),
			name: textOf(block.name) || 'tool',
			...callPresentations(block.arguments),
		}));
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : text.split('\n').length;
}

/** UTF-8 size, without assuming `Buffer` exists. */
function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** One entry as a row, or `undefined` for an entry the transcript does not draw. */
function rowOf(entry: unknown): TranscriptRow | undefined {
	const record = recordOf(entry);
	if (record === undefined) {
		return undefined;
	}
	const id = textOf(record.id) || `entry-${Math.random().toString(36).slice(2)}`;
	const kind = textOf(record.kind);
	const message = messageOf(entry);
	const at = numberOr(message?.timestamp) ?? numberOr(record.at);

	switch (kind) {
		case 'pi.user': {
			const text = proseOf(message);
			return text.length === 0 && at === undefined ? undefined : { kind: 'user', id, text, ...(at === undefined ? {} : { at }) };
		}
		case 'pi.assistant': {
			const markdown = proseOf(message);
			const thinking = thinkingOf(message);
			const toolCalls = toolCallsOf(message);
			if (markdown.length === 0 && thinking.length === 0 && toolCalls.length === 0) {
				return undefined;
			}
			return {
				kind: 'assistant',
				id,
				markdown,
				...(thinking.length === 0 ? {} : { thinking }),
				toolCalls,
				...(at === undefined ? {} : { at }),
			};
		}
		case 'pi.tool-result': {
			const raw = proseOf(message);
			const bytes = byteLength(raw);
			const truncated = bytes > MAX_TOOL_BYTES;
			// Cut on characters, then say so: never a silent truncation.
			const text = truncated ? `${raw.slice(0, MAX_TOOL_BYTES)}\n… (truncated)` : raw;
			const durationMs = numberOr(message?.durationMs);
			const toolCallId = textOf(message?.toolCallId);
			return {
				kind: 'tool',
				id,
				name: textOf(message?.toolName) || 'tool',
				text,
				lines: lineCount(text),
				bytes,
				isError: message?.isError === true,
				...(toolCallId.length === 0 ? {} : { toolCallId }),
				...(durationMs === undefined ? {} : { durationMs }),
				...(truncated ? { truncated: true as const } : {}),
				...(at === undefined ? {} : { at }),
			};
		}
		case 'pi.system':
			return { kind: 'notice', id, text: 'The prompt context was rebuilt.', ...(at === undefined ? {} : { at }) };
		case 'pi.reset':
			return { kind: 'notice', id, text: 'A new context starts here.', ...(at === undefined ? {} : { at }) };
		case 'pi.compaction':
			return { kind: 'notice', id, text: 'Older entries were summarized.', ...(at === undefined ? {} : { at }) };
		default:
			return undefined;
	}
}

/** The newest `MAX_ROWS` rows, plus the count of what was dropped. */
function capped(rows: TranscriptRow[]): { rows: TranscriptRow[]; omitted: number } {
	if (rows.length <= MAX_ROWS) {
		return { rows, omitted: 0 };
	}
	return { rows: rows.slice(rows.length - MAX_ROWS), omitted: rows.length - MAX_ROWS };
}

/** How many consecutive calls make a streak worth folding. */
export const TOOL_GROUP_MIN = 3;

/** A done call with no error: the only thing a streak may hide. */
function foldable(row: TranscriptRow): boolean {
	return row.kind === 'tool' && row.status === undefined && !row.isError;
}

/** `bash ×3, read ×1` — in the order the tools were called. */
function namesOf(calls: readonly TranscriptRow[]): string {
	const counts = new Map<string, number>();
	for (const call of calls) {
		const name = call.kind === 'tool' ? call.name : 'tool';
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(', ');
}

/** Runs of `TOOL_GROUP_MIN` or more foldable calls become one row; errors and open calls never do. */
function folded(rows: readonly TranscriptRow[]): TranscriptRow[] {
	const out: TranscriptRow[] = [];
	let index = 0;
	while (index < rows.length) {
		if (!foldable(rows[index])) {
			out.push(rows[index]);
			index++;
			continue;
		}
		let end = index;
		while (end < rows.length && foldable(rows[end])) {
			end++;
		}
		const streak = rows.slice(index, end);
		if (streak.length < TOOL_GROUP_MIN) {
			out.push(...streak);
		} else {
			let totalBytes = 0;
			for (const row of streak) {
				if (row.kind === 'tool') {
					totalBytes += row.bytes;
				}
			}
			out.push({
				kind: 'tool-group',
				id: `group-${streak[0].id}`,
				calls: streak,
				names: namesOf(streak),
				totalBytes,
				...(streak[0].at === undefined ? {} : { at: streak[0].at }),
			});
		}
		index = end;
	}
	return out;
}

/**
 * The rows the tab draws, from the rows the entries built.
 *
 * Three passes, in this order because each one needs the previous one complete:
 *
 *  1. **Pair** a call with its result by id. The result row keeps its place in the transcript (it
 *     is the moment the call finished) and gains the call's one-line command and full text. A call
 *     with no result anywhere becomes a row of its own — `running` while the run is in flight,
 *     `no-result` once it ended without one — so a call is never invisible.
 *  2. **Drop** an assistant row that carries nothing but calls: those are rows now, and an empty
 *     bubble above them is the duplication this replaces.
 *  3. **Fold** streaks of done, successful calls (`TOOL_GROUP_MIN` or more).
 */
export function decorateRows(unpaired: readonly TranscriptRow[], running: boolean): TranscriptRow[] {
	const calls = new Map<string, TranscriptToolCall>();
	for (const row of unpaired) {
		if (row.kind === 'assistant') {
			for (const call of row.toolCalls) {
				if (call.id.length > 0) {
					calls.set(call.id, call);
				}
			}
		}
	}
	const answered = new Set<string>();
	for (const row of unpaired) {
		if (row.kind === 'tool' && row.toolCallId !== undefined) {
			answered.add(row.toolCallId);
		}
	}

	const paired: TranscriptRow[] = [];
	for (const row of unpaired) {
		if (row.kind === 'assistant') {
			const hasProse = row.markdown.trim().length > 0 || row.thinking !== undefined;
			if (hasProse) {
				// No chips: the call is a row of its own below, with its command and its result.
				paired.push({ ...row, toolCalls: [] });
			}
			for (const call of row.toolCalls) {
				if (call.id.length === 0 || answered.has(call.id)) {
					continue;
				}
				paired.push({
					kind: 'tool',
					id: `${row.id}#${call.id}`,
					name: call.name,
					text: '',
					lines: 0,
					bytes: 0,
					isError: false,
					toolCallId: call.id,
					summary: call.summary,
					details: call.details,
					status: running ? 'running' : 'no-result',
					...(row.at === undefined ? {} : { at: row.at }),
				});
			}
			continue;
		}
		if (row.kind === 'tool' && row.toolCallId !== undefined) {
			const call = calls.get(row.toolCallId);
			paired.push(call === undefined
				? row
				: { ...row, summary: call.summary, details: call.details });
			continue;
		}
		paired.push(row);
	}
	return folded(paired);
}

/** When the current (or last) run started: the newest user entry's timestamp. */
function startedAtOf(rows: readonly TranscriptRow[]): number | undefined {
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (row.kind === 'user' && row.at !== undefined) {
			return row.at;
		}
	}
	return rows[0]?.at;
}

/** A snapshot as the tab's first frame. */
export function transcriptOf(conversationId: number, snapshot: unknown, now: number): TranscriptView {
	const entries = entriesOf(snapshot);
	const rows: TranscriptRow[] = [];
	let omittedUnreadable = 0;
	for (const entry of entries) {
		const row = rowOf(entry);
		if (row === undefined) {
			omittedUnreadable++;
		} else {
			rows.push(row);
		}
	}
	const kept = capped(rows);
	const run = recordOf(recordOf(snapshot)?.run);
	const running = run !== undefined;
	return {
		conversationId,
		rows: decorateRows(kept.rows, running),
		unpaired: kept.rows,
		entries: entries.length || rows.length + omittedUnreadable,
		omitted: kept.omitted,
		running,
		...(startedAtOf(kept.rows) === undefined ? {} : { startedAt: startedAtOf(kept.rows) }),
		at: now,
	};
}

/**
 * One pushed event applied to the frame.
 *
 * Only the events that change what a reader sees are read: an entry that arrived, the run
 * starting or ending, and a fresh snapshot (a reconnect). Everything else — deltas, tool
 * progress, usage — returns the same object, so the caller can compare by identity and skip a
 * repaint.
 */
export function applyTranscriptEvent(view: TranscriptView, event: unknown, now: number): TranscriptView {
	const record = recordOf(event);
	if (record === undefined) {
		return view;
	}

	if (record.type === 'snapshot') {
		return transcriptOf(view.conversationId, record, now);
	}

	if (record.type === 'run_start') {
		return view.running ? view : { ...view, running: true, rows: decorateRows(view.unpaired, true), startedAt: view.startedAt ?? now, at: now };
	}

	if (record.type === 'run_end') {
		// A call that never got a result stops saying "running" here, and says it ended without one.
		return view.running ? { ...view, running: false, rows: decorateRows(view.unpaired, false), at: now } : view;
	}

	if (record.type === 'entry_appended' || record.type === 'message_end') {
		const entry = record.entry;
		const row = rowOf(entry);
		if (row === undefined) {
			return view;
		}
		// Idempotent by id: the same entry can arrive twice (snapshot then event, or a reconnect).
		if (view.unpaired.some(existing => existing.id === row.id)) {
			return view;
		}
		const rows = capped([...view.unpaired, row]);
		return {
			...view,
			rows: decorateRows(rows.rows, view.running),
			unpaired: rows.rows,
			entries: view.entries + 1,
			omitted: view.omitted + rows.omitted,
			at: now,
		};
	}

	return view;
}
