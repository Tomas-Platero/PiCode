/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The registry of pi's commands as the chat's slash list reads it.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `command-registry.ts` carries no `vscode`: which commands a session holds, what their
 * argument surface says, and what the prompt file for one looks like are the parts worth
 * exercising, and none of them needs an editor.
 *
 * The argument hint is the chat's stand-in for the TUI's completion-after-a-space: pi's
 * `getArgumentCompletions` is called with the empty prefix (the first round the TUI
 * offers), synchronously, and whatever it answers becomes the prompt file's
 * `argument-hint` — the one argument surface the editor's prompt-file API can carry.
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	COMMAND_ARGUMENT_HINT_LIMIT,
	fileNameOf,
	piArgumentHintOf,
	piCommandsOfRunner,
	promptFileText,
} from '../src/command-registry.ts';

function sessionWithCommands(commands: readonly unknown[]): { extensionRunner: { getRegisteredCommands: () => unknown } } {
	return { extensionRunner: { getRegisteredCommands: () => commands } };
}

test('piCommandsOfRunner reads name, description and a command without extras', () => {
	const session = sessionWithCommands([
		{ name: 'mcp', description: 'Manage MCP servers' },
		{ name: 'plain' },
	]);
	assert.deepStrictEqual(piCommandsOfRunner(session), [
		{ name: 'mcp', description: 'Manage MCP servers' },
		{ name: 'plain' },
	]);
});

test('piCommandsOfRunner falls back to the invocation name pi deduplicates with', () => {
	const session = sessionWithCommands([{ invocationName: 'name:2' }]);
	assert.deepStrictEqual(piCommandsOfRunner(session), [{ name: 'name:2' }]);
});

test('piCommandsOfRunner answers empty for a session without a runner or a registry', () => {
	assert.deepStrictEqual(piCommandsOfRunner(undefined), []);
	assert.deepStrictEqual(piCommandsOfRunner({}), []);
	assert.deepStrictEqual(piCommandsOfRunner({ extensionRunner: { getRegisteredCommands: () => 'not a list' } }), []);
});

test('piCommandsOfRunner survives a registry that throws', () => {
	const session = sessionWithCommands([]);
	(session.extensionRunner as { getRegisteredCommands: () => unknown }).getRegisteredCommands = () => {
		throw new Error('boom');
	};
	assert.deepStrictEqual(piCommandsOfRunner(session), []);
});

test('the argument hint comes from the command\'s own empty-prefix completions', () => {
	const hint = piArgumentHintOf({
		getArgumentCompletions: (prefix: string) => {
			assert.strictEqual(prefix, '');
			return [
				{ value: 'login ', label: 'login' },
				{ value: 'logout ', label: 'logout' },
				{ value: 'reconnect ', label: 'reconnect' },
			];
		},
	});
	assert.strictEqual(hint, '[login | logout | reconnect]');
});

test('the argument hint accepts items that only carry a value, and deduplicates', () => {
	const hint = piArgumentHintOf({
		getArgumentCompletions: () => [
			{ value: 'login ' },
			{ value: 'login ' },
			{ label: ' logout ' },
		],
	});
	assert.strictEqual(hint, '[login | logout]');
});

test('a command without completions, with none to offer, gets no hint', () => {
	assert.strictEqual(piArgumentHintOf({ name: 'mcp' }), undefined);
	assert.strictEqual(piArgumentHintOf({ getArgumentCompletions: () => null }), undefined);
	assert.strictEqual(piArgumentHintOf({ getArgumentCompletions: () => [] }), undefined);
});

test('an async completion provider contributes no hint: the listing never awaits extensions', () => {
	const hint = piArgumentHintOf({
		getArgumentCompletions: async () => [{ value: 'login ' }],
	});
	assert.strictEqual(hint, undefined);
});

test('a completion provider that throws contributes no hint instead of failing the listing', () => {
	const hint = piArgumentHintOf({
		getArgumentCompletions: () => {
			throw new Error('boom');
		},
	});
	assert.strictEqual(hint, undefined);
});

test('a hint longer than the limit is trimmed, not dropped', () => {
	const hint = piArgumentHintOf({
		getArgumentCompletions: () => Array.from({ length: 30 }, (_, i) => ({ label: `option-${i}` })),
	});
	assert.ok(hint !== undefined && hint.length <= COMMAND_ARGUMENT_HINT_LIMIT + 3, `hint length ${hint?.length}`);
	assert.ok(hint!.startsWith('[option-0'));
	assert.ok(hint!.endsWith('…]'));
});

test('piCommandsOfRunner carries the hint of every command that answers one', () => {
	const session = sessionWithCommands([
		{
			name: 'mcp',
			description: 'Manage MCP servers',
			getArgumentCompletions: () => [{ value: 'login ', label: 'login' }],
		},
		{ name: 'quiet' },
	]);
	assert.deepStrictEqual(piCommandsOfRunner(session), [
		{ name: 'mcp', description: 'Manage MCP servers', argumentHint: '[login]' },
		{ name: 'quiet' },
	]);
});

test('the prompt file carries the description, and the hint as argument-hint front matter', () => {
	assert.strictEqual(
		promptFileText({ name: 'mcp', description: 'Manage MCP servers', argumentHint: '[login | logout]' }),
		'---\ndescription: Manage MCP servers\nargument-hint: [login | logout]\n---\n\nThe message text reaches pi as its /mcp command, with any arguments typed after it.\n',
	);
	assert.strictEqual(
		promptFileText({ name: 'quiet' }),
		"---\ndescription: pi's /quiet command\n---\n\nThe message text reaches pi as its /quiet command, with any arguments typed after it.\n",
	);
});

test('a command file name keeps the characters the file system and the editor accept', () => {
	assert.strictEqual(fileNameOf({ name: 'mcp' }), 'mcp.prompt.md');
	assert.strictEqual(fileNameOf({ name: 'weird name/x' }), 'weird-name-x.prompt.md');
});
