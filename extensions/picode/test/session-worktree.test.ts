/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A session on its own branch: PiCode keeps a git worktree per branch beside the repository, reuses
 * the one a branch already has, and removes it only when nothing in it is left uncommitted.
 */

import assert from 'assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const {
	worktreePathFor, isPicodeWorktree, parseWorktreeList, openWorktree, removeWorktree, listBranches, repoRootOf, WORKTREES_FOLDER,
} = await import('../src/session-worktree');

test('the worktree lives beside the repository, one folder per branch', () => {
	const repo = path.join('D:', 'code', 'app');
	assert.strictEqual(worktreePathFor(repo, 'feat/login'), path.join('D:', 'code', WORKTREES_FOLDER, 'app', 'feat-login'));
	assert.strictEqual(worktreePathFor(repo, 'fix:a b?'), path.join('D:', 'code', WORKTREES_FOLDER, 'app', 'fix-a-b-'));
});

test('a PiCode worktree is told apart by its folder', () => {
	assert.strictEqual(isPicodeWorktree(path.join('D:', 'code', WORKTREES_FOLDER, 'app', 'feat-x')), true);
	assert.strictEqual(isPicodeWorktree(path.join('D:', 'code', 'app')), false);
	assert.strictEqual(isPicodeWorktree(undefined), false);
});

test('git worktree list --porcelain reads as path and branch', () => {
	const text = 'worktree D:/code/app\nHEAD 1111\nbranch refs/heads/master\n\nworktree D:/code/.picode-worktrees/app/feat-x\nHEAD 2222\nbranch refs/heads/feat/x\n\nworktree D:/tmp/detached\nHEAD 3333\ndetached\n';
	assert.deepStrictEqual(parseWorktreeList(text), [
		{ path: path.resolve('D:/code/app'), branch: 'master' },
		{ path: path.resolve('D:/code/.picode-worktrees/app/feat-x'), branch: 'feat/x' },
		{ path: path.resolve('D:/tmp/detached'), branch: undefined },
	]);
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function scratchRepo(): { readonly repo: string; readonly root: string } {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'picode-wt-')));
	const repo = path.join(root, 'app');
	fs.mkdirSync(repo);
	git(repo, 'init', '-q', '-b', 'master');
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'init');
	return { repo, root };
}

test('a new branch gets its own worktree, and asking again reuses it', async () => {
	const { repo, root } = scratchRepo();
	try {
		assert.strictEqual(await repoRootOf(path.join(repo)), path.resolve(repo));
		const first = await openWorktree(repo, 'feat/x', { create: true });
		assert.deepStrictEqual(first, { ok: true, path: worktreePathFor(repo, 'feat/x'), created: true });
		assert.strictEqual(git(worktreePathFor(repo, 'feat/x'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/x');
		assert.deepStrictEqual(await openWorktree(repo, 'feat/x', { create: false }), { ok: true, path: worktreePathFor(repo, 'feat/x'), created: false });
		assert.deepStrictEqual((await listBranches(repo)).sort(), ['feat/x', 'master']);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the branch the repository itself is on runs in the repository', async () => {
	const { repo, root } = scratchRepo();
	try {
		assert.deepStrictEqual(await openWorktree(repo, 'master', { create: false }), { ok: true, path: path.resolve(repo), created: false });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a bad branch name or an existing one asked as new is refused with a reason', async () => {
	const { repo, root } = scratchRepo();
	try {
		assert.deepStrictEqual(await openWorktree(repo, 'bad..name', { create: true }), { ok: false, reason: 'invalidName' });
		assert.deepStrictEqual(await openWorktree(repo, 'master', { create: true }), { ok: false, reason: 'exists' });
		assert.deepStrictEqual(await openWorktree(repo, 'nope', { create: false }), { ok: false, reason: 'missing' });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a worktree with uncommitted work is kept; a clean one is removed', async () => {
	const { repo, root } = scratchRepo();
	try {
		const opened = await openWorktree(repo, 'feat/y', { create: true });
		assert.ok(opened.ok);
		fs.writeFileSync(path.join(opened.path, 'a.txt'), 'changed\n');
		assert.strictEqual(await removeWorktree(opened.path), 'dirty');
		assert.ok(fs.existsSync(opened.path));
		git(opened.path, 'checkout', '--', 'a.txt');
		assert.strictEqual(await removeWorktree(opened.path), 'removed');
		assert.ok(!fs.existsSync(opened.path));
		assert.strictEqual(await removeWorktree(path.resolve(repo)), 'notPicode');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const { branchSlugOf, renameBranch, changedFiles, mergeIntoBase, defaultBaseOf } = await import('../src/session-worktree');

test('the branch name comes from the first message, short and git-safe', () => {
	assert.strictEqual(branchSlugOf('Arregla el formulario de login en móvil, por favor!'), 'picode/arregla-el-formulario-de-login-en-movil');
	assert.strictEqual(branchSlugOf('   '), undefined);
	assert.strictEqual(branchSlugOf('¿¿??'), undefined);
	assert.ok((branchSlugOf('a'.repeat(200)) ?? '').length <= 'picode/'.length + 40);
});

test('a session branch is renamed in place, and a taken name gets a number', async () => {
	const { repo, root } = scratchRepo();
	try {
		const opened = await openWorktree(repo, 'picode/new-1', { create: true });
		assert.ok(opened.ok);
		git(repo, 'branch', 'picode/fix-login');
		assert.strictEqual(await renameBranch(opened.path, 'picode/new-1', 'picode/fix-login'), 'picode/fix-login-2');
		assert.strictEqual(git(opened.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'picode/fix-login-2');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the changes of a copy are its commits and its uncommitted files against the base', async () => {
	const { repo, root } = scratchRepo();
	try {
		const opened = await openWorktree(repo, 'feat/z', { create: true });
		assert.ok(opened.ok);
		assert.strictEqual(await defaultBaseOf(opened.path), 'master');
		fs.writeFileSync(path.join(opened.path, 'b.txt'), 'new\n');
		git(opened.path, 'add', 'b.txt');
		git(opened.path, 'commit', '-q', '-m', 'add b');
		fs.writeFileSync(path.join(opened.path, 'a.txt'), 'changed\n');
		const files = await changedFiles(opened.path, 'master');
		assert.deepStrictEqual(files.map(f => [f.path, f.status]).sort(), [['a.txt', 'modified'], ['b.txt', 'added']]);
		assert.ok(files.every(f => typeof f.baseRef === 'string' && f.baseRef.length >= 7));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('merging a copy into the base needs the project on that branch and clean', async () => {
	const { repo, root } = scratchRepo();
	try {
		const opened = await openWorktree(repo, 'feat/m', { create: true });
		assert.ok(opened.ok);
		fs.writeFileSync(path.join(opened.path, 'm.txt'), 'm\n');
		git(opened.path, 'add', '.');
		git(opened.path, 'commit', '-q', '-m', 'm');
		fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x\n');
		assert.strictEqual(await mergeIntoBase(opened.path, 'master'), 'projectDirty');
		fs.rmSync(path.join(repo, 'dirty.txt'));
		fs.writeFileSync(path.join(opened.path, 'pending.txt'), 'x\n');
		assert.strictEqual(await mergeIntoBase(opened.path, 'master'), 'copyDirty');
		fs.rmSync(path.join(opened.path, 'pending.txt'));
		assert.strictEqual(await mergeIntoBase(opened.path, 'master'), 'merged');
		assert.ok(fs.existsSync(path.join(repo, 'm.txt')));
		git(repo, 'checkout', '-q', '-b', 'other');
		assert.strictEqual(await mergeIntoBase(opened.path, 'master'), 'projectOnOtherBranch');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const { changedLines, parseNumstatFiles } = await import('../src/session-worktree');

test('numstat reads per file, and a binary file counts as no lines', () => {
	const files = parseNumstatFiles('3\t1\ta.txt\n-\t-\timg.png\n');
	assert.deepStrictEqual(files.get('a.txt'), { added: 3, removed: 1 });
	assert.deepStrictEqual(files.get('img.png'), { added: 0, removed: 0 });
});

test('a copy counts its lines added and removed, untracked files included', async () => {
	const { repo, root } = scratchRepo();
	try {
		assert.deepStrictEqual(await changedLines(repo), []);
		const opened = await openWorktree(repo, 'feat/lines', { create: true });
		assert.ok(opened.ok);
		assert.deepStrictEqual(await changedLines(opened.path), []);
		fs.writeFileSync(path.join(opened.path, 'a.txt'), 'two\nthree\n');
		fs.writeFileSync(path.join(opened.path, 'new.txt'), 'x\ny\nz');
		const lines = await changedLines(opened.path);
		assert.deepStrictEqual(lines.map(f => [f.path, f.status, f.added, f.removed]).sort(), [['a.txt', 'modified', 2, 1], ['new.txt', 'added', 3, 0]]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
