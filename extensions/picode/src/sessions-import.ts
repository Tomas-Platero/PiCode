/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionTurns, sessionHeader, sessionTail } from './sessions-provider';
import { durableSessionTurns } from './durable-sessions';
import { completingCopy, importMessages, missingMessages, type ImportPassOutcome, type ImportPlanCopy, type ImportPlanMessage } from './sessions-import-plan';

// The outcome's words are the plan module's (pure, test-pinned); the command imports them
// from here, beside the pass that produces them.
export { importOutcomeMessage, type ImportPassOutcome } from './sessions-import-plan';
import { DaemonClient, daemonEndpoint } from './durable-client';
import { durableFolder } from './durable';
import { DURABLE_IMPORT_PAUSE } from './durable-sessions-register';

/**
 * An import lands conversations where the ONE list can see them.
 *
 * The panel's one list is durable's conversations (ADR-021 corrected): a transcript that
 * arrives as a file — from the external pi's profile, or from a backup — is a conversation
 * the owner had, so it becomes a durable conversation at import time: its turns are read
 * (the same parser the replay uses) and recorded over the daemon's own protocol. The file
 * stays on disk untouched — it remains the transcript of record for replays and backups;
 * durable's copy is how the conversation shows up and continues.
 *
 * The daemon being down is the normal no-op: the files are imported either way, and the
 * next import (or a later pass) records what is missing. A transcript that does not read
 * is skipped with a log line, never fatal — these files were written by another machine's
 * pi and may hold anything.
 */

/** How many transcripts one pass converts, as a ceiling against a pathological profile. */
const MAX_TRANSCRIPTS_PER_PASS = 5000;

/**
 * Every attempt the daemon connect may take: the first at once, then with a gap — a daemon
 * still coming up answers on the second try, and the pass never reports "nothing happened"
 * for a race a wait could have settled.
 */
const IMPORT_CONNECT_ATTEMPTS = 5;
/** The gap between connect attempts, in milliseconds. */
const IMPORT_CONNECT_GAP_MS = 2000;

/** The transcripts under a sessions directory, newest-walked like pi files them. */
function transcriptFiles(sessionsDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // a missing or unreadable directory is "no transcripts", not a crash
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith('.jsonl')) {
				out.push(full);
			}
		}
	};
	walk(sessionsDir);
	return out.slice(0, MAX_TRANSCRIPTS_PER_PASS);
}

/**
 * Record every transcript under the (just-imported) sessions directory as a durable
 * conversation. Resolves with the pass's full outcome; a daemon that does not answer
 * after its retries resolves with `daemonDown: true` and says so on the log — the pass
 * never ends in silence.
 */
export async function importTranscriptsIntoDurable(
	sessionsDir: string,
	cwd: string,
	log: (line: string) => void,
): Promise<ImportPassOutcome> {
	const folder = durableFolder();
	if (folder === undefined) {
		log('sessions import: no durable folder resolved — the conversations are in the profile, but nothing can list them.');
		return { landed: 0, repaired: 0, completed: 0, daemonDown: true };
	}
	const files = transcriptFiles(sessionsDir);
	if (files.length === 0) {
		log(`sessions import: no transcripts found under ${sessionsDir}`);
		return { landed: 0, repaired: 0, completed: 0, daemonDown: false };
	}
	let client: DaemonClient | undefined;
	// The daemon may still be coming up when an import lands right after the window opens:
	// one 4-second attempt would read "the agent is down" for a race a wait can settle.
	for (let attempt = 1; attempt <= IMPORT_CONNECT_ATTEMPTS && client === undefined; attempt++) {
		try {
			client = await DaemonClient.connect(daemonEndpoint(folder), 4000);
		} catch {
			if (attempt < IMPORT_CONNECT_ATTEMPTS) {
				await new Promise(resolve => setTimeout(resolve, IMPORT_CONNECT_GAP_MS));
			}
		}
	}
	if (client === undefined) {
		log('sessions import: the durable agent did not answer after 5 attempts — the conversations are in the profile, but the panel cannot list them yet.');
		return { landed: 0, repaired: 0, completed: 0, daemonDown: true };
	}
	// Conversations recorded by an EARLIER pass of this import carry the daemon's home —
	// or the WINDOW's folder, because passes used to stamp every transcript with the
	// importing window's cwd regardless of the transcript's own project. Both are repair
	// candidates; their true project is on each transcript's first record, and the repair
	// re-homes to that, never to the window's. Each candidate keeps its full turns and its
	// raw model-entry count: the turns prove WHICH transcript it is a copy of, and the raw
	// count is what a re-import completes it against (see `missingMessages`).
	const home = os.homedir();
	const rehomeable = new Map<string, ImportPlanCopy[]>();
	try {
		const sessions = await client.request('sessions') as { conversations?: ReadonlyArray<{ id: number; cwd?: string }> } | undefined;
		for (const conversation of sessions?.conversations ?? []) {
			if (conversation.cwd !== undefined && conversation.cwd !== home && conversation.cwd !== cwd) continue;
			const snapshot = await client.request('subscribe', { conversationId: conversation.id }) as { snapshot?: unknown } | undefined;
			try {
				await client.request('unsubscribe', { conversationId: conversation.id });
			} catch {
				// The next read unsubscribes again; a stale watch is the daemon's to reap.
			}
			const turns = durableSessionTurns(snapshot);
			const firstTurn = turns.find(turn => turn.role === 'user' && turn.text.trim().length > 0);
			if (firstTurn !== undefined) {
				const modelEntries = entriesModelCount(snapshot);
				const queue = rehomeable.get(firstTurn.text) ?? [];
				queue.push({ id: conversation.id, turns, modelEntries });
				rehomeable.set(firstTurn.text, queue);
			}
		}
	} catch {
		// Without the listing the pass still imports; repair just does not happen here.
	}
	let landed = 0;
	let repaired = 0;
	let completed = 0;
	// The panel's poll stands down while this pass runs: one announcement at the end, not a
	// re-list per conversation — that re-list per row is the flash the owner saw.
	DURABLE_IMPORT_PAUSE.active = true;
	try {
		for (const file of files) {
			try {
				const text = fs.readFileSync(file, 'utf8');
				const turns = sessionTurns(text);
				if (turns.length === 0) continue;
				// The transcript's OWN project, from its first record — the same place the
				// TUI reads it. Importing from one window must not re-label every session
					// with that window's folder: a session belongs where it happened.
				const header = sessionHeader(text);
				const fileCwd = typeof header?.['cwd'] === 'string' && (header['cwd'] as string).length > 0
					? header['cwd'] as string
					: cwd;
				// The file's full message list, tail included: a session that ended mid-work
				// (the agent's last turn was tool calls with no text) must not record as if
				// it ended on the owner's own prompt — that is how history reads as
				// "Input Needed" forever.
				const messages: ImportPlanMessage[] = importMessages({ turns, tail: sessionTail(text) });
				const candidates = turns[0].text.length > 0 ? rehomeable.get(turns[0].text) : undefined;
				let copy = completingCopy(candidates, messages);
				if (copy === undefined) {
					// No copy is a prefix of this file: fall back to the pairing the earlier
					// passes used (same first prompt, oldest first) for the re-home — but
					// without a prefix proof nothing is ever appended to it.
					copy = candidates?.shift();
				}
				if (copy !== undefined) {
					// Already imported once: re-home to its true project, never duplicate.
					const rehomed = await client.request('open', { conversationId: copy.id, cwd: fileCwd }) as { conversationId?: number } | undefined;
					if (typeof rehomed?.conversationId !== 'number') {
						continue;
					}
					repaired++;
					// A copy shorter than the file is an OLDER import: heal it with what it
					// is missing — including the tail turn the text-only turns never carried.
					const missing = missingMessages(copy, messages);
					if (missing.length > 0) {
						await client.request('record', {
							conversationId: copy.id,
							messages: missing.map(message => ({
								role: message.role,
								content: message.content,
								...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
							})),
						});
						completed++;
					}
					continue;
				}
				const opened = await client.request('open', { cwd: fileCwd }) as { conversationId?: number } | undefined;
				if (typeof opened?.conversationId !== 'number') {
					log(`sessions import: the daemon opened no conversation for ${path.basename(file)}`);
					continue;
				}
				await client.request('record', {
					conversationId: opened.conversationId,
					messages: messages.map(message => ({
						role: message.role,
						content: message.content,
						...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
					})),
				});
				landed++;
		} catch (error) {
			log(`sessions import: ${path.basename(file)} did not convert — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	} finally {
		DURABLE_IMPORT_PAUSE.active = false;
		client.close();
	}
	if (repaired > 0) {
		log(`sessions import: ${repaired} conversation(s) re-homed to this project`);
	}
	if (completed > 0) {
		log(`sessions import: ${completed} conversation(s) completed with the turns they were missing`);
	}
	log(`sessions import: ${landed} conversation(s) landed, ${repaired} re-homed, ${completed} completed`);
	return { landed, repaired, completed, daemonDown: false };
}
/**
 * The snapshot's raw model entries (`pi.user` + `pi.assistant`) — everything the copy
 * holds, the text-less tail included. The turns parser cannot see the tail, so the
 * completion count has to come from here.
 */
function entriesModelCount(snapshot: unknown): number {
	const entries = Array.isArray((snapshot as { entries?: unknown })?.['entries'])
		? (snapshot as { entries: unknown[] }).entries
		: [];
	return entries.filter(entry => {
		const kind = (entry as { kind?: unknown })?.['kind'];
		return kind === 'pi.user' || kind === 'pi.assistant';
	}).length;
}
