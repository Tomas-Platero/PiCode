/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chat session's working directory, as the session must receive it.
 *
 * The chat used to hand pi the workspace's first folder as-is (`resolveProjectScope().cwd`). When
 * that folder is open in the editor but is not on disk — a multi-root workspace keeps a folder in
 * `workspaceFolders` after it is moved, renamed or deleted — pi still started (a session tolerates
 * a missing cwd), but every stdio MCP server was spawned **into** that directory, and Node answers
 * a spawn whose `cwd` does not exist with ENOENT *naming the command*: `spawn node ENOENT` and, for
 * the `.cmd` shims cross-spawn routes through cmd.exe, `spawn C:\WINDOWS\system32\cmd.exe ENOENT`
 * — which sends everyone looking at the command instead of at the directory. The session's
 * directory must exist: the first workspace folder that does, and the home directory when none
 * does, with every folder that was skipped said.
 */

import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveSessionCwd, missingDirectories } from '../src/session-cwd.ts';

const home = mkdtempSync(join(tmpdir(), 'session-cwd-home-'));
const real = mkdtempSync(join(tmpdir(), 'session-cwd-real-'));
const gone = join(real, 'moved-away');

test('the first workspace folder, when it exists, is the session directory', () => {
	const picked = resolveSessionCwd([real, home], home);
	assert.strictEqual(picked.cwd, real);
	assert.deepStrictEqual(picked.missing, []);
});

test('a folder that is not on disk is skipped for the first one that is, and said', () => {
	const picked = resolveSessionCwd([gone, real, home], home);
	assert.strictEqual(picked.cwd, real);
	assert.deepStrictEqual(picked.missing, [gone]);
});

test('a file that happens to share the name is not a directory and is skipped too', () => {
	const file = join(real, 'a-file');
	writeFileSync(file, 'not a directory');
	const picked = resolveSessionCwd([file, home], home);
	assert.strictEqual(picked.cwd, home);
	assert.deepStrictEqual(picked.missing, [file]);
});

test('when no workspace folder exists, pi runs in the home directory and every folder is said', () => {
	const picked = resolveSessionCwd([gone, join(gone, 'deeper')], home);
	assert.strictEqual(picked.cwd, home);
	assert.deepStrictEqual(picked.missing, [gone, join(gone, 'deeper')]);
});

test('no folders at all (no window open) is the home directory with nothing said', () => {
	const picked = resolveSessionCwd([], home);
	assert.strictEqual(picked.cwd, home);
	assert.deepStrictEqual(picked.missing, []);
});

test('missingDirectories checks every folder, wherever it sits in the order', () => {
	// The workspace keeps folders in its own order; one that is gone after an existing
	// one is still gone, and an area context must say so instead of trusting that only
	// the folders before the first hit can be missing.
	assert.deepStrictEqual(missingDirectories([real, gone, join(gone, 'deeper')]), [gone, join(gone, 'deeper')]);
	assert.deepStrictEqual(missingDirectories([real]), []);
	assert.deepStrictEqual(missingDirectories([]), []);
});

test('a file with the folder\'s name is missing too: a directory is what counts', () => {
	const file = join(real, 'a-file');
	writeFileSync(file, 'not a directory');
	assert.deepStrictEqual(missingDirectories([file]), [file]);
});
