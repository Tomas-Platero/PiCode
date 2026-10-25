/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What one transcript's import does to the daemon, decided here — before any wire is
 * touched — from pure facts: what the file holds, what the daemon's copy already holds.
 *
 * Two shapes of history meet at an import. A transcript is a list of TURNS (the owner's
 * words, the agent's visible answers) that may end with a TAIL the turns parser leaves
 * out: an assistant turn interrupted before it said anything, kept in the file as tool
 * calls with no text. A durable copy is the same conversation recorded turn by turn.
 * The plan composes the file's full message list and, for a copy that already exists,
 * tells whether this file COMPLETES it (its turns are a prefix of the file's) and which
 * messages are missing — a re-import heals an older, shorter copy instead of duplicating
 * it, and never appends on top of a copy that moved past the file (the owner continued
 * it after importing; its history is ahead, not behind).
 *
 * No imports: every rule is a pure function, so `node --test` can run it directly.
 */

/** One message the import records, before it is shaped for the wire. */
export interface ImportPlanMessage {
	readonly role: 'user' | 'assistant';
	/** The visible text — empty for the interrupted tail turn. */
	readonly text: string;
	/** The message's content parts, as they ride to the daemon's `record`. */
	readonly content: readonly unknown[];
	readonly timestamp?: number;
}

/** One turn of a durable copy, the way the replay reads it. */
export interface ImportPlanTurn {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	/** The turn's own stamp, when the transcript carried one (rides along to the wire). */
	readonly timestamp?: number;
}

/** One existing durable conversation that may be this file's copy. */
export interface ImportPlanCopy {
	readonly id: number;
	readonly turns: readonly ImportPlanTurn[];
	/** The copy's raw model-entry count (`pi.user` + `pi.assistant`): it sees the tail. */
	readonly modelEntries: number;
}

/** One parsed turn plus the transcript's tail, as the import's inputs. */
export interface ImportPlanInputs {
	readonly turns: readonly ImportPlanTurn[];
	readonly tail?: { readonly role: 'user' | 'assistant'; readonly text: string; readonly content: readonly unknown[]; readonly timestamp?: number };
}

/**
 * The file's full message list: the turns, plus the tail when the turns do not already
 * end with it. The tail that matches the last turn (the session ended with an answer)
 * rides with the turns; a tail the turns leave out — the interrupted turn, or an
 * unanswered prompt the parser skipped for having no text — is appended so the copy
 * ends where the session actually ended.
 */
export function importMessages(inputs: ImportPlanInputs): ImportPlanMessage[] {
	const messages: ImportPlanMessage[] = inputs.turns.map(turn => ({
		role: turn.role,
		text: turn.text,
		content: [{ type: 'text', text: turn.text }],
		...(turn.timestamp === undefined ? {} : { timestamp: turn.timestamp }),
	}));
	const tail = inputs.tail;
	const lastTurn = inputs.turns[inputs.turns.length - 1];
	if (tail !== undefined && !(lastTurn !== undefined && lastTurn.role === tail.role && lastTurn.text === tail.text)) {
		messages.push({ role: tail.role, text: tail.text, content: tail.content, ...(tail.timestamp === undefined ? {} : { timestamp: tail.timestamp }) });
	}
	return messages;
}

/**
 * The outcome of one import pass — what landed, what was healed, and whether the durable
 * agent answered at all. The import must never end in silence: "nothing happened" is how
 * a working pass and a dead one read exactly the same, which is the owner's "no hace nada".
 */
export interface ImportPassOutcome {
	/** Conversations created by this pass. */
	readonly landed: number;
	/** Existing copies re-homed to their transcript's own project. */
	readonly repaired: number;
	/** Existing copies completed with the turns an older import had dropped. */
	readonly completed: number;
	/** The durable agent did not answer: the files are in, the panel is not. */
	readonly daemonDown: boolean;
}

/**
 * The outcome as one sentence for the owner — what the panel now holds, or why it does
 * not. Pure, so tests pin the exact words.
 */
export function importOutcomeMessage(outcome: ImportPassOutcome): string {
	if (outcome.daemonDown) {
		return 'PiCode: the conversations are in this profile, but the durable agent did not answer, so the panel does not list them yet. Import again once PiCode is running normally.';
	}
	const parts: string[] = [];
	if (outcome.landed > 0) parts.push(`${outcome.landed} new conversation${outcome.landed === 1 ? '' : 's'}`);
	if (outcome.completed > 0) parts.push(`${outcome.completed} completed with the turns they were missing`);
	if (outcome.repaired > 0) parts.push(`${outcome.repaired} re-homed`);
	if (parts.length === 0) {
		return 'PiCode: every conversation in this profile is already in the panel — nothing new to add.';
	}
	return `PiCode: ${parts.join(', ')}. The panel lists them now.`;
}

/**
 * The copy this file completes, if any: the one whose turns are a **prefix** of the
 * file's messages. Identity by first prompt alone is how a re-import used to pair
 * whichever conversation came first — completing one copy with another session's tail
 * writes someone else's history into it. The prefix is the check that the copy IS this
 * file's past; among several prefixes (copies of copies) the OLDEST wins, the same one
 * the panel's dedup keeps, so the row the owner sees is the row that heals.
 */
export function completingCopy(
	candidates: readonly ImportPlanCopy[] | undefined,
	messages: readonly ImportPlanMessage[],
): ImportPlanCopy | undefined {
	if (candidates === undefined) {
		return undefined;
	}
	const matches = candidates.filter(candidate => isPrefix(candidate.turns, messages));
	return matches.sort((a, b) => a.id - b.id)[0];
}

/** Whether `turns` are exactly the opening of `messages`. */
function isPrefix(turns: readonly ImportPlanTurn[], messages: readonly ImportPlanMessage[]): boolean {
	if (turns.length > messages.length) {
		return false;
	}
	return turns.every((turn, index) => turn.role === messages[index].role && turn.text === messages[index].text);
}

/**
 * What the copy is missing, given that `copy` is this file's prefix — or nothing when
 * there is nothing to give. The count that decides is the copy's raw model entries,
 * not its turns: a copy that was healed before already carries the text-less tail, and
 * only the raw count sees it — comparing turns would append the tail again on every
 * re-import. A copy whose entries are AHEAD of the file (the owner continued it) gets
 * nothing: its history is past this file, never behind.
 */
export function missingMessages(copy: ImportPlanCopy, messages: readonly ImportPlanMessage[]): ImportPlanMessage[] {
	if (copy.modelEntries >= messages.length) {
		return [];
	}
	return messages.slice(copy.modelEntries);
}
