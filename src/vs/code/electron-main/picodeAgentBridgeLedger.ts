/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Remembers every task the bridge was asked to start, so one task never reaches pi twice.
 *
 * A task is written as `pending` **before** its assignment is handed to the window, and becomes
 * `started` only once the window reports that pi has the assignment in its session history. A
 * session id alone is not that proof: it exists as soon as the session does.
 *
 * What a repeated request gets:
 * - the same task id with another folder or another assignment: a conflict, never a silent reuse;
 * - a started task: its session again, with nothing sent;
 * - a pending task whose first request is still running: that request's outcome;
 * - a pending task nobody is working on (PiCode stopped, the window never answered): a recovery,
 *   which looks for the session on disk and otherwise reports the outcome as uncertain.
 */

export interface LedgerEntry {
	readonly folderKey: string;
	readonly promptHash: string;
	readonly state: 'pending' | 'started';
	readonly sessionId?: string;
	readonly updated: number;
}

export type LedgerDecision<T> =
	| { readonly kind: 'start' | 'recover' | 'wait'; readonly outcome: Promise<T> }
	| { readonly kind: 'reuse'; readonly sessionId: string }
	| { readonly kind: 'conflict' }
	| { readonly kind: 'unavailable' };

interface InFlight<T> {
	readonly folderKey: string;
	readonly promptHash: string;
	readonly outcome: Promise<T>;
}

export class TaskLedger<T> {

	private entries: Record<string, LedgerEntry>;
	/** Set when the file exists but cannot be read: then no task starts until someone fixes it. */
	private readonly unreadable: boolean;
	private readonly inFlight = new Map<string, InFlight<T>>();

	constructor(private readonly file: string, private readonly now: () => number = Date.now) {
		const read = TaskLedger.read(file);
		this.entries = read ?? {};
		this.unreadable = read === undefined;
	}

	/**
	 * The tasks on file, or `undefined` when the file is there but cannot be read. A ledger that
	 * cannot be read must not let a task start twice, so it is not replaced by an empty one: the
	 * bridge refuses to start anything until the file is fixed or removed by hand.
	 */
	private static read(file: string): Record<string, LedgerEntry> | undefined {
		if (!existsSync(file)) {
			return {};
		}
		try {
			const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: Record<string, LedgerEntry> };
			return typeof parsed.tasks === 'object' && parsed.tasks !== null && !Array.isArray(parsed.tasks) ? { ...parsed.tasks } : undefined;
		} catch {
			return undefined;
		}
	}

	get(taskId: string): LedgerEntry | undefined {
		return Object.prototype.hasOwnProperty.call(this.entries, taskId) ? this.entries[taskId] : undefined;
	}

	/**
	 * Decides what a request does and, when it is to start or recover, claims the task in the same
	 * synchronous step, so a second request arriving meanwhile waits for this one.
	 */
	claim(taskId: string, folderKey: string, promptHash: string, run: (kind: 'start' | 'recover') => Promise<T>): LedgerDecision<T> {
		if (this.unreadable) {
			return { kind: 'unavailable' };
		}
		const running = this.inFlight.get(taskId);
		if (running !== undefined) {
			return running.folderKey === folderKey && running.promptHash === promptHash
				? { kind: 'wait', outcome: running.outcome }
				: { kind: 'conflict' };
		}
		const entry = this.get(taskId);
		if (entry !== undefined && (entry.folderKey !== folderKey || entry.promptHash !== promptHash)) {
			return { kind: 'conflict' };
		}
		if (entry?.state === 'started' && entry.sessionId !== undefined) {
			return { kind: 'reuse', sessionId: entry.sessionId };
		}
		const kind = entry === undefined ? 'start' : 'recover';
		const outcome = Promise.resolve().then(() => run(kind));
		const flight: InFlight<T> = { folderKey, promptHash, outcome };
		this.inFlight.set(taskId, flight);
		const release = () => {
			if (this.inFlight.get(taskId) === flight) {
				this.inFlight.delete(taskId);
			}
		};
		outcome.then(release, release);
		return { kind, outcome };
	}

	/** Written before the assignment leaves the main process. */
	markPending(taskId: string, folderKey: string, promptHash: string): void {
		this.write({ ...this.entries, [taskId]: { folderKey, promptHash, state: 'pending', updated: this.now() } });
	}

	/** Written once pi has the assignment in its session history. */
	markStarted(taskId: string, folderKey: string, promptHash: string, sessionId: string): void {
		this.write({ ...this.entries, [taskId]: { folderKey, promptHash, state: 'started', sessionId, updated: this.now() } });
	}

	/** The assignment provably never reached pi: a later request may start it. */
	forget(taskId: string): void {
		if (this.get(taskId) !== undefined) {
			const rest = { ...this.entries };
			delete rest[taskId];
			this.write(rest);
		}
	}

	/** Disk first: memory only follows a write that succeeded, so the two never disagree. */
	private write(entries: Record<string, LedgerEntry>): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const temp = `${this.file}.tmp`;
		writeFileSync(temp, JSON.stringify({ version: 1, tasks: entries }, undefined, '\t'));
		renameSync(temp, this.file);
		this.entries = entries;
	}
}
