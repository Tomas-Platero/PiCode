/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The task mark a session started by another app carries (PiCode's local agent bridge).
 *
 * The mark is a `custom` entry in pi's own session history, written when the session is created,
 * so renaming the session does not touch it. pi writes the session file only once it has a user
 * message (`SessionManager._persist`), and then writes everything it holds, so on disk a mark
 * always arrives together with the assignment that followed it.
 *
 * The mark proves the session was created for the task; that pi **received** the assignment is a
 * separate fact: a user message after the mark.
 */

export const TASK_ENTRY_TYPE = 'picode.task';

export interface TaskMark {
	readonly taskId: string;
	readonly promptHash: string;
}

/** The parts of a pi session entry this module reads. */
export interface SessionEntryLike {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly customType?: unknown;
	readonly data?: unknown;
	readonly message?: { readonly role?: unknown } | undefined;
}

export interface TaskStatus {
	readonly marked: boolean;
	readonly received: boolean;
}

function isMark(entry: SessionEntryLike, mark: TaskMark): boolean {
	if (entry.type !== 'custom' || entry.customType !== TASK_ENTRY_TYPE || typeof entry.data !== 'object' || entry.data === null) {
		return false;
	}
	const data = entry.data as Record<string, unknown>;
	return data['taskId'] === mark.taskId && data['promptHash'] === mark.promptHash;
}

/** Whether a session's entries carry this task's mark, and a user message after it. */
export function taskStatus(entries: readonly SessionEntryLike[], mark: TaskMark): TaskStatus {
	const at = entries.findIndex(entry => isMark(entry, mark));
	if (at < 0) {
		return { marked: false, received: false };
	}
	const received = entries.slice(at + 1).some(entry => entry.type === 'message' && entry.message?.role === 'user');
	return { marked: true, received };
}

/** Reads a transcript's lines, skipping a torn last line. */
export function transcriptEntries(text: string): SessionEntryLike[] {
	const entries: SessionEntryLike[] = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') {
			continue;
		}
		try {
			const value = JSON.parse(line) as unknown;
			if (typeof value === 'object' && value !== null) {
				entries.push(value as SessionEntryLike);
			}
		} catch {
			// A line cut short by a crash: whatever came before it still counts.
		}
	}
	return entries;
}

/**
 * Looks through a project's transcripts for the session that carries the task's mark.
 * Returns its id (from the transcript header) and whether pi received the assignment.
 */
export function findTaskSession(
	files: readonly { readonly file: string }[],
	mark: TaskMark,
	read: (file: string) => string | undefined,
): { readonly sessionId: string; readonly received: boolean } | undefined {
	let marked: { readonly sessionId: string; readonly received: boolean } | undefined;
	for (const { file } of files) {
		const text = read(file);
		if (text === undefined || !text.includes(TASK_ENTRY_TYPE) || !text.includes(mark.promptHash)) {
			continue;
		}
		const entries = transcriptEntries(text);
		const status = taskStatus(entries, mark);
		const header = entries.find(entry => entry.type === 'session');
		if (!status.marked || typeof header?.id !== 'string') {
			continue;
		}
		if (status.received) {
			return { sessionId: header.id, received: true };
		}
		marked ??= { sessionId: header.id, received: false };
	}
	return marked;
}
