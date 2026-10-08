/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where the durable agent is looked for, as one ordered list.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `durable-folder.ts` carries no `vscode` import. The rule being pinned here: an agent is always
 * found **wherever PiCode is installed**, without the owner setting anything and without depending
 * on which project happens to be open — and a copy that travels with the project still wins, so the
 * agent can be worked on inside the project it is being tried in.
 */

import assert from 'assert';
import { test } from 'node:test';
import * as path from 'path';
import { DEFAULT_DURABLE_FOLDER, durableFolderCandidates, SHIPPED_DURABLE_FOLDER } from '../src/durable-folder.ts';

/** A fully resolved app root, so the arithmetic below is the same on every platform. */
const appRoot = () => path.resolve(process.cwd(), 'install', 'resources', 'app');

test('the roots are tried in order: the open folders, the repository above the pack, then the installation', () => {
	const candidates = durableFolderCandidates(
		DEFAULT_DURABLE_FOLDER,
		[path.resolve(process.cwd(), 'work', 'one'), path.resolve(process.cwd(), 'work', 'two')],
		appRoot());

	assert.deepEqual(candidates.slice(0, 2), [
		path.join(path.resolve(process.cwd(), 'work', 'one'), 'experimental', 'durable'),
		path.join(path.resolve(process.cwd(), 'work', 'two'), 'experimental', 'durable')
	]);
	// The repository a packed build sits in: `PiCode-win32-x64` is unpacked inside the PiCode
	// source tree, so its agent is three levels above `<app>/resources/app`.
	assert.equal(candidates[2], path.join(process.cwd(), 'experimental', 'durable'));
	// And last, the agent this installation carries: `<app>/resources/pi-durable`, the only
	// candidate an installed editor has.
	assert.equal(candidates[3], path.join(process.cwd(), 'install', 'resources', SHIPPED_DURABLE_FOLDER));
});

test('what the installation carries is tried whatever the setting is spelled as', () => {
	// A custom relative path still ends at the agent that ships with the editor: the value says
	// where else to look, never that the installation's own agent should be ignored.
	const candidates = durableFolderCandidates('my/agent', [], appRoot());

	assert.deepEqual(candidates, [
		path.join(process.cwd(), 'my', 'agent'),
		path.join(process.cwd(), 'install', 'resources', SHIPPED_DURABLE_FOLDER)
	]);
});

test('with no folder open the installation is still a candidate, so nothing has to be configured', () => {
	const candidates = durableFolderCandidates(DEFAULT_DURABLE_FOLDER, [], appRoot());

	assert.equal(candidates.length, 2);
	assert.equal(candidates.at(-1), path.join(process.cwd(), 'install', 'resources', SHIPPED_DURABLE_FOLDER));
});
