/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License. See License.txt
 *--------------------------------------------------------------------------------------------*/

/**
 * The disabled-tools reading, run on its own.
 *
 * What matters: a name that is not a non-empty string is a typo and is dropped rather than
 * passed to pi (an `excludeTools` entry pi cannot match is a tool the owner thinks is off
 * and is not), duplicates collapse, and anything that is not a list reads as "nothing
 * excluded" — the default the product ships with.
 */

import assert from 'assert';
import { test } from 'node:test';
import { disabledToolsOf, readPiChatSettings } from '../src/piConfig.ts';

test('a proper list of names is trimmed, deduplicated and ordered', () => {
	assert.deepStrictEqual(
		disabledToolsOf(['bash', ' write ', 'bash', 'mcp_github']),
		['bash', 'mcp_github', 'write'],
	);
});

test('a typo is not a tool: empty and non-string entries are dropped', () => {
	assert.deepStrictEqual(disabledToolsOf(['', '   ', 42, null, 'edit']), ['edit']);
});

test('anything that is not a list reads as nothing excluded', () => {
	assert.deepStrictEqual(disabledToolsOf(undefined), []);
	assert.deepStrictEqual(disabledToolsOf('bash'), []);
	assert.deepStrictEqual(disabledToolsOf({ tools: ['bash'] }), []);
});

test('the settings reader carries the list through', () => {
	const settings = readPiChatSettings(key => key === 'pi.disabledTools' ? ['bash'] : undefined);

	assert.deepStrictEqual(settings.disabledTools, ['bash']);
});

test('the settings reader defaults to nothing excluded', () => {
	const settings = readPiChatSettings(() => undefined);

	assert.deepStrictEqual(settings.disabledTools, []);
});
