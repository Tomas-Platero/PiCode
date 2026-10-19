/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the editor adds to a prompt, as a pure function.
 *
 * `context.ts` imports nothing relative (no `vscode`), so `node --test` runs it directly: the
 * checks below are the block the durable turn and the in-process chat both prepend, and the
 * frame the transcript replay strips back out (`durable-sessions.ts`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFrame, contextBlock, withContext } from '../src/context.ts';

test('nothing to say means no block, not an empty header', () => {
	assert.equal(contextBlock({}), undefined);
	assert.equal(contextBlock({ folder: '', file: '' }), undefined);
});

test('the folder, the open file and the selection are written for the agent', () => {
	const block = contextBlock({
		folder: 'D:\\repos\\app',
		file: 'D:\\repos\\app\\src\\a.ts',
		selection: { text: 'const a = 1;', lines: 1 },
	});
	assert.match(block ?? '', /Workspace: D:\\repos\\app/);
	assert.match(block ?? '', /File the owner has open: D:\\repos\\app\\src\\a\.ts/);
	assert.match(block ?? '', /Selected in it \(1 line\(s\), capped\):/);
	assert.match(block ?? '', /const a = 1;/);
});

test('an empty selection is not a selection', () => {
	assert.equal(contextBlock({ file: 'a.ts', selection: { text: '   \n', lines: 2 } })?.includes('Selected'), false);
});

test('the problems travel with their severity and their line', () => {
	const block = contextBlock({
		file: 'a.ts',
		diagnostics: [
			{ severity: 'error', line: 12, message: 'Cannot find name "x".' },
			{ severity: 'warning', line: 3, message: '"y" is declared but never read.' },
		],
	});
	assert.match(block ?? '', /Problems in it \(2, capped\):/);
	assert.match(block ?? '', /- error at line 12: Cannot find name "x"\./);
	assert.match(block ?? '', /- warning at line 3: "y" is declared but never read\./);
});

test('an attachment with text carries it; one without still says what was attached', () => {
	const block = contextBlock({
		attachments: [
			{ label: 'vscode.file', text: 'src/a.ts' },
			{ label: 'vscode.problems' },
		],
	});
	assert.match(block ?? '', /- Attached by the owner: vscode\.file\n```\nsrc\/a\.ts\n```/);
	assert.match(block ?? '', /- Attached by the owner: vscode\.problems/);
});

test('a huge selection is capped, because a whole file in every prompt is a bill', () => {
	const block = contextBlock({ selection: { text: 'x'.repeat(9000), lines: 1 } }) ?? '';
	assert.equal(block.includes('x'.repeat(8000)), true);
	assert.equal(block.includes('x'.repeat(8001)), false);
});

test('withContext puts the frame first and the request last', () => {
	const prompt = withContext('fix this', contextBlock({ file: 'a.ts' }), 'internal');
	assert.match(prompt, /^You are pi, the coding agent that runs inside the PiCode editor\./);
	assert.match(prompt, /Context from the editor, as it is right now:/);
	assert.equal(prompt.endsWith('\n\n---\n\nfix this'), true);
});

test('withContext without a context still frames the agent, and the frame names where it runs', () => {
	const prompt = withContext('hola', undefined, 'external');
	assert.match(prompt, /answering through the PiCode editor/);
	assert.equal(prompt.includes('Context from the editor'), false);
	assert.equal(prompt.endsWith('\n\n---\n\nhola'), true);
	assert.match(agentFrame('internal'), /runs inside the PiCode editor/);
	assert.match(agentFrame('external'), /the machine's own coding agent/);
});
