/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * From microphone samples to words, with a fake microphone and a fake recogniser.
 *
 * What matters: stereo is averaged to mono; the recording stops by itself at the time limit and
 * keeps exactly the audio up to it; a click too short to hold a word is not transcribed; a second
 * stop is harmless; and a microphone that failed is reported, not turned into empty text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dictation, mixToMono, type VoiceInput, type VoiceRecognizer } from '../src/voice-engine.ts';

const RATE = 1000;

function fakeInput() {
	let push!: (s: Float32Array) => void;
	let fail!: (e: Error) => void;
	let stopped = 0;
	const input: VoiceInput = {
		sampleRate: RATE,
		start: (onSamples, onError) => { push = onSamples; fail = onError; },
		stop: () => { stopped++; },
	};
	return { input, push: (s: Float32Array) => push(s), fail: (e: Error) => fail(e), stopped: () => stopped };
}

function recognizer() {
	const heard: number[] = [];
	const r: VoiceRecognizer = { transcribe: (samples) => { heard.push(samples.length); return ` hello ${samples.length} `; } };
	return { r, heard };
}

test('stereo is averaged into one channel, in a new array', () => {
	const stereo = new Float32Array([1, 0, 0.5, 0.5, 0, 1]);
	assert.deepEqual([...mixToMono(stereo, 2)], [0.5, 0.5, 0.5]);

	const mono = new Float32Array([0.1, 0.2]);
	const copy = mixToMono(mono, 1);
	assert.deepEqual([...copy], [...mono]);
	assert.notEqual(copy, mono);
});

test('what was recorded is transcribed on stop, trimmed', () => {
	const mic = fakeInput();
	const { r, heard } = recognizer();
	const d = new Dictation(() => mic.input, r, () => assert.fail('no limit expected'));
	d.start();
	mic.push(new Float32Array(500));
	mic.push(new Float32Array(500));
	const result = d.stop();
	assert.equal(result.text, 'hello 1000');
	assert.equal(result.seconds, 1);
	assert.equal(result.cutOff, false);
	assert.deepEqual(heard, [1000]);
	assert.equal(mic.stopped(), 1);
});

test('at the time limit it says so once and keeps exactly the audio up to it', () => {
	const mic = fakeInput();
	const { r, heard } = recognizer();
	let limits = 0;
	const d = new Dictation(() => mic.input, r, () => { limits++; }, 2);
	d.start();
	mic.push(new Float32Array(1500));
	assert.equal(limits, 0);
	mic.push(new Float32Array(1500));
	mic.push(new Float32Array(1500));
	assert.equal(limits, 1);
	const result = d.stop();
	assert.deepEqual(heard, [2000]);
	assert.equal(result.cutOff, true);
	assert.equal(result.seconds, 2);
});

test('a click too short to hold a word is not transcribed', () => {
	const mic = fakeInput();
	const { r, heard } = recognizer();
	const d = new Dictation(() => mic.input, r, () => undefined);
	d.start();
	mic.push(new Float32Array(100));
	assert.equal(d.stop().text, '');
	assert.deepEqual(heard, []);
});

test('stopping twice, or before starting, is harmless', () => {
	const mic = fakeInput();
	const { r } = recognizer();
	const d = new Dictation(() => mic.input, r, () => undefined);
	assert.equal(d.stop().text, '');
	d.start();
	mic.push(new Float32Array(1000));
	d.stop();
	assert.equal(d.stop().text, '');
	assert.equal(mic.stopped(), 1);
});

test('starting while already listening is refused', () => {
	const mic = fakeInput();
	const d = new Dictation(() => mic.input, recognizer().r, () => undefined);
	d.start();
	assert.throws(() => d.start(), /Already listening/);
});

test('samples that arrive after stop are ignored', () => {
	const mic = fakeInput();
	const { r, heard } = recognizer();
	const d = new Dictation(() => mic.input, r, () => undefined);
	d.start();
	mic.push(new Float32Array(1000));
	d.stop();
	mic.push(new Float32Array(1000));
	d.start();
	assert.equal(d.stop().text, '');
	assert.deepEqual(heard, [1000]);
});

test('a microphone that failed is reported, not turned into empty text', () => {
	const mic = fakeInput();
	const d = new Dictation(() => mic.input, recognizer().r, () => undefined);
	d.start();
	mic.fail(new Error('device lost'));
	assert.throws(() => d.stop(), /device lost/);
});
