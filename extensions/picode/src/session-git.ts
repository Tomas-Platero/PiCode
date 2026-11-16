/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The git branches each conversation worked on, for the Agent layout's session rows.
 *
 * pi's transcript records the folder a conversation ran in but not the branch, and "the branch the
 * folder is on now" would be a lie for every older row. So the branch is read after each turn and
 * kept, per conversation, in `<profile>/session-git.json`; the row shows the last one only when it
 * is not the repository's default branch (or the conversation has its own worktree).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPicodeWorktree } from './session-worktree';

export interface SessionGitRecord {
	readonly cwd: string;
	/** Oldest first; the last entry is the branch of the conversation's latest turn. */
	readonly branches: readonly string[];
	/** The conversation runs in a worktree PiCode made for it. */
	readonly worktree?: boolean;
	/** The name the owner gave the session; the row shows it instead of the first prompt. */
	readonly title?: string;
}

function makeRecord(cwd: string, branches: readonly string[], worktree: boolean | undefined, title: string | undefined): SessionGitRecord {
	return { cwd, branches, ...(worktree ? { worktree: true } : {}), ...(title ? { title } : {}) };
}

export type SessionGitStore = Readonly<Record<string, SessionGitRecord>>;

export interface RowGit {
	/** `$(git-branch) <branch>`, the row's badge. */
	readonly badge: string;
	/** The non-default branches the conversation touched, oldest first. */
	readonly branches: readonly string[];
}

const STORE_FILE = 'session-git.json';
const GIT_TIMEOUT_MS = 5_000;
/** A conversation that hops branches all day keeps only its latest ones. */
const MAX_BRANCHES = 20;

/** The store with `branch` noted for `sessionId`; undefined when nothing changes. */
export function noteBranch(store: SessionGitStore, sessionId: string, cwd: string, branch: string | undefined, worktree?: boolean): SessionGitStore | undefined {
	if (branch === undefined || branch === '' || branch === 'HEAD') {
		return undefined;
	}
	const before = store[sessionId];
	const branches = before?.branches ?? [];
	const sameWorktree = (before?.worktree ?? false) === (worktree ?? before?.worktree ?? false);
	if (before !== undefined && branches[branches.length - 1] === branch && before.cwd === cwd && sameWorktree) {
		return undefined;
	}
	const next = [...branches.filter(b => b !== branch), branch].slice(-MAX_BRANCHES);
	return { ...store, [sessionId]: makeRecord(cwd, next, worktree ?? before?.worktree, before?.title) };
}

/** The store as read from disk; anything that is not one reads as empty. */
export function parseSessionGitStore(text: string): SessionGitStore {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return {};
	}
	const out: Record<string, SessionGitRecord> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (typeof value !== 'object' || value === null) {
			continue;
		}
		const { cwd, branches, worktree, title } = value as Record<string, unknown>;
		if (typeof cwd !== 'string' || !Array.isArray(branches)) {
			continue;
		}
		const names = branches.filter((b): b is string => typeof b === 'string' && b !== '');
		out[id] = makeRecord(cwd, names, worktree === true, typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined);
	}
	return out;
}

/** The store with `title` as the session's name; an empty title gives the name back to the first prompt. */
export function withTitle(store: SessionGitStore, sessionId: string, title: string): SessionGitStore {
	const before = store[sessionId];
	const clean = title.replace(/[\r\n]+/g, ' ').trim();
	return { ...store, [sessionId]: makeRecord(before?.cwd ?? '', before?.branches ?? [], before?.worktree, clean || undefined) };
}

/** The store after a session's branch was renamed in git; unchanged when the session has no record. */
export function renameRecordedBranch(store: SessionGitStore, sessionId: string, from: string, to: string): SessionGitStore {
	const before = store[sessionId];
	if (before === undefined) {
		return store;
	}
	return { ...store, [sessionId]: makeRecord(before.cwd, before.branches.map(b => b === from ? to : b), before.worktree, before.title) };
}

function isDefault(branch: string, defaultBranch: string | undefined): boolean {
	return defaultBranch !== undefined ? branch === defaultBranch : branch === 'main' || branch === 'master';
}

/** What the row shows for a record, or undefined when the branch says nothing new. */
export function rowGitFor(record: SessionGitRecord | undefined, defaultBranch: string | undefined): RowGit | undefined {
	const current = record?.branches[record.branches.length - 1];
	if (record === undefined || current === undefined) {
		return undefined;
	}
	if (!record.worktree && isDefault(current, defaultBranch)) {
		return undefined;
	}
	const branches = record.worktree ? [...record.branches] : record.branches.filter(b => !isDefault(b, defaultBranch));
	return { badge: `$(git-branch) ${current}`, branches };
}

/** `refs/remotes/<remote>/<branch>` → `<branch>`. */
export function parseDefaultBranch(symbolicRef: string): string | undefined {
	const match = symbolicRef.trim().match(/^refs\/remotes\/[^/]+\/(.+)$/);
	return match?.[1];
}

function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile('git', args, { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
	});
}

/** The branch the folder is on; undefined outside a repository or on a detached head. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
	const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
	return branch === undefined || branch === '' || branch === 'HEAD' ? undefined : branch;
}

const defaultBranches = new Map<string, Promise<string | undefined>>();

/** The repository's default branch (from `origin/HEAD`), asked once per folder per window. */
export function defaultBranchOf(cwd: string): Promise<string | undefined> {
	let known = defaultBranches.get(cwd);
	if (known === undefined) {
		known = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then(ref => ref === undefined ? undefined : parseDefaultBranch(ref));
		defaultBranches.set(cwd, known);
	}
	return known;
}

/** The `origin` remote as `owner/repo` when it is a GitHub one. */
export async function githubRepoOf(cwd: string): Promise<string | undefined> {
	const url = await git(cwd, ['config', '--get', 'remote.origin.url']);
	const match = url?.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

const learnedDefaults = new Map<string, string | undefined>();

/**
 * The default branch if it is already known, without waiting. The first ask starts the lookup and
 * calls `onLearned` when the answer differs from the main/master guess, so the list repaints once.
 */
export function defaultBranchNow(cwd: string, onLearned: () => void): string | undefined {
	if (learnedDefaults.has(cwd)) {
		return learnedDefaults.get(cwd);
	}
	if (!defaultBranches.has(cwd)) {
		void defaultBranchOf(cwd).then(branch => {
			learnedDefaults.set(cwd, branch);
			if (branch !== undefined && branch !== 'main' && branch !== 'master') {
				onLearned();
			}
		});
	}
	return undefined;
}

const learnedRepos = new Map<string, string | undefined>();
const askedRepos = new Set<string>();

/** The folder's GitHub `owner/repo` if already known; the first ask looks it up and calls `onLearned` once found. */
export function githubRepoNow(cwd: string, onLearned: () => void): string | undefined {
	if (learnedRepos.has(cwd)) {
		return learnedRepos.get(cwd);
	}
	if (!askedRepos.has(cwd)) {
		askedRepos.add(cwd);
		void githubRepoOf(cwd).then(repo => {
			learnedRepos.set(cwd, repo);
			if (repo !== undefined) {
				onLearned();
			}
		});
	}
	return undefined;
}

const listeners = new Set<() => void>();

/** Called whenever a conversation's branch record changes. */
export function onSessionGitChanged(listener: () => void): { dispose(): void } {
	listeners.add(listener);
	return { dispose: () => listeners.delete(listener) };
}

let profileOfRecords: (() => string) | undefined;

/** Where the records live: PiCode's profile in force. Set once by the extension. */
export function setSessionGitProfile(profileDir: () => string): void {
	profileOfRecords = profileDir;
}

/** After a turn: note the branch of the folder the turn ran in. Fire-and-forget, never throws. */
export function noteTurnBranch(sessionId: string, cwd: string): void {
	const profileDir = profileOfRecords?.();
	if (profileDir === undefined) {
		return;
	}
	void recordSessionBranch(profileDir, sessionId, cwd, isPicodeWorktree(cwd) || undefined).then(changed => {
		if (changed) {
			for (const listener of listeners) {
				listener();
			}
		}
	}, () => undefined);
}

/** The worktree a conversation ran in, from its records; undefined when it ran in the project folder. */
export function worktreeOfSession(sessionId: string): string | undefined {
	const profileDir = profileOfRecords?.();
	const record = profileDir === undefined ? undefined : readSessionGitStore(profileDir)[sessionId];
	return record?.worktree ? record.cwd : undefined;
}

let cached: { mtime: number; store: SessionGitStore } | undefined;

export function readSessionGitStore(profileDir: string): SessionGitStore {
	const file = path.join(profileDir, STORE_FILE);
	let mtime: number;
	try {
		mtime = fs.statSync(file).mtimeMs;
	} catch {
		return {};
	}
	if (cached?.mtime === mtime) {
		return cached.store;
	}
	let store: SessionGitStore = {};
	try {
		store = parseSessionGitStore(fs.readFileSync(file, 'utf8'));
	} catch {
		// unreadable this time: empty, and asked again next time
	}
	cached = { mtime, store };
	return store;
}

/**
 * Notes the branch `cwd` is on for `sessionId`. Returns true when the store changed (the caller
 * refreshes the session list). Never throws: a missing git only means no badge.
 */
export async function recordSessionBranch(profileDir: string, sessionId: string, cwd: string, worktree?: boolean): Promise<boolean> {
	const branch = await currentBranch(cwd);
	const next = noteBranch(readSessionGitStore(profileDir), sessionId, cwd, branch, worktree);
	if (next === undefined) {
		return false;
	}
	return writeStore(profileDir, next);
}

/** Saves the store and tells the listeners; false when it could not be written. */
async function writeStore(profileDir: string, next: SessionGitStore): Promise<boolean> {
	const file = path.join(profileDir, STORE_FILE);
	const aside = `${file}.${process.pid}`;
	try {
		await fs.promises.mkdir(profileDir, { recursive: true });
		await fs.promises.writeFile(aside, JSON.stringify(next));
		await fs.promises.rename(aside, file);
		return true;
	} catch {
		await fs.promises.rm(aside, { force: true }).catch(() => undefined);
		return false;
	}
}

/** Changes the store with `change` and saves it; false when there is no profile or it could not be saved. */
export async function updateSessionGitStore(change: (store: SessionGitStore) => SessionGitStore): Promise<boolean> {
	const profileDir = profileOfRecords?.();
	if (profileDir === undefined) {
		return false;
	}
	const saved = await writeStore(profileDir, change(readSessionGitStore(profileDir)));
	if (saved) {
		for (const listener of listeners) {
			listener();
		}
	}
	return saved;
}

/** The name the owner gave a session, if any. */
export function titleOfSession(sessionId: string): string | undefined {
	const profileDir = profileOfRecords?.();
	return profileDir === undefined ? undefined : readSessionGitStore(profileDir)[sessionId]?.title;
}
