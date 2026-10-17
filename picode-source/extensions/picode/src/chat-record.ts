/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { DaemonClient, daemonEndpoint } from './durable-client';
import { durableFolder } from './durable';

/**
 * The chat's durable copy: every turn the room sees, the daemon holds.
 *
 * The owner's shape for the chat (ADR-021, corrected): **pi thinks, durable remembers**. The
 * turn runs on pi in the window — model, tools, permissions, the screen — and when it ends,
 * the prompt and the answer are recorded into a durable conversation over the daemon's own
 * protocol (`record`). The conversation then outlives the window and is continuable from
 * anywhere the panel lists it.
 *
 * One durable conversation per window's chat, cached by its scope key: the chat's pi session
 * is one per window, so its durable copy is one too. The daemon being down is the normal
 * no-op — the turn the room already saw is not lost (the transcript keeps it) and the next
 * turn tries again. A recording failure never fails the turn: recording is the file keeper's
 * job, not the answer's.
 */

/** How long a record call may take, in milliseconds. */
const RECORD_TIMEOUT_MS = 4000;

/** One finished turn, as the room saw it. */
export interface ChatTurn {
	/** The prompt as it reached pi (the context frame included; replay strips it back out). */
	readonly prompt: string;
	/** The answer's own text, as it streamed — empty when the turn ended without one. */
	readonly answer: string;
}

/** The conversation this window's chat records into, cached by its scope key. */
let cached: { conversationId: number; scopeKey: string; sessionKey?: string } | undefined;

/** One listener of the recorder's movement: a conversation opened or written into. */
type ConversationListener = (conversationId: number) => void;
const conversationListeners = new Set<ConversationListener>();

/**
 * Fires when the recorder touches a conversation — opened for a new chat, or a turn
 * recorded into one. The sessions panel listens and refreshes AT ONCE: a conversation
 * that exists must not wait for the next poll to be visible. The listener's failures
 * are its own — a dead panel never breaks the recording.
 */
export function onConversationTouched(listener: ConversationListener): { dispose(): void } {
	conversationListeners.add(listener);
	return { dispose: () => conversationListeners.delete(listener) };
}

function notifyConversationTouched(conversationId: number): void {
	for (const listener of conversationListeners) {
		try {
			listener(conversationId);
		} catch { /* a listener that throws is that listener's problem */ }
	}
}

/**
 * Make sure the chat's durable conversation exists — WITHOUT recording anything. Called
 * the moment a request arrives, so a brand-new chat is visible in the panel while the
 * model is still answering, not seconds after the turn ends. Reuses the cached
 * conversation when it is still the session's own, so the common turn costs nothing.
 */
export async function ensureConversation(
	scopeKey: string,
	sessionKey: string | undefined,
	cwd: string,
	log: (line: string) => void,
): Promise<void> {
	const resumedId = durableConversationOfSession(sessionKey);
	if (resumedId !== undefined) {
		cached = { conversationId: resumedId, scopeKey, sessionKey };
		return;
	}
	if (cached !== undefined && cached.scopeKey === scopeKey
		&& (sessionKey === undefined || cached.sessionKey === sessionKey)) {
		return; // the conversation this turn will record into already exists
	}
	const folder = durableFolder();
	if (folder === undefined) return;
	let client: DaemonClient;
	try {
		client = await DaemonClient.connect(daemonEndpoint(folder), RECORD_TIMEOUT_MS);
	} catch {
		return; // the daemon is down; recordChatTurn opens on the turn's end
	}
	try {
		const opened = await client.request('open', { cwd }) as { conversationId?: number } | undefined;
		if (typeof opened?.conversationId !== 'number') {
			log('chat record: the daemon opened no conversation');
			return;
		}
		cached = { conversationId: opened.conversationId, scopeKey, sessionKey };
		notifyConversationTouched(cached.conversationId);
	} catch (error) {
		log(`chat record: eager open failed — ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		client.close();
	}
}

/** Drop the cached conversation: the next turn opens a fresh one (a scope change rebuilds). */
export function resetChatRecording(): void {
	cached = undefined;
}

/**
 * The durable conversation a session resource names, when it names one at all. The panel's
 * continued chats carry `durable:/<id>` — the conversation they resumed; a brand-new chat
 * carries `durable:/untitled-…`, which names nothing until this window opens one.
 */
function durableConversationOfSession(sessionKey: string | undefined): number | undefined {
	const match = /^durable:\/(\d+)$/.exec(sessionKey ?? '');
	if (match === null) {
		return undefined;
	}
	return Number(match[1]);
}

/**
 * Record one finished turn into a GIVEN durable conversation — the panel's continued
 * conversations record into the conversation they resumed, not into the window's own.
 */
export async function recordTurnInto(
	conversationId: number,
	turn: ChatTurn,
	log: (line: string) => void,
): Promise<void> {
	const folder = durableFolder();
	if (folder === undefined) return;
	let client: DaemonClient;
	try {
		client = await DaemonClient.connect(daemonEndpoint(folder), RECORD_TIMEOUT_MS);
	} catch {
		return; // the daemon is down; the next turn asks again
	}
	try {
		const messages = turn.answer.length > 0
			? [
				{ role: 'user', content: turn.prompt },
				{ role: 'assistant', content: turn.answer },
			]
			: [{ role: 'user', content: turn.prompt }];
		await client.request('record', { conversationId, messages });
	} catch (error) {
		log(`chat record failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		client.close();
	}
}

/**
 * Record one finished turn into the chat's durable conversation. Resolves when recorded —
 * or when the daemon proved unavailable, in which case nothing is written and nothing is
 * lost (the room's own transcript holds the turn).
 *
 * The record follows the chat session, not the window: `sessionKey` is the request's
 * `sessionResource`. A resumed durable chat (`durable:/<id>`) records into that very
 * conversation; two different chats in one window each open their own — this is what a
 * "New Session" needs, since the recorder that ignored the session kept appending every
 * new chat's turns to the last recorded conversation, and the panel never saw a row.
 */
export async function recordChatTurn(
	scopeKey: string,
	cwd: string,
	turn: ChatTurn,
	log: (line: string) => void,
	sessionKey?: string,
): Promise<void> {
	const resumedId = durableConversationOfSession(sessionKey);
	if (resumedId !== undefined) {
		// The panel's continuation: this conversation, every turn, regardless of the cache.
		cached = { conversationId: resumedId, scopeKey, sessionKey };
		await recordTurnInto(resumedId, turn, log);
		notifyConversationTouched(resumedId);
		return;
	}
	const folder = durableFolder();
	if (folder === undefined) return;
	let client: DaemonClient;
	try {
		client = await DaemonClient.connect(daemonEndpoint(folder), RECORD_TIMEOUT_MS);
	} catch {
		return; // the daemon is down; the next turn asks again
	}
	try {
		if (cached === undefined || cached.scopeKey !== scopeKey
			|| (sessionKey !== undefined && cached.sessionKey !== sessionKey)) {
			const opened = await client.request('open', { cwd }) as { conversationId?: number } | undefined;
			if (typeof opened?.conversationId !== 'number') {
				log('chat record: the daemon opened no conversation');
				return;
			}
			cached = { conversationId: opened.conversationId, scopeKey, sessionKey };
			notifyConversationTouched(cached.conversationId);
		}
		// An answer that never came is recorded as owed: the prompt alone, which is what
		// "still owed an answer" reads from. The daemon validates the shape either way.
		const messages = turn.answer.length > 0
			? [
				{ role: 'user', content: turn.prompt },
				{ role: 'assistant', content: turn.answer },
			]
			: [{ role: 'user', content: turn.prompt }];
		await client.request('record', { conversationId: cached.conversationId, messages });
		notifyConversationTouched(cached.conversationId);
	} catch (error) {
		log(`chat record failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		client.close();
	}
}
