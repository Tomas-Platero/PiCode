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
import { readListenAnswer, readPollAnswer } from '../picodeSpeechData.js';

test('phrases come through trimmed and in order', () => {
	const answer = readPollAnswer({ events: [{ kind: 'partial', text: ' hola ' }, { kind: 'final', text: 'hola mundo' }], active: true });
	assert.deepStrictEqual(answer, { phrases: [{ kind: 'partial', text: 'hola' }, { kind: 'final', text: 'hola mundo' }], active: true });
});

test('empty, unknown or malformed entries are dropped', () => {
	const answer = readPollAnswer({ events: [{ kind: 'partial', text: '   ' }, { kind: 'limit' }, { kind: 'final' }, null, 3, { kind: 'final', text: 'ok' }], active: true });
	assert.deepStrictEqual(answer.phrases, [{ kind: 'final', text: 'ok' }]);
});

test('an answer that is not an answer means the recording is over', () => {
	assert.deepStrictEqual(readPollAnswer(undefined), { phrases: [], active: false });
	assert.deepStrictEqual(readPollAnswer({ events: 'x' }), { phrases: [], active: false });
});

test('a start that failed carries the reason and whether a download would fix it', () => {
	assert.deepStrictEqual(readListenAnswer({ ok: true }), { ok: true });
	assert.deepStrictEqual(readListenAnswer({ ok: false, message: 'No microphone was found.' }), { ok: false, message: 'No microphone was found.' });
	assert.deepStrictEqual(readListenAnswer({ ok: false, needsDownload: true }), { ok: false, needsDownload: true });
	assert.equal(readListenAnswer(undefined).ok, false);
});
