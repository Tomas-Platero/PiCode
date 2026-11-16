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

const { noteBranch, parseSessionGitStore, rowGitFor, parseDefaultBranch } = await import('../src/session-git');

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
