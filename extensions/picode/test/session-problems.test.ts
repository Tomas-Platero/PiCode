/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What pi found wrong while building a session, said once in the chat.
 *
 * pi 1.6 stopped printing these itself for a host that embeds it: an extension that did not load,
 * a model it could not restore, an `enabledModels` pattern that matches nothing. The model fallback
 * line is pi's own wording ("Could not restore model <provider>/<model>. Using <fallback>").
 */

import * as assert from 'assert';
import { test } from 'node:test';
import { sessionProblems, unseenProblems } from '../src/session-problems.ts';

test('warnings, errors, failed extensions and the model fallback become problems; info does not', () => {
	const problems = sessionProblems({
		diagnostics: [
			{ type: 'info', message: 'Loaded 3 providers' },
			{ type: 'warning', message: 'No models match pattern "github-copilot/nope"' },
			{ type: 'error', message: 'Provider "acme" failed to register' },
		],
		extensionErrors: [{ path: 'C:/profile/extensions/broken/index.ts', error: 'Cannot find module "yaml"' }],
		modelFallbackMessage: 'Could not restore model anthropic/claude-x. Using openai/gpt-6.2-sol',
	});
	assert.deepStrictEqual(problems.map(p => p.kind), ['warning', 'error', 'extension', 'model']);
	assert.strictEqual(problems[2].text.includes('broken'), true);
	assert.strictEqual(problems[2].text.includes('C:/profile'), false, 'no paths on screen');
	assert.strictEqual(problems[3].text, 'Could not restore model anthropic/claude-x. Using openai/gpt-6.2-sol');
});

test('nothing wrong, nothing said', () => {
	assert.deepStrictEqual(sessionProblems({ diagnostics: [], extensionErrors: [] }), []);
	assert.deepStrictEqual(sessionProblems({ diagnostics: undefined, extensionErrors: undefined, modelFallbackMessage: '  ' }), []);
});

test('a problem already said in this window is not said again', () => {
	const seen = new Set<string>();
	const first = sessionProblems({ diagnostics: [{ type: 'warning', message: 'A' }], extensionErrors: [] });
	assert.strictEqual(unseenProblems(first, seen).length, 1);
	assert.strictEqual(unseenProblems(first, seen).length, 0);
	const second = sessionProblems({ diagnostics: [{ type: 'warning', message: 'A' }, { type: 'warning', message: 'B' }], extensionErrors: [] });
	assert.deepStrictEqual(unseenProblems(second, seen).map(p => p.text), ['B']);
});
