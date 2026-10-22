/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Saving to memory, as the chat says it.
 *
 * Every tool the turn runs leaves a row in the transcript, and for a memory write that row used to
 * say its own internal name and nothing a person could read: `mcp__engram__mem_save` with the
 * arguments in JSON. The owner's question — *did it keep that?* — was answered by a collapsed row in
 * a language he does not speak. These are the sentences that answer it: what is being kept, that it
 * was kept, and where it went.
 *
 * No `vscode` import and no clock: everything here is a pure function of the pi tool event, so
 * `node --test` runs this file directly, the same rule `durable-cards.ts` keeps.
 *
 * Only the tools that **put something permanent in the store** speak this way — saving, updating,
 * and a consolidation that was actually confirmed. Searching, pinning and recording a verdict are
 * work on memory, not memory being kept, and they keep the ordinary row: a chat that announces
 * "saved" for a lookup teaches the reader to stop reading the announcements.
 */

/** The engine's tool names that create or change a memory. */
const SAVE_TOOL = 'mem_save';
const UPDATE_TOOL = 'mem_update';
const CONSOLIDATE_TOOL = 'mem_consolidate';

/** How long a memory's title is shown in one line of the transcript. */
export const CARD_TITLE_CHARS = 120;

/**
 * pi names an MCP tool `mcp__<server>__<tool>`, and the server's name is the owner's to choose, so
 * the engine's own tool name is the last segment rather than a fixed prefix.
 */
function engineToolName(toolName: unknown): string | undefined {
	if (typeof toolName !== 'string' || toolName.length === 0) {
		return undefined;
	}
	const lower = toolName.toLowerCase();
	const marker = lower.lastIndexOf('__');
	return marker === -1 ? lower : lower.slice(marker + 2);
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
				? parsed as Record<string, unknown>
				: undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** One string field of the call's arguments, trimmed, or `undefined` when it is absent or empty. */
function textOf(args: unknown, ...keys: readonly string[]): string | undefined {
	const record = recordOf(args);
	if (record === undefined) {
		return undefined;
	}
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

/** A title capped for one line, with the ellipsis that says it was cut. */
function cappedTitle(value: string): string {
	return value.length > CARD_TITLE_CHARS ? `${value.slice(0, CARD_TITLE_CHARS - 1)}…` : value;
}

/**
 * Whether this call is memory being kept.
 *
 * `mem_consolidate` previews without writing unless it is confirmed, so an unconfirmed call is a
 * plan on screen and not a change to the store: it keeps the ordinary row, because announcing a
 * save that did not happen is worse than announcing nothing.
 */
export function isMemoryWriteCall(toolName: unknown, args: unknown): boolean {
	const engineTool = engineToolName(toolName);
	if (engineTool === SAVE_TOOL || engineTool === UPDATE_TOOL) {
		return true;
	}
	if (engineTool !== CONSOLIDATE_TOOL) {
		return false;
	}
	const record = recordOf(args);
	return record?.['confirm'] === true || record?.['confirm'] === 'true';
}

/** What the row says while the call runs, when it ends, and when it fails. */
export interface MemoryCard {
	readonly toolName: string;
	/** The three sentences, already carrying the memory's title and, when known, where it lands. */
	readonly running: string;
	readonly done: string;
	readonly failed: string;
}

/** Where a memory lands, said the one way the card says it: `picode`, or `picode · convention`. */
function whereOf(args: unknown): string | undefined {
	const project = textOf(args, 'project', 'expected_project');
	const scope = textOf(args, 'scope');
	if (project === undefined) {
		return scope;
	}
	return scope === undefined ? project : `${project} · ${scope}`;
}

/**
 * The card for a memory write, or `undefined` when this call is not one.
 *
 * The title comes from the call's own arguments — the memory is described by the model before the
 * engine answers, and that is the moment the reader wants to see it. A call with no title (an
 * update that only changed the body) still gets its sentence; it just names the memory by its id,
 * which is the same thing the engine would.
 */
export function memoryCard(toolName: unknown, args: unknown): MemoryCard | undefined {
	if (!isMemoryWriteCall(toolName, args)) {
		return undefined;
	}
	const engineTool = engineToolName(toolName) ?? '';
	const title = textOf(args, 'title', 'new_title');
	const id = textOf(args, 'id');
	const named = title !== undefined
		? `"${cappedTitle(title)}"`
		: id !== undefined ? `#${id}` : undefined;
	const where = whereOf(args);

	if (engineTool === UPDATE_TOOL) {
		const subject = named ?? 'the memory';
		return {
			toolName: String(toolName),
			running: `Updating ${subject} in memory…`,
			done: `Updated ${subject} in memory${where === undefined ? '' : ` · ${where}`}`,
			failed: `Could not update ${subject} in memory`,
		};
	}
	if (engineTool === CONSOLIDATE_TOOL) {
		const subject = named ?? 'memories';
		return {
			toolName: String(toolName),
			running: `Merging memories into ${subject}…`,
			done: `Merged memories into ${subject}${where === undefined ? '' : ` · ${where}`}`,
			failed: `Could not merge memories into ${subject}`,
		};
	}

	const subject = named ?? 'this memory';
	return {
		toolName: String(toolName),
		running: `Saving ${subject} to memory…`,
		done: `Saved ${subject} to memory${where === undefined ? '' : ` · ${where}`}`,
		failed: `Could not save ${subject} to memory`,
	};
}
