/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One session per branch: each branch a session works on gets its own git worktree, a full copy of
 * the project checked out on that branch, so two sessions never edit the same files.
 *
 * The worktrees live beside the repository (`<parent>/.picode-worktrees/<repo>/<branch>`), never
 * inside it, so the project's own tools and searches do not see them. A branch that already has a
 * worktree (the repository's own checkout included) reuses it: git refuses to check one branch out
 * twice.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { countLines } from './diff-stat';

export const WORKTREES_FOLDER = '.picode-worktrees';

const GIT_TIMEOUT_MS = 60_000;

let activeFolder: string | undefined;

/** The folder the chat that spoke last works in: Status and the Changes count follow it. */
export function setActiveChatFolder(folder: string): void {
	activeFolder = folder;
}

/** The active chat's folder when it is one of PiCode's worktrees; undefined means "the window's folder". */
export function activeWorktreeFolder(): string | undefined {
	return isPicodeWorktree(activeFolder) && activeFolder !== undefined && fs.existsSync(activeFolder) ? activeFolder : undefined;
}

export interface WorktreeEntry {
	readonly path: string;
	/** Undefined on a detached head. */
	readonly branch: string | undefined;
}

export type OpenWorktreeResult =
	| { readonly ok: true; readonly path: string; readonly created: boolean }
	| { readonly ok: false; readonly reason: 'invalidName' | 'exists' | 'missing' | 'notRepo' | 'failed'; readonly detail?: string };

export type RemoveWorktreeResult = 'removed' | 'dirty' | 'notPicode' | 'failed';

/** Where the worktree of `branch` goes: beside the repository, one folder per branch. */
export function worktreePathFor(repoRoot: string, branch: string): string {
	const safe = branch.replace(/[\\/:*?"<>|\s]/g, '-');
	return path.join(path.dirname(repoRoot), WORKTREES_FOLDER, path.basename(repoRoot), safe);
}

/** Whether `folder` is one of the worktrees PiCode made for a session. */
export function isPicodeWorktree(folder: string | undefined): boolean {
	if (folder === undefined || folder === '') {
		return false;
	}
	return path.resolve(folder).split(path.sep).includes(WORKTREES_FOLDER);
}

/** `git worktree list --porcelain` → each worktree's folder and branch. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	for (const block of text.split(/\r?\n\r?\n/)) {
		let folder: string | undefined;
		let branch: string | undefined;
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith('worktree ')) {
				folder = line.slice('worktree '.length);
			} else if (line.startsWith('branch ')) {
				branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
			}
		}
		if (folder !== undefined) {
			entries.push({ path: path.resolve(folder), branch });
		}
	}
	return entries;
}

interface GitAnswer {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

function git(cwd: string, args: readonly string[]): Promise<GitAnswer> {
	return new Promise(resolve => {
		execFile('git', args, { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ ok: !error, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
		});
	});
}

/** The top folder of the repository `cwd` is in (the main checkout, also from inside a worktree). */
export async function repoRootOf(cwd: string): Promise<string | undefined> {
	const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
	if (!common.ok || common.stdout === '') {
		return undefined;
	}
	// `<root>/.git` for a normal repository; the main checkout is its parent.
	const commonDir = path.resolve(common.stdout);
	if (path.basename(commonDir) === '.git') {
		return path.dirname(commonDir);
	}
	const top = await git(cwd, ['rev-parse', '--show-toplevel']);
	return top.ok && top.stdout !== '' ? path.resolve(top.stdout) : undefined;
}

/** The local branches of the repository. */
export async function listBranches(repoRoot: string): Promise<string[]> {
	const answer = await git(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
	return answer.ok ? answer.stdout.split(/\r?\n/).filter(name => name !== '') : [];
}

/** The repository's worktrees, its own checkout first. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
	const answer = await git(repoRoot, ['worktree', 'list', '--porcelain']);
	return answer.ok ? parseWorktreeList(answer.stdout) : [];
}

/**
 * The folder a session on `branch` runs in. `create` makes a new branch from the current commit;
 * otherwise the branch must exist. A branch that is already checked out somewhere runs there.
 */
export async function openWorktree(repoRoot: string, branch: string, options: { readonly create: boolean }): Promise<OpenWorktreeResult> {
	const name = branch.trim();
	const valid = await git(repoRoot, ['check-ref-format', '--branch', name]);
	if (name === '' || !valid.ok) {
		return { ok: false, reason: 'invalidName' };
	}
	const branches = await listBranches(repoRoot);
	if (branches.length === 0 && !(await git(repoRoot, ['rev-parse', '--git-dir'])).ok) {
		return { ok: false, reason: 'notRepo' };
	}
	const exists = branches.includes(name);
	if (options.create && exists) {
		return { ok: false, reason: 'exists' };
	}
	if (!options.create && !exists) {
		return { ok: false, reason: 'missing' };
	}
	const checkedOut = (await listWorktrees(repoRoot)).find(entry => entry.branch === name && fs.existsSync(entry.path));
	if (checkedOut !== undefined) {
		return { ok: true, path: checkedOut.path, created: false };
	}
	const target = worktreePathFor(repoRoot, name);
	// A folder left behind by a worktree git no longer knows (removed by hand) is cleared from
	// git's records first, or `worktree add` refuses the path.
	await git(repoRoot, ['worktree', 'prune']);
	if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
		return { ok: false, reason: 'failed', detail: `${target} is not empty` };
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const added = options.create
		? await git(repoRoot, ['worktree', 'add', '-b', name, target])
		: await git(repoRoot, ['worktree', 'add', target, name]);
	if (!added.ok) {
		return { ok: false, reason: 'failed', detail: added.stderr };
	}
	return { ok: true, path: target, created: true };
}

/** Removes a PiCode worktree, but never one with uncommitted or untracked work in it. */
export async function removeWorktree(folder: string): Promise<RemoveWorktreeResult> {
	if (!isPicodeWorktree(folder)) {
		return 'notPicode';
	}
	const status = await git(folder, ['status', '--porcelain']);
	if (!status.ok) {
		return 'failed';
	}
	if (status.stdout !== '') {
		return 'dirty';
	}
	const repoRoot = await repoRootOf(folder);
	const removed = await git(repoRoot ?? folder, ['worktree', 'remove', folder]);
	return removed.ok ? 'removed' : 'failed';
}

/** The prefix of the branch a new session's copy starts on, before its first message names it. */
const PLACEHOLDER_PREFIX = 'picode/new-';

/** A placeholder branch name for a new session's copy (`picode/new-1a2b`). */
export function placeholderBranch(): string {
	return `${PLACEHOLDER_PREFIX}${Math.random().toString(16).slice(2, 6)}`;
}

/** Whether a branch is still a new session's placeholder. */
export function isPlaceholderBranch(branch: string): boolean {
	return branch.startsWith(PLACEHOLDER_PREFIX);
}

/** How long a branch name taken from a message may be, after the `picode/` prefix. */
const SLUG_MAX = 40;

/** A branch name from a message: `picode/` and its first words, lower case, without accents or symbols. */
export function branchSlugOf(text: string): string | undefined {
	const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(word => word !== '');
	let slug = '';
	for (const word of words) {
		const next = slug === '' ? word : `${slug}-${word}`;
		if (next.length > SLUG_MAX) {
			break;
		}
		slug = next;
	}
	if (slug === '' && words.length > 0) {
		slug = words[0].slice(0, SLUG_MAX);
	}
	return slug === '' ? undefined : `picode/${slug}`;
}

/** Renames the branch a worktree is on; a name already taken gets `-2`, `-3`… Returns the name it got, or undefined. */
export async function renameBranch(worktree: string, from: string, to: string): Promise<string | undefined> {
	const taken = new Set(await listBranches(worktree));
	let name = to;
	for (let index = 2; taken.has(name) && index < 100; index++) {
		name = `${to}-${index}`;
	}
	const renamed = await git(worktree, ['branch', '-m', from, name]);
	return renamed.ok ? name : undefined;
}

/** The branch a copy was made from: the repository's default branch (`origin/HEAD`), else `main` or `master`. */
export async function defaultBaseOf(cwd: string): Promise<string | undefined> {
	const head = await git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
	const remote = head.ok ? head.stdout.match(/^refs\/remotes\/[^/]+\/(.+)$/)?.[1] : undefined;
	if (remote !== undefined) {
		return remote;
	}
	const branches = await listBranches(cwd);
	return ['main', 'master'].find(name => branches.includes(name));
}

export interface CopyChange {
	/** Relative to the copy, with forward slashes. */
	readonly path: string;
	readonly status: 'added' | 'modified' | 'deleted';
	/** The commit the base side is read from: where the copy left the base. */
	readonly baseRef: string;
}

/** A file a copy changed, with its lines added and removed. */
export interface CopyLineChange extends CopyChange {
	readonly added: number;
	readonly removed: number;
}

/** `git diff --numstat` by file: `12<TAB>3<TAB>path`; a binary file (`-<TAB>-`) counts as no lines. */
export function parseNumstatFiles(text: string): Map<string, { added: number; removed: number }> {
	const files = new Map<string, { added: number; removed: number }>();
	for (const line of text.split(/\r?\n/)) {
		const [added, removed, file] = line.split('\t');
		if (file !== undefined && file !== '') {
			files.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
		}
	}
	return files;
}

/** New files bigger than this count as no lines: they are build output or data, not code. */
const MAX_NEW_FILE_BYTES = 2 * 1024 * 1024;

/** What a copy changed against its base branch, file by file with its lines; empty when nothing did. */
export async function changedLines(worktree: string): Promise<CopyLineChange[]> {
	const base = await defaultBaseOf(worktree);
	const files = base === undefined ? [] : await changedFiles(worktree, base);
	if (files.length === 0) {
		return [];
	}
	const numstat = await git(worktree, ['diff', '--numstat', '--no-renames', files[0].baseRef]);
	const counts = parseNumstatFiles(numstat.ok ? numstat.stdout : '');
	return Promise.all(files.map(async file => {
		const known = counts.get(file.path);
		if (known !== undefined) {
			return { ...file, ...known };
		}
		// An untracked file: every line of it is new.
		try {
			const full = path.join(worktree, file.path);
			const added = (await fs.promises.stat(full)).size <= MAX_NEW_FILE_BYTES ? countLines(await fs.promises.readFile(full, 'utf8')) : 0;
			return { ...file, added, removed: 0 };
		} catch {
			return { ...file, added: 0, removed: 0 };
		}
	}));
}

/** What a copy changed against `base`: its commits since it left it, and what is not committed yet. */
export async function changedFiles(worktree: string, base: string): Promise<CopyChange[]> {
	const mergeBase = await git(worktree, ['merge-base', base, 'HEAD']);
	if (!mergeBase.ok || mergeBase.stdout === '') {
		return [];
	}
	const baseRef = mergeBase.stdout;
	// Against the working tree, so commits and uncommitted edits both count; new untracked files too.
	const diff = await git(worktree, ['diff', '--name-status', '--no-renames', baseRef]);
	const untracked = await git(worktree, ['ls-files', '--others', '--exclude-standard']);
	const changes = new Map<string, CopyChange>();
	for (const line of diff.ok ? diff.stdout.split(/\r?\n/) : []) {
		const [code, file] = line.split('\t');
		if (file === undefined) {
			continue;
		}
		const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
		changes.set(file, { path: file, status, baseRef });
	}
	for (const file of untracked.ok ? untracked.stdout.split(/\r?\n/) : []) {
		if (file !== '' && !changes.has(file)) {
			changes.set(file, { path: file, status: 'added', baseRef });
		}
	}
	return [...changes.values()];
}

/** A file's content at `ref` in the repository of `cwd`; undefined when it did not exist there. */
export async function fileAtRef(cwd: string, ref: string, file: string): Promise<string | undefined> {
	const shown = await git(cwd, ['show', `${ref}:${file}`]);
	return shown.ok ? shown.stdout : undefined;
}

export type MergeResult = 'merged' | 'copyDirty' | 'projectDirty' | 'projectOnOtherBranch' | 'conflict' | 'failed';

/**
 * Merges the copy's branch into `base` in the project folder. Only when the copy has nothing
 * uncommitted, and the project folder is on `base` with nothing uncommitted: a merge never mixes
 * with work in progress. A conflict is undone, so the project is left as it was.
 */
export async function mergeIntoBase(worktree: string, base: string): Promise<MergeResult> {
	const root = await repoRootOf(worktree);
	const branch = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
	if (root === undefined || !branch.ok) {
		return 'failed';
	}
	if ((await git(worktree, ['status', '--porcelain'])).stdout !== '') {
		return 'copyDirty';
	}
	const rootBranch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
	if (rootBranch.stdout !== base) {
		return 'projectOnOtherBranch';
	}
	if ((await git(root, ['status', '--porcelain'])).stdout !== '') {
		return 'projectDirty';
	}
	const merged = await git(root, ['merge', '--no-ff', '--no-edit', branch.stdout]);
	if (merged.ok) {
		return 'merged';
	}
	await git(root, ['merge', '--abort']);
	return 'conflict';
}

/** Pushes the copy's branch to `origin`, setting it as upstream. */
export async function pushBranch(worktree: string): Promise<{ readonly ok: boolean; readonly branch: string | undefined; readonly detail: string }> {
	const branch = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
	if (!branch.ok) {
		return { ok: false, branch: undefined, detail: branch.stderr };
	}
	const pushed = await git(worktree, ['push', '-u', 'origin', branch.stdout]);
	return { ok: pushed.ok, branch: branch.stdout, detail: pushed.stderr };
}
