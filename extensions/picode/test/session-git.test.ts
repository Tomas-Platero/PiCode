/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which git branches each conversation worked on: recorded after a turn, shown on the session
 * row only when it says something (a branch other than the repository's default one).
 */

import assert from 'assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { noteBranch, parseSessionGitStore, rowGitFor, parseDefaultBranch, withTitle, renameRecordedBranch } = await import('../src/session-git');

test('a first branch is recorded for the session', () => {
	const next = noteBranch({}, 'abc', '/repo', 'feat/x');
	assert.deepStrictEqual(next, { abc: { cwd: '/repo', branches: ['feat/x'] } });
});

test('the same branch twice changes nothing', () => {
	const store = { abc: { cwd: '/repo', branches: ['feat/x'] } };
	assert.strictEqual(noteBranch(store, 'abc', '/repo', 'feat/x'), undefined);
});

test('a new branch is appended in order, keeping the last one current', () => {
	const store = { abc: { cwd: '/repo', branches: ['feat/x'] } };
	assert.deepStrictEqual(noteBranch(store, 'abc', '/repo', 'feat/y')?.abc.branches, ['feat/x', 'feat/y']);
	const back = noteBranch({ abc: { cwd: '/repo', branches: ['feat/x', 'feat/y'] } }, 'abc', '/repo', 'feat/x');
	assert.deepStrictEqual(back?.abc.branches, ['feat/y', 'feat/x']);
});

test('a detached head or no repository records nothing', () => {
	assert.strictEqual(noteBranch({}, 'abc', '/repo', undefined), undefined);
	assert.strictEqual(noteBranch({}, 'abc', '/repo', 'HEAD'), undefined);
});

test('a broken or foreign store reads as empty', () => {
	assert.deepStrictEqual(parseSessionGitStore('not json'), {});
	assert.deepStrictEqual(parseSessionGitStore('[1,2]'), {});
	assert.deepStrictEqual(parseSessionGitStore('{"a":{"cwd":"/r","branches":["x",3]},"b":7}'), { a: { cwd: '/r', branches: ['x'] } });
});

test('the row shows the current branch only when it is not the default one', () => {
	assert.strictEqual(rowGitFor({ cwd: '/r', branches: ['master'] }, 'master'), undefined);
	assert.deepStrictEqual(rowGitFor({ cwd: '/r', branches: ['master', 'feat/x'] }, 'master'), { badge: '$(git-branch) feat/x', branches: ['feat/x'] });
	assert.deepStrictEqual(rowGitFor({ cwd: '/r', branches: ['feat/a', 'feat/b'] }, undefined), { badge: '$(git-branch) feat/b', branches: ['feat/a', 'feat/b'] });
});

test('without a known default, main and master are treated as default', () => {
	assert.strictEqual(rowGitFor({ cwd: '/r', branches: ['main'] }, undefined), undefined);
});

test('a session in its own worktree always shows its branch', () => {
	assert.deepStrictEqual(rowGitFor({ cwd: '/w', branches: ['master'], worktree: true }, 'master'), { badge: '$(git-branch) master', branches: ['master'] });
});

test('the default branch comes from origin/HEAD', () => {
	assert.strictEqual(parseDefaultBranch('refs/remotes/origin/master\n'), 'master');
	assert.strictEqual(parseDefaultBranch('refs/remotes/upstream/dev/main'), 'dev/main');
	assert.strictEqual(parseDefaultBranch(''), undefined);
});

test('a session can be given its own title, and an empty one clears it', () => {
	const store = { abc: { cwd: '/repo', branches: ['feat/x'] } };
	assert.deepStrictEqual(withTitle(store, 'abc', '  Login form  ').abc, { cwd: '/repo', branches: ['feat/x'], title: 'Login form' });
	assert.deepStrictEqual(withTitle(withTitle(store, 'abc', 'x'), 'abc', '').abc, { cwd: '/repo', branches: ['feat/x'] });
	assert.deepStrictEqual(withTitle({}, 'new', 'Only a title').new, { cwd: '', branches: [], title: 'Only a title' });
});

test('a title survives reading the store back', () => {
	assert.deepStrictEqual(parseSessionGitStore('{"a":{"cwd":"/r","branches":["x"],"title":"T"}}'), { a: { cwd: '/r', branches: ['x'], title: 'T' } });
});

test('a renamed branch replaces its old name in the record', () => {
	const store = { abc: { cwd: '/w', branches: ['picode/new-1'], worktree: true } };
	assert.deepStrictEqual(renameRecordedBranch(store, 'abc', 'picode/new-1', 'picode/fix-login').abc.branches, ['picode/fix-login']);
	assert.strictEqual(renameRecordedBranch(store, 'zzz', 'a', 'b'), store);
});
