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
 * A flat list of rows a person reads: the prompt, the answer (as markdown), each tool result
 * (folded to one line), and a notice for the context marks. Nothing here knows about HTML.
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
	/** The tool's name, as the model called it. */
	readonly name: string;
	/** Its arguments, serialized and shortened: a chip in the bubble, not a document. */
	readonly args: string;
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
	/** One tool result, folded to a summary line. `isError` is what the UI paints red. */
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
		readonly at?: number;
	}
	/** A context mark: the prompt was rebuilt, the context reset, or older entries were summarized. */
	| { readonly kind: 'notice'; readonly id: string; readonly text: string; readonly at?: number };

export interface TranscriptView {
	readonly conversationId: number;
	readonly rows: readonly TranscriptRow[];
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

/** A tool call, as the chip shows it: the name and a shortened argument list. */
function toolCallsOf(message: Record<string, unknown> | undefined): TranscriptToolCall[] {
	return blocksOf(message)
		.filter(block => block.type === 'toolCall')
		.map(block => {
			const args = block.arguments;
			let serialized = '';
			try {
				serialized = typeof args === 'string' ? args : JSON.stringify(args ?? {});
			} catch {
				serialized = '';
			}
			return { name: textOf(block.name) || 'tool', args: serialized.length > 120 ? `${serialized.slice(0, 120)}…` : serialized };
		});
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
			return {
				kind: 'tool',
				id,
				name: textOf(message?.toolName) || 'tool',
				text,
				lines: lineCount(text),
				bytes,
				isError: message?.isError === true,
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
	return {
		conversationId,
		rows: kept.rows,
		entries: entries.length || rows.length + omittedUnreadable,
		omitted: kept.omitted,
		running: run !== undefined,
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
		return view.running ? view : { ...view, running: true, startedAt: view.startedAt ?? now, at: now };
	}

	if (record.type === 'run_end') {
		return view.running ? { ...view, running: false, at: now } : view;
	}

	if (record.type === 'entry_appended' || record.type === 'message_end') {
		const entry = record.entry;
		const row = rowOf(entry);
		if (row === undefined) {
			return view;
		}
		// Idempotent by id: the same entry can arrive twice (snapshot then event, or a reconnect).
		if (view.rows.some(existing => existing.id === row.id)) {
			return view;
		}
		const rows = capped([...view.rows, row]);
		return {
			...view,
			rows: rows.rows,
			entries: view.entries + 1,
			omitted: view.omitted + rows.omitted,
			at: now,
		};
	}

	return view;
}
