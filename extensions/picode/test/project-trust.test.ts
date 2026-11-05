/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A folder's `.pi` (extensions, packages, settings, MCP servers) is code the owner did not choose
 * to run: pi may only load it when the editor trusts that folder. pi itself trusts every project
 * unless told otherwise, so these tests also pin that every start of pi says so.
 */

import assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { isProjectTrusted, projectSettingsOption } from '../src/project-trust.ts';

const SRC = path.join(import.meta.dirname, '..', 'src');

test('a folder of a trusted window is trusted', () => {
	const folder = path.resolve('work', 'app');
	assert.strictEqual(isProjectTrusted(folder, true, [folder]), true);
});

test('a folder inside an open folder is trusted with it', () => {
	const folder = path.resolve('work', 'app');
	assert.strictEqual(isProjectTrusted(path.join(folder, 'packages', 'one'), true, [folder]), true);
});

test('a folder of an untrusted window is not trusted', () => {
	const folder = path.resolve('work', 'app');
	assert.strictEqual(isProjectTrusted(folder, false, [folder]), false);
});

test('a conversation resumed outside the open folders is not trusted', () => {
	const folder = path.resolve('work', 'app');
	assert.strictEqual(isProjectTrusted(path.resolve('downloads', 'other'), true, [folder]), false);
	assert.strictEqual(isProjectTrusted(path.resolve('work', 'app-other'), true, [folder]), false);
	assert.strictEqual(isProjectTrusted(path.dirname(folder), true, [folder]), false);
});

test('a window with no folder trusts no project', () => {
	assert.strictEqual(isProjectTrusted(path.resolve('home'), true, []), false);
});

test('pi is told the answer when its settings are created', () => {
	const calls: unknown[][] = [];
	const made = { made: true };
	const option = projectSettingsOption(
		{ SettingsManager: { create: (...args: unknown[]) => { calls.push(args); return made; } } },
		'/cwd',
		'/profile',
		false,
	);
	assert.deepStrictEqual(calls, [['/cwd', '/profile', { projectTrusted: false }]]);
	assert.strictEqual(option.settingsManager, made);
});

test('every start of pi says whether the folder is trusted', () => {
	// The setup window starts pi in the product's own folder, which no download can reach.
	const exempt = new Set(['onboarding-host.ts']);
	const starts: string[] = [];
	for (const file of fs.readdirSync(SRC).filter(name => name.endsWith('.ts') && !exempt.has(name))) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf8');
		for (const match of text.matchAll(/\.createAgentSessionServices\(\{/g)) {
			starts.push(file);
			const call = text.slice(match.index, match.index + 400);
			assert.ok(call.includes('settingsForFolder('), `${file} starts pi without saying whether the folder is trusted`);
		}
	}
	assert.ok(starts.length >= 6, `expected every start of pi to be found, found ${starts.length}`);
});

test('granting trust drops what was loaded without it', () => {
	const extension = fs.readFileSync(path.join(SRC, 'extension.ts'), 'utf8');
	const grant = extension.slice(extension.indexOf('onDidGrantWorkspaceTrust('));
	assert.ok(grant.slice(0, 200).includes('resetChatSession()'), 'the live chats keep a pi without the project');
	assert.ok(grant.slice(0, 200).includes('disposeResumedSessions()'), 'resumed conversations keep a pi without the project');
	assert.ok(extension.includes('onDidGrantWorkspaceTrust(() => piCommands.refresh())'), 'the / menu is not asked again');
	const commands = fs.readFileSync(path.join(SRC, 'commands.ts'), 'utf8');
	assert.ok(commands.includes('const key = [String(vscode.workspace.isTrusted), '), 'the / menu keeps the list read without trust');
});
