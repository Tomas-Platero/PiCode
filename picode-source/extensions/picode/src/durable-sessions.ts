/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable daemon's conversations, as the editor's Sessions panel can list them.
 *
 * The durable conversations live in the daemon's SQLite (`data/durable`), and the daemon is
 * the ONE owner of it — nothing here opens the file; `durable-sessions-register.ts` carries
 * the daemon client and the editor registration. This module is the mapping itself, pure:
 * from the daemon's `sessions` rows and each conversation's `subscribe` snapshot it builds
 * the three things a panel row needs — the **first user prompt** as its label, the **model
 * messages' own timestamps** as its dates, and, for opening, the **user/assistant turns** as
 * a read-only replay (thinking and tool results stay out, the same plumbing rule the pi
 * transcripts' replay keeps).
 *
 * What the mapping refuses to do is lie: the daemon carries no per-conversation timestamp of
 * its own, so the dates come from the transcript's messages — and a conversation whose
 * transcript could not be read shows `Conversation N` with no date claim rather than an
 * invented one.
 *
 * No `vscode` import: every rule here is a pure function of the daemon's answers, so
 * `node --test` runs them directly.
 */

/** The scheme — and session type — the durable rows are listed and opened under. */
export const DURABLE_SESSION_SCHEME = 'durable';

/** One conversation as the daemon's `sessions` lists it — the shape `durable-tasks.ts` reads. */
export interface DurableConversationRow {
	readonly id: number;
	readonly entries: number;
	readonly newest?: string;
	readonly note?: string;
}

/**
 * Whether a snapshot says a run is in flight — the local twin of `durable-tasks.ts`'s
 * `snapshotInFlight`, kept beside the mapping for the same reason the wire client is copied:
 * a pure module here imports nothing relative, so `node --test` can run it directly.
 */
function snapshotInFlight(snapshot: unknown): boolean | undefined {
	const record = typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)
		? snapshot as Record<string, unknown>
		: undefined;
	if (record === undefined) {
		return undefined;
	}
	return 'run' in record;
}

/** A conversation transcript as the daemon's `subscribe` snapshot shapes it. */
export interface DurableSnapshotLike {
	readonly entries?: unknown;
	readonly run?: unknown;
}

/** One panel row's worth of facts, before the editor's shapes are built. */
export interface DurableSessionRow {
	/** The durable conversation id (the daemon assigns them in creation order). */
	readonly id: number;
	/** The first user prompt, capped — what the row is called in the panel. */
	readonly label: string;
	/** Durable's own note: `subagent (task …)`, `fork of …`, or empty. */
	readonly note: string;
	/** The transcript's earliest model-message timestamp, or `undefined` when it has none. */
	readonly created: number | undefined;
	/** The transcript's latest model-message timestamp, or `undefined` when it has none. */
	readonly lastActivity: number | undefined;
	/** The snapshot's own `run` presence (`durable-tasks.ts`): in flight, idle, or unreadable. */
	readonly inFlight: boolean | undefined;
}

/** One replayed turn of a durable conversation. */
export interface DurableSessionTurn {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

/** The longest a label gets: it is a pointer to the conversation, not the transcript. */
const LABEL_CHARS = 80;

/** A string capped for a label, with an ellipsis where it was cut. */
function capLabel(value: string): string {
	return value.length > LABEL_CHARS ? `${value.slice(0, LABEL_CHARS - 1)}…` : value;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** The snapshot's entries, as the array the daemon sent, or `[]` for anything else. */
function entriesOf(snapshot: unknown): readonly unknown[] {
	const entries = recordOf(snapshot)?.['entries'];
	return Array.isArray(entries) ? entries : [];
}

/**
 * Concatenated text of a pi-ai message (content may be a string, an array of blocks, or
 * missing) — copied from `picode-source/durable/lib/common.js`'s `textOf`, for the same
 * reason the wire client is copied: this module cannot import from the daemon's directory
 * at runtime, and the mapping has to move with that file if its shape ever does.
 */
function textOf(message: unknown): string {
	const content = recordOf(message)?.['content'];
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map(block => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
		.join('');
}

/** Text of one transcript entry's model messages — `durable/lib/common.js`'s `entryText`. */
export function durableEntryText(entry: unknown): string {
	const record = recordOf(entry);
	const messages = Array.isArray(record?.['model']) ? record['model'] : Array.isArray(record?.['data']) ? record['data'] : [];
	return messages.map(textOf).join(' ').trim();
}

/** The entry's `kind` — durable's own discriminator (`pi.user`, `pi.assistant`, …). */
function entryKind(entry: unknown): string | undefined {
	const kind = recordOf(entry)?.['kind'];
	return typeof kind === 'string' ? kind : undefined;
}

/**
 * Every model-message timestamp the transcript carries, in entry order.
 *
 * pi-ai's `UserMessage` and `AssistantMessage` both stamp `timestamp`; bookkeeping entries
 * (`pi.system`, `pi.reset`, `pi.compaction`) carry no model messages at all and contribute
 * nothing. Order-agnostic min/max happen in the caller, so a snapshot delivered newest-first
 * or oldest-first reads the same.
 */
function messageTimestamps(snapshot: unknown): number[] {
	const stamps: number[] = [];
	for (const entry of entriesOf(snapshot)) {
		const model = recordOf(entry)?.['model'];
		if (!Array.isArray(model)) {
			continue;
		}
		for (const message of model) {
			const timestamp = recordOf(message)?.['timestamp'];
			if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
				stamps.push(timestamp);
			}
		}
	}
	return stamps;
}

/**
 * One panel row from one conversation, given its transcript.
 *
 * The label is the **first user prompt** — the conversation's own opening question, not the
 * daemon's "Conversation N" — falling back to that name when the transcript has no user
 * words yet (a conversation opened but never run). The dates are the transcript's own
 * message timestamps: earliest is the row's creation, latest its last activity. `undefined`
 * dates mean the transcript carried none — said as such, never invented from a clock.
 */
export function durableSessionRow(conversation: DurableConversationRow, snapshot: unknown): DurableSessionRow {
	let label = '';
	for (const entry of entriesOf(snapshot)) {
		if (entryKind(entry) !== 'pi.user') {
			continue;
		}
		const text = durableEntryText(entry);
		if (text.length > 0) {
			label = capLabel(text);
			break;
		}
	}
	const stamps = messageTimestamps(snapshot);
	return {
		id: conversation.id,
		label: label.length > 0 ? label : `Conversation ${conversation.id}`,
		note: typeof conversation.note === 'string' ? conversation.note : '',
		created: stamps.length > 0 ? Math.min(...stamps) : undefined,
		lastActivity: stamps.length > 0 ? Math.max(...stamps) : undefined,
		inFlight: snapshotInFlight(snapshot),
	};
}

/**
 * Every conversation's row, **newest first**, and the same order every time.
 *
 * The transcript's last activity is what sorts; a conversation that could not be read (or
 * that carries no timestamps) sorts by what it has — the id, assigned in creation order,
 * settling every tie by content. Conversations without a usable id are skipped rather than
 * guessed into rows.
 */
export function durableSessionRows(
	conversations: readonly DurableConversationRow[],
	snapshotOf: (conversation: DurableConversationRow) => unknown,
): DurableSessionRow[] {
	const rows: DurableSessionRow[] = [];
	for (const conversation of conversations) {
		if (typeof conversation?.id !== 'number' || !Number.isFinite(conversation.id)) {
			continue;
		}
		rows.push(durableSessionRow(conversation, snapshotOf(conversation)));
	}
	const recency = (row: DurableSessionRow): number => row.lastActivity ?? row.created ?? 0;
	return rows.sort((a, b) => (recency(b) - recency(a)) || (b.id - a.id));
}

/** The digest a poll compares: who the daemon holds, and how much each conversation holds. */
export function sessionsDigest(conversations: readonly DurableConversationRow[]): string {
	return JSON.stringify(
		conversations
			.filter(conversation => typeof conversation?.id === 'number')
			.map(conversation => [conversation.id, typeof conversation.entries === 'number' ? conversation.entries : -1])
			.sort((a, b) => (a[0] as number) - (b[0] as number)),
	);
}

/**
 * The replayed conversation: user prompts and assistant answers, in order.
 *
 * Only the two talking kinds become turns — `pi.system`, `pi.reset`, `pi.compaction` and
 * `pi.tool-result` are the daemon's plumbing, the same rule that keeps thinking and tool
 * results out of the pi transcripts' replay. An entry whose text is empty is not a turn:
 * an assistant message that is all tool calls says nothing worth replaying.
 */
export function durableSessionTurns(snapshot: unknown): DurableSessionTurn[] {
	const turns: DurableSessionTurn[] = [];
	for (const entry of entriesOf(snapshot)) {
		const kind = entryKind(entry);
		const text = durableEntryText(entry);
		if (kind === 'pi.user' && text.length > 0) {
			turns.push({ role: 'user', text });
		} else if (kind === 'pi.assistant' && text.length > 0) {
			turns.push({ role: 'assistant', text });
		}
	}
	return turns;
}
