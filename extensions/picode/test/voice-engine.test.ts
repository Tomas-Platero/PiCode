/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * From microphone samples to phrases, with a fake microphone and a fake recogniser.
 *
 * What matters: stereo is averaged to mono; speech is told from silence and cut into phrases at a
 * pause; the phrase so far is offered while it is spoken and a last time when it ends; a click too
 * short to hold a word says nothing; stopping closes the phrase still open; the whole dictation
 * stops at the time limit; and a microphone that failed is reported, not turned into silence.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveDictation, mixToMono, type LiveHandlers, type VoiceInput, type VoiceRecognizer } from '../src/voice-engine.ts';

const RATE = 1000; // one 0.1 s window is 100 samples
const SPEECH = 0.5;
const QUIET = 0.001;

const tone = (windows: number, level: number) => new Float32Array(windows * 100).fill(level);

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

function setup(options: ConstructorParameters<typeof LiveDictation>[3] = {}) {
	const mic = fakeInput();
	const log: string[] = [];
	const lengths: number[] = [];
	const recognizer: VoiceRecognizer = { transcribe: samples => { lengths.push(samples.length); return ` w${samples.length} `; } };
	const handlers: LiveHandlers = {
		onPartial: t => log.push(`partial:${t}`),
		onFinal: t => log.push(`final:${t}`),
		onLimit: () => log.push('limit'),
	};
	// The scenarios below are written against a 1.2 s partial and a 0.8 s pause; the real defaults are faster.
	const live = new LiveDictation(() => mic.input, recognizer, handlers, { partialEverySeconds: 1.2, endSilenceSeconds: 0.8, ...options });
	return { mic, log, lengths, live };
}

test('stereo is averaged into one channel, in a new array', () => {
	const stereo = new Float32Array([1, 0, 0.5, 0.5, 0, 1]);
	assert.deepEqual([...mixToMono(stereo, 2)], [0.5, 0.5, 0.5]);

	const mono = new Float32Array([0.1, 0.2]);
	const copy = mixToMono(mono, 1);
	assert.deepEqual([...copy], [...mono]);
	assert.notEqual(copy, mono);
});

test('a phrase is offered as it grows and closed at the pause, with a short lead-in kept', () => {
	const { mic, log, live } = setup();
	live.start();
	mic.push(tone(5, QUIET));
	mic.push(tone(15, SPEECH));
	// 15 speech windows with partials every 1.2 s: one at 12 windows after the start of speech
	assert.equal(log.filter(l => l.startsWith('partial')).length, 1);
	mic.push(tone(8, QUIET));
	assert.deepEqual(log.filter(l => l.startsWith('final')), ['final:w' + (3 + 15 + 8) * 100]);
	live.stop();
});

test('quiet before the first word is not part of the phrase beyond a short lead-in', () => {
	const { mic, lengths, live } = setup();
	live.start();
	mic.push(tone(20, QUIET));
	mic.push(tone(5, SPEECH));
	mic.push(tone(8, QUIET));
	assert.equal(lengths.at(-1), (3 + 5 + 8) * 100);
});

test('two phrases separated by a pause come out as two finals', () => {
	const { mic, log, live } = setup();
	live.start();
	mic.push(tone(4, SPEECH));
	mic.push(tone(9, QUIET));
	mic.push(tone(4, SPEECH));
	mic.push(tone(9, QUIET));
	assert.equal(log.filter(l => l.startsWith('final')).length, 2);
});

test('a click too short to hold a word says nothing', () => {
	const { mic, log, lengths, live } = setup();
	live.start();
	mic.push(tone(2, SPEECH));
	mic.push(tone(10, QUIET));
	live.stop();
	assert.deepEqual(log, []);
	assert.deepEqual(lengths, []);
});

test('stopping closes the phrase still open', () => {
	const { mic, log, live } = setup();
	live.start();
	mic.push(tone(5, SPEECH));
	assert.deepEqual(log, []);
	live.stop();
	assert.deepEqual(log, ['final:w500']);
	assert.equal(mic.stopped(), 1);
});

test('stopping twice, or before starting, is harmless', () => {
	const { mic, live } = setup();
	live.stop();
	live.start();
	live.stop();
	live.stop();
	assert.equal(mic.stopped(), 1);
});

test('starting while already listening is refused', () => {
	const { live } = setup();
	live.start();
	assert.throws(() => live.start(), /Already listening/);
});

test('samples that arrive after stop are ignored', () => {
	const { mic, log, live } = setup();
	live.start();
	live.stop();
	mic.push(tone(10, SPEECH));
	assert.deepEqual(log, []);
});

test('samples that arrive in odd sizes are cut into the same windows', () => {
	const { mic, log, live } = setup();
	live.start();
	const speech = tone(5, SPEECH);
	for (let i = 0; i < speech.length; i += 37) {
		mic.push(speech.slice(i, i + 37));
	}
	mic.push(tone(9, QUIET));
	assert.equal(log.filter(l => l.startsWith('final')).length, 1);
});

test('at the time limit the open phrase is closed, the limit is announced once, and audio stops being taken', () => {
	const { mic, log, live } = setup({ maxSeconds: 2 });
	live.start();
	mic.push(tone(15, SPEECH));
	mic.push(tone(15, SPEECH));
	mic.push(tone(15, SPEECH));
	assert.equal(log.filter(l => l === 'limit').length, 1);
	assert.equal(log.at(-1), 'limit');
	assert.ok(log.some(l => l.startsWith('final')));
	live.stop();
});

test('a phrase that never pauses is closed at its own length limit', () => {
	const { mic, log, live } = setup({ maxPhraseSeconds: 2 });
	live.start();
	mic.push(tone(30, SPEECH));
	assert.ok(log.filter(l => l.startsWith('final')).length >= 1);
});

test('a microphone that failed is reported, not turned into silence', () => {
	const { mic, live } = setup();
	live.start();
	mic.fail(new Error('device lost'));
	assert.throws(() => live.stop(), /device lost/);
});

test('the meter follows how loud each tenth of a second is, and is 0 for digital silence', () => {
	const levels: number[] = [];
	const mic = fakeInput();
	const live = new LiveDictation(() => mic.input, { transcribe: () => '' }, { onPartial: () => undefined, onFinal: () => undefined, onLimit: () => undefined, onLevel: l => levels.push(l) });
	live.start();
	mic.push(tone(1, 0));
	mic.push(tone(1, QUIET));
	mic.push(tone(1, SPEECH));
	live.stop();
	assert.equal(levels.length, 3);
	assert.equal(levels[0], 0);
	assert.ok(levels[1] > 0 && levels[1] < levels[2], 'a louder window reads higher');
	assert.equal(levels[2], 1);
});

test('by default the phrase so far is offered every 0.4 s, so words keep arriving', () => {
	const mic = fakeInput();
	const log: string[] = [];
	const live = new LiveDictation(() => mic.input, { transcribe: s => `w${s.length}` }, { onPartial: t => log.push(t), onFinal: () => undefined, onLimit: () => undefined });
	live.start();
	mic.push(tone(13, SPEECH));
	// speech starts on window 1, a partial every 4 windows after it
	assert.equal(log.length, 3);
});

test('a slow recogniser is given room: the next partial waits a few times what the last one took', () => {
	const mic = fakeInput();
	const log: string[] = [];
	let now = 0;
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const live = new LiveDictation(() => mic.input, { transcribe: s => { now += 1000; return `w${s.length}`; } }, { onPartial: t => log.push(t), onFinal: () => undefined, onLimit: () => undefined });
		live.start();
		mic.push(tone(40, SPEECH));
		// a 1 s decode means waiting 3 s (30 windows) before the next one
		assert.equal(log.length, 2);
	} finally {
		Date.now = realNow;
	}
});
