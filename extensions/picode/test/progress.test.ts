/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License. See License.txt
 *--------------------------------------------------------------------------------------------*/

/**
 * The tool card's two texts, run on their own.
 *
 * What matters: a call's arguments read as readable JSON whether they arrived parsed or
 * serialised, a tool's answer is its text parts rather than an object dump, nothing is dropped
 * silently, and a long call or output is cut with a note instead of filling the chat.
 */

import assert from 'assert';
import { test } from 'node:test';
import { toolInputText, toolOutputText, toolProgress } from '../src/progress.ts';

test('the progress line names the work, and the bare tool when there is nothing to name', () => {
	assert.strictEqual(toolProgress('read', { path: 'src/app.ts' }), 'read src/app.ts');
	assert.strictEqual(toolProgress('bash', { command: 'npm test' }), 'bash npm test');
	assert.strictEqual(toolProgress('mystery', { anything: 1 }), 'mystery');
	assert.strictEqual(toolProgress('read', undefined), 'read');
});

test('arguments that arrive as an object are shown as readable JSON', () => {
	assert.strictEqual(
		toolInputText({ path: 'src/app.ts', limit: 20 }),
		JSON.stringify({ path: 'src/app.ts', limit: 20 }, null, 2),
	);
});

test('arguments that crossed a boundary are printed rather than left as one long line', () => {
	assert.strictEqual(
		toolInputText('{"path":"src/app.ts"}'),
		JSON.stringify({ path: 'src/app.ts' }, null, 2),
	);
});

test('a string that is not JSON is kept as it arrived', () => {
	assert.strictEqual(toolInputText('not json'), 'not json');
});

test('no arguments is an empty block, not the word undefined', () => {
	assert.strictEqual(toolInputText(undefined), '');
	assert.strictEqual(toolInputText(null), '');
	assert.strictEqual(toolOutputText(undefined), '');
});

test('a tool answer is the text of its content parts', () => {
	assert.strictEqual(
		toolOutputText({ content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }),
		'first\nsecond',
	);
});

test('the editor tools answer in value parts, and those are read too', () => {
	assert.strictEqual(toolOutputText({ content: [{ value: 'edited' }] }), 'edited');
});

test('a part that is not text is written out instead of being dropped', () => {
	assert.strictEqual(toolOutputText({ content: [{ type: 'image', data: 'abc' }] }), '{"type":"image","data":"abc"}');
});

test('an answer with no content parts is written out whole', () => {
	assert.strictEqual(toolOutputText({ ok: true }), JSON.stringify({ ok: true }, null, 2));
});

test('a long call and a long answer are cut, saying how much was left out', () => {
	const longInput = toolInputText({ path: 'x'.repeat(5000) });
	const longOutput = toolOutputText('y'.repeat(9000));

	assert.ok(longInput.length < 5000, 'the call is capped');
	assert.ok(longInput.includes('more characters'), 'the call says where it was cut');
	assert.ok(longOutput.length < 9000, 'the answer is capped');
	assert.ok(longOutput.includes('more characters'), 'the answer says where it was cut');
});
