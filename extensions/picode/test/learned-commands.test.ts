/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The terminal-only commands the chat learns by itself. The notices below are the real ones the
 * profile's packages raised in the chat (2026-10-29).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTerminalOnlyNotice, LEARNED_COMMANDS_KEY, LearnedCommands, terminalOnlyVerdict } from '../src/learned-commands.ts';
import { displayedCustomText, LEARNED_TERMINAL_ONLY, routeSlash } from '../src/chat-commands.ts';

test('a notice with no way forward means the command needs pi’s terminal', () => {
	assert.equal(isTerminalOnlyNotice('The jobs overlay requires TUI mode.'), true);
	assert.equal(isTerminalOnlyNotice('Review session permission is unavailable: it requires the interactive Pi TUI, a non-child session'), true);
	assert.equal(isTerminalOnlyNotice('This panel only works in the TUI'), true);
});

test('a notice that offers another way is not a verdict', () => {
	assert.equal(isTerminalOnlyNotice('/btw cannot open its composer outside Pi\'s TUI. Pass the question inline instead.'), false);
	assert.equal(isTerminalOnlyNotice('Usage: /lens-allow-edit <path>'), false);
	assert.equal(isTerminalOnlyNotice('Cache stats reset'), false);
	assert.equal(isTerminalOnlyNotice('Run /harness-improvement from a complete SpecPi source checkout'), false);
});

test('silence counts only for a command run bare', () => {
	assert.deepEqual(terminalOnlyVerdict({ args: '', notices: [], shownSomething: false }), {});
	assert.equal(terminalOnlyVerdict({ args: 'default', notices: [], shownSomething: false }), undefined);
	assert.equal(terminalOnlyVerdict({ args: '', notices: ['Intercom pool: default'], shownSomething: true }), undefined);
	assert.deepEqual(terminalOnlyVerdict({ args: '', notices: ['The agents overlay requires TUI mode.'], shownSomething: true }), { message: 'The agents overlay requires TUI mode.' });
});

/** A global state in memory. */
function memoryStorage(): { values: Map<string, unknown>; get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> } {
	const values = new Map<string, unknown>();
	return {
		values,
		get: <T>(key: string) => values.get(key) as T | undefined,
		update: async (key: string, value: unknown) => { values.set(key, value); },
	};
}

test('a learned command is remembered until its file changes', async () => {
	const storage = memoryStorage();
	const versions = new Map([['/pkg/index.ts', 'v1']]);
	const learned = new LearnedCommands(storage, source => `${source}@${versions.get(source ?? '') ?? '-'}`);
	assert.equal(learned.has('panel', '/pkg/index.ts'), false);
	await learned.learn('panel', '/pkg/index.ts', 'requires TUI');
	assert.equal(learned.has('panel', '/pkg/index.ts'), true);
	assert.equal(learned.get('panel', '/pkg/index.ts')?.message, 'requires TUI');
	// The package was updated: the new version gets a fresh chance.
	versions.set('/pkg/index.ts', 'v2');
	assert.equal(learned.has('panel', '/pkg/index.ts'), false);
	await learned.forget('panel');
	assert.deepEqual(storage.values.get(LEARNED_COMMANDS_KEY), {});
});

test('a learned command is answered, not run', () => {
	const context = {
		extensionCommands: new Set(['panel', 'works']),
		skills: new Set<string>(),
		learnedTerminalOnly: (name: string) => name === 'panel' ? LEARNED_TERMINAL_ONLY : undefined,
	};
	assert.deepEqual(routeSlash('/panel', context), { kind: 'unavailable', name: 'panel', command: LEARNED_TERMINAL_ONLY });
	assert.deepEqual(routeSlash('/works', context), { kind: 'pi', text: '/works' });
});

test('what an extension posts for the person to read is shown', () => {
	assert.equal(displayedCustomText({ role: 'custom', display: true, content: 'Done: 3 files' }), 'Done: 3 files');
	assert.equal(displayedCustomText({ role: 'custom', display: true, content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
	assert.equal(displayedCustomText({ role: 'custom', display: false, content: 'hidden' }), undefined);
	assert.equal(displayedCustomText({ role: 'assistant', content: 'x' }), undefined);
	assert.equal(displayedCustomText({ role: 'custom', display: true, content: '  ' }), undefined);
});
