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
