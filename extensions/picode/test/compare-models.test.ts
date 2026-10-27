/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import { compareModels, durationLabel, renderComparison } from '../src/compare-models.ts';

test('every model answers, and one failing does not stop the others', async () => {
	const answers = await compareModels(['a/fast', 'b/broken', 'c/empty'], async model => {
		if (model === 'b/broken') {
			throw new Error('No API key found');
		}
		return model === 'c/empty' ? '   ' : 'Use a map.';
	}, new AbortController().signal);
	assert.strictEqual(answers[0].text, 'Use a map.');
	assert.strictEqual(answers[1].problem, 'No API key found');
	assert.strictEqual(answers[2].problem, 'It did not answer.');
});

test('a stopped comparison says the models were stopped, not that they broke', async () => {
	const controller = new AbortController();
	const pending = compareModels(['a/x'], async (_model, signal) => new Promise<string>((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(new Error('aborted')));
	}), controller.signal);
	controller.abort();
	assert.strictEqual((await pending)[0].problem, 'Stopped before it answered.');
});

test('the document lists the fastest answer first and keeps the failures last', () => {
	const text = renderComparison('Which is better?', [
		{ model: 'slow/m', text: 'Slow answer', durationMs: 9000 },
		{ model: 'bad/m', text: '', durationMs: 100, problem: 'No API key found' },
		{ model: 'fast/m', text: 'Fast answer', durationMs: 1200 },
	]);
	assert.ok(text.indexOf('## fast/m') < text.indexOf('## slow/m'));
	assert.ok(text.indexOf('## slow/m') < text.indexOf('## bad/m'));
	assert.ok(text.includes('⚠️ No API key found'));
	assert.strictEqual(durationLabel(65_000), '1m 05s');
});
