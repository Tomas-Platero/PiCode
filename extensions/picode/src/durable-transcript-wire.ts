/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The transcript, on the wire: the exact shape the webview receives.
 *
 * It lives apart from `durable-transcript-view.ts` — which imports `vscode` and so cannot be
 * loaded by `node --test` — because this mapping is where a field can be forgotten in silence.
 * It was: the finished-run clock read `at` from a frame that never carried it, and the header
 * said "NaNs total". A mapping deserves a test precisely when dropping one key is invisible.
 *
 * Nothing here decides anything: rows arrive already built and already rendered (the agent's
 * markdown becomes HTML in the host, never in the page), and this file only names the fields the
 * page reads.
 */

import type { TranscriptRow, TranscriptView } from './durable-transcript-model';

export interface WireTool {
	readonly name: string;
	/** The one line the folded row shows: the command it ran, or its arguments. */
	readonly summary?: string;
	/** What the opened row shows in full: the command, or the arguments indented. */
	readonly details?: string;
	readonly text: string;
	readonly lines: number;
	readonly bytes: number;
	readonly isError: boolean;
	readonly durationMs?: number;
	readonly truncated?: true;
	/** Present only with no result yet: `running`, or `no-result` once the run ended without one. */
	readonly status?: 'running' | 'no-result';
}

export interface WireRow {
	readonly id: string;
	readonly kind: 'user' | 'assistant' | 'tool' | 'tool-group' | 'notice';
	readonly at?: number;
	/** user, notice: plain text. */
	readonly text?: string;
	/** assistant: HTML built by `renderMarkdown` on the host side, never by the model. */
	readonly html?: string;
	readonly thinking?: string;
	readonly tool?: WireTool;
	/** tool-group: the calls the folded line stands for, each a whole tool row. */
	readonly group?: {
		readonly names: string;
		readonly count: number;
		readonly totalBytes: number;
		readonly calls: readonly WireTool[];
	};
}

export interface WireView {
	readonly conversationId: number;
	readonly rows: readonly WireRow[];
	readonly entries: number;
	readonly omitted: number;
	readonly running: boolean;
	/** When the run started (`running`) or ended (`done`): the header's clock subtracts this. */
	readonly startedAt?: number;
	/**
	 * When this frame was computed.
	 *
	 * The header needs it to close the clock: `at - startedAt` is the run's total once the run
	 * ended. Omitting it is what produced "NaNs total", so the wire shape requires it.
	 */
	readonly at: number;
	readonly connection: 'live' | 'reconnecting' | 'offline';
}

/** One tool row, in the shape the page draws. */
function wireTool(row: Extract<TranscriptRow, { kind: 'tool' }>): WireTool {
	return {
		name: row.name,
		...(row.summary === undefined ? {} : { summary: row.summary }),
		...(row.details === undefined ? {} : { details: row.details }),
		text: row.text,
		lines: row.lines,
		bytes: row.bytes,
		isError: row.isError,
		...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
		...(row.truncated === undefined ? {} : { truncated: row.truncated }),
		...(row.status === undefined ? {} : { status: row.status }),
	};
}

export function wireRow(row: TranscriptRow, renderMarkdown: (markdown: string) => string): WireRow {
	switch (row.kind) {
		case 'user':
			return { id: row.id, kind: 'user', text: row.text, ...(row.at === undefined ? {} : { at: row.at }) };
		case 'assistant':
			return {
				id: row.id,
				kind: 'assistant',
				// The markdown is rendered on this side: the page never sees markdown, only safe HTML.
				html: renderMarkdown(row.markdown),
				...(row.thinking === undefined ? {} : { thinking: row.thinking }),
				...(row.at === undefined ? {} : { at: row.at }),
			};
		case 'tool':
			return {
				id: row.id,
				kind: 'tool',
				tool: wireTool(row),
				...(row.at === undefined ? {} : { at: row.at }),
			};
		case 'tool-group':
			return {
				id: row.id,
				kind: 'tool-group',
				group: {
					names: row.names,
					count: row.calls.length,
					totalBytes: row.totalBytes,
					calls: row.calls.map(call => (call.kind === 'tool' ? wireTool(call) : undefined)).filter((tool): tool is WireTool => tool !== undefined),
				},
				...(row.at === undefined ? {} : { at: row.at }),
			};
		case 'notice':
			return { id: row.id, kind: 'notice', text: row.text, ...(row.at === undefined ? {} : { at: row.at }) };
	}
}

export function wireView(view: TranscriptView, connection: WireView['connection'], renderMarkdown: (markdown: string) => string): WireView {
	return {
		conversationId: view.conversationId,
		rows: view.rows.map(row => wireRow(row, renderMarkdown)),
		entries: view.entries,
		omitted: view.omitted,
		running: view.running,
		...(view.startedAt === undefined ? {} : { startedAt: view.startedAt }),
		at: view.at,
		connection,
	};
}

/**
 * The header's clock, in one place: how long a run took, or has been going.
 *
 * Pure and total — never `NaN`, never a negative number — because it is fed by two clocks (the
 * frame's `at` and the page's own `Date.now()`), and a missing value must degrade to "no clock"
 * rather than to a number that looks like one.
 */
export function elapsedMs(startedAt: number | undefined, until: number | undefined): number | undefined {
	if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
		return undefined;
	}
	if (typeof until !== 'number' || !Number.isFinite(until)) {
		return undefined;
	}
	return Math.max(0, until - startedAt);
}
