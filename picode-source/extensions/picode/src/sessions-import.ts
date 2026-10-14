/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionTurns, sessionHeader } from './sessions-provider';
import { durableSessionTurns } from './durable-sessions';
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
 * conversation. Resolves with how many landed; the daemon being down resolves with 0.
 */
export async function importTranscriptsIntoDurable(
	sessionsDir: string,
	cwd: string,
	log: (line: string) => void,
): Promise<number> {
	const folder = durableFolder();
	if (folder === undefined) return 0;
	const files = transcriptFiles(sessionsDir);
	if (files.length === 0) return 0;
	let client: DaemonClient;
	try {
		client = await DaemonClient.connect(daemonEndpoint(folder), 4000);
	} catch {
		return 0; // the daemon is down; a later pass records what is missing
	}
	// Conversations recorded by an EARLIER pass of this import carry the daemon's home —
	// or the WINDOW's folder, because passes used to stamp every transcript with the
	// importing window's cwd regardless of the transcript's own project. Both are repair
	// candidates; their true project is on each transcript's first record, and the repair
	// re-homes to that, never to the window's.
	const home = os.homedir();
	const rehomeable = new Map<string, number[]>();
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
			const firstTurn = durableSessionTurns(snapshot).find(turn => turn.role === 'user' && turn.text.trim().length > 0);
			if (firstTurn !== undefined) {
				const queue = rehomeable.get(firstTurn.text) ?? [];
				queue.push(conversation.id);
				rehomeable.set(firstTurn.text, queue);
			}
		}
	} catch {
		// Without the listing the pass still imports; repair just does not happen here.
	}
	let landed = 0;
	let repaired = 0;
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
				const known = turns[0].text.length > 0 ? rehomeable.get(turns[0].text)?.shift() : undefined;
				if (known !== undefined) {
					// Already imported once: re-home to its true project, never duplicate.
					const rehomed = await client.request('open', { conversationId: known, cwd: fileCwd }) as { conversationId?: number } | undefined;
					if (typeof rehomed?.conversationId === 'number') {
						repaired++;
					}
					continue;
				}
				const opened = await client.request('open', { cwd: fileCwd }) as { conversationId?: number } | undefined;
				if (typeof opened?.conversationId !== 'number') {
					log(`sessions import: the daemon opened no conversation for ${path.basename(file)}`);
					continue;
				}
				const messages = turns.map(turn => ({
					role: turn.role,
					content: [{ type: 'text', text: turn.text }],
					// The transcript's own stamps ride along: the daemon only fills in the clock
					// for messages that arrive without one, so a session imported today keeps
					// the dates it actually happened (the panel groups by them).
					...(turn.timestamp === undefined ? {} : { timestamp: turn.timestamp }),
				}));
				await client.request('record', { conversationId: opened.conversationId, messages });
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
	return landed;
}
