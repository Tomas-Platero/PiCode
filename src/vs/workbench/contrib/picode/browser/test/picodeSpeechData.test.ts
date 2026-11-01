/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How the chat reads what the connector's dictation answers, run on its own.
 *
 * What matters: phrases with words come through trimmed and in order, anything else is dropped
 * instead of raising an error mid-sentence, and a start that did not work carries the reason and
 * whether a download would fix it.
 */

import assert from 'assert';
import { test } from 'node:test';
import { readListenAnswer, readPollAnswer, revealStep } from '../picodeSpeechData.js';

test('phrases come through trimmed and in order', () => {
	const answer = readPollAnswer({ events: [{ kind: 'partial', text: ' hola ' }, { kind: 'final', text: 'hola mundo' }], active: true, level: 0 });
	assert.deepStrictEqual(answer, { phrases: [{ kind: 'partial', text: 'hola' }, { kind: 'final', text: 'hola mundo' }], active: true, level: 0 });
});

test('empty, unknown or malformed entries are dropped', () => {
	const answer = readPollAnswer({ events: [{ kind: 'partial', text: '   ' }, { kind: 'limit' }, { kind: 'final' }, null, 3, { kind: 'final', text: 'ok' }], active: true, level: 0 });
	assert.deepStrictEqual(answer.phrases, [{ kind: 'final', text: 'ok' }]);
});

test('an answer that is not an answer means the recording is over', () => {
	assert.deepStrictEqual(readPollAnswer(undefined), { phrases: [], active: false, level: 0 });
	assert.deepStrictEqual(readPollAnswer({ events: 'x' }), { phrases: [], active: false, level: 0 });
});

test('a start that failed carries the reason and whether a download would fix it', () => {
	assert.deepStrictEqual(readListenAnswer({ ok: true }), { ok: true });
	assert.deepStrictEqual(readListenAnswer({ ok: false, message: 'No microphone was found.' }), { ok: false, message: 'No microphone was found.' });
	assert.deepStrictEqual(readListenAnswer({ ok: false, needsDownload: true }), { ok: false, needsDownload: true });
	assert.equal(readListenAnswer(undefined).ok, false);
});

test('the microphone level is kept between 0 and 1 and is 0 when it is missing or not a number', () => {
	assert.equal(readPollAnswer({ events: [], active: true, level: 0.4 }).level, 0.4);
	assert.equal(readPollAnswer({ events: [], active: true, level: 7 }).level, 1);
	assert.equal(readPollAnswer({ events: [], active: true, level: -1 }).level, 0);
	assert.equal(readPollAnswer({ events: [], active: true, level: 'loud' }).level, 0);
	assert.equal(readPollAnswer({ events: [], active: true }).level, 0);
});

test('words appear one at a time, and in bigger steps when far behind', () => {
	assert.deepStrictEqual(revealStep([], ['a', 'b', 'c']), ['a']);
	assert.deepStrictEqual(revealStep(['a'], ['a', 'b', 'c']), ['a', 'b']);
	assert.deepStrictEqual(revealStep([], ['1', '2', '3', '4', '5', '6', '7', '8']), ['1', '2']);
	assert.deepStrictEqual(revealStep(['a', 'b', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('a revised word is swapped in place and the text never shrinks', () => {
	assert.deepStrictEqual(revealStep(['the', 'dictate', 'easy'], ['the', 'dictation', 'system', 'works']), ['the', 'dictation', 'system']);
	assert.deepStrictEqual(revealStep(['a', 'b', 'c'], ['a', 'x']), ['a', 'x']);
});
