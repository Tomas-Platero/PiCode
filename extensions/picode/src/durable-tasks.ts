/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable daemon's work, as the status panel can list it.
 *
 * The daemon's `sessions` method answers one row per conversation: its id, entry count,
 * newest entry, and a `note` that says what the conversation **is** — `subagent (task …)`
 * when a background anchor task owns it, `fork of …` when it is a fork, empty when it is
 * ownerless. The note is durable's own wording (`picode-source/durable/lib/common.js`
 * `listConversations`), parsed here as the tolerant reader every other daemon shape gets.
 *
 * The protocol carries no task-level state — not a phase, not an outcome. What it does
 * carry, live, is each conversation's snapshot: `run` is present while a run is in flight
 * and absent when the conversation is idle (`pi-durable`'s `SnapshotEvent`). That presence
 * is the only honest "state" a row can show, and a conversation the reader could not
 * snapshot at all says so instead of guessing.
 *
 * No `vscode` import, and every mapping is a pure function of the daemon's answers — so
 * `node --test` can run this file directly.
 */

/** One conversation as the daemon's `sessions` lists it. */
export interface DurableConversationRow {
	readonly id: number;
	readonly entries: number;
	readonly newest?: string;
	readonly note?: string;
}

/** One row of durable work, as the status panel draws it. */
export interface DurableWorkRow {
	readonly conversationId: number;
	/** The ownership task id durable itself assigned, when the conversation is subagent-owned. */
	readonly taskId?: string;
	/**
	 * Whether a run is in flight in the conversation right now: the snapshot's own `run`
	 * presence. `undefined` when the conversation could not be snapshotted — said, never guessed.
	 */
	readonly inFlight: boolean | undefined;
	readonly entries: number;
	readonly newest?: string;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** A non-empty string from an unknown value, or `undefined`. */
function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The ownership task id a session note carries, or `undefined`.
 *
 * The note is durable's own sentence, `subagent (task <id>)`; the id is whatever durable
 * put between the parentheses — this reader does not judge its shape.
 */
export function subagentTaskIdOf(note: unknown): string | undefined {
	const value = text(note);
	if (value === undefined || !value.startsWith('subagent')) {
		return undefined;
	}
	const match = /^subagent\s*\((?:task\s+)?([^)]+)\)$/.exec(value.trim());
	return match === null ? undefined : match[1].trim();
}

/** Whether a session's note says a background subagent task owns it. */
export function isSubagentConversation(note: unknown): boolean {
	return subagentTaskIdOf(note) !== undefined;
}

/**
 * Whether a conversation's snapshot says a run is in flight.
 *
 * `run` is present on the snapshot while a run is in flight and absent otherwise;
 * anything that is not a snapshot object is "could not be read" (`undefined`), so a
 * mangled answer is said as such instead of read as idle.
 */
export function snapshotInFlight(snapshot: unknown): boolean | undefined {
	const record = recordOf(snapshot);
	if (record === undefined) {
		return undefined;
	}
	return 'run' in record;
}

/**
 * The durable work worth one row each: the subagent-owned conversations, plus any other
 * conversation with a run in flight.
 *
 * Rows in flight lead (the work happening now), each group keeping conversation order.
 * A conversation that is neither subagent-owned nor in flight leads nowhere and gets no
 * row — the counts above the list already say how many conversations the daemon holds.
 * Conversations the reader could not snapshot keep their row with `inFlight: undefined`.
 */
export function durableWorkRows(
	conversations: readonly DurableConversationRow[],
	inFlightById: ReadonlyMap<number, boolean | undefined>,
): DurableWorkRow[] {
	const rows: DurableWorkRow[] = [];
	for (const conversation of conversations) {
		if (typeof conversation.id !== 'number' || !Number.isFinite(conversation.id)) {
			continue;
		}
		const taskId = subagentTaskIdOf(conversation.note);
		const inFlight = inFlightById.get(conversation.id);
		if (taskId === undefined && inFlight !== true) {
			continue;
		}
		rows.push({
			conversationId: conversation.id,
			...(taskId === undefined ? {} : { taskId }),
			inFlight,
			entries: typeof conversation.entries === 'number' ? conversation.entries : 0,
			...(text(conversation.newest) === undefined ? {} : { newest: conversation.newest }),
		});
	}
	const inFlightFirst = (a: DurableWorkRow, b: DurableWorkRow): number => {
		const aLive = a.inFlight === true ? 0 : 1;
		const bLive = b.inFlight === true ? 0 : 1;
		return aLive !== bLive ? aLive - bLive : a.conversationId - b.conversationId;
	};
	return rows.sort(inFlightFirst);
}
