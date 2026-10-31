/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's side of a dictation, with a worker that is only a script of replies.
 *
 * What matters: the model is loaded once and reused; phrases reach the listener as they come; a
 * failure comes back as a message and leaves the session ready to try again; the time limit ends
 * the session by itself; a worker that dies is replaced on the next press; and the worker is let
 * go after a quiet while.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceSession, type SessionEvent, type WorkerChannel } from '../src/voice-session.ts';

class FakeWorker implements WorkerChannel {
	sent: Record<string, unknown>[] = [];
	killed = false;
	private messageListener: (m: Record<string, unknown>) => void = () => undefined;
	private exitListener: () => void = () => undefined;
	/** What the worker answers to each message type. */
	replies: Record<string, Record<string, unknown> | undefined> = {
		init: { type: 'ready' },
		start: { type: 'listening' },
		stop: { type: 'stopped' },
	};
	send(message: Record<string, unknown>): void {
		this.sent.push(message);
		const reply = this.replies[String(message['type'])];
		if (reply !== undefined) {
			queueMicrotask(() => this.messageListener(reply));
		}
	}
	onMessage(listener: (m: Record<string, unknown>) => void): void { this.messageListener = listener; }
	onExit(listener: () => void): void { this.exitListener = listener; }
	kill(): void { this.killed = true; }
	emit(message: Record<string, unknown>): void { this.messageListener(message); }
	die(): void { this.exitListener(); }
}

function setup(idleMs?: number) {
	const workers: FakeWorker[] = [];
	const events: SessionEvent[] = [];
	const session = new VoiceSession(() => { const w = new FakeWorker(); workers.push(w); return w; }, 'voice-dir', e => events.push(e), idleMs);
	return { session, workers, events };
}

test('a dictation loads the model once, listens, and stops', async () => {
	const { session, workers } = setup();
	await session.start();
	assert.equal(session.state, 'listening');
	assert.deepEqual(workers[0].sent.map(m => m['type']), ['init', 'start']);
	assert.equal(workers[0].sent[0]['dir'], 'voice-dir');

	await session.stop();
	assert.equal(session.state, 'idle');

	await session.start();
	assert.equal(workers.length, 1);
	assert.deepEqual(workers[0].sent.map(m => m['type']), ['init', 'start', 'stop', 'start']);
	session.dispose();
});

test('phrases reach the listener as they are spoken, and the last one before stop is not lost', async () => {
	const { session, workers, events } = setup();
	await session.start();
	workers[0].emit({ type: 'partial', text: 'hel' });
	workers[0].emit({ type: 'partial', text: 'hello wor' });
	workers[0].emit({ type: 'final', text: 'hello world' });

	workers[0].replies['stop'] = undefined;
	const stopping = session.stop();
	workers[0].emit({ type: 'final', text: 'and more' });
	workers[0].emit({ type: 'stopped' });
	await stopping;

	assert.deepEqual(events, [
		{ kind: 'partial', text: 'hel' },
		{ kind: 'partial', text: 'hello wor' },
		{ kind: 'final', text: 'hello world' },
		{ kind: 'final', text: 'and more' },
	]);
});

test('stopping when nothing is recording is harmless', async () => {
	const { session } = setup();
	await session.stop();
	assert.equal(session.state, 'idle');
});

test('a second press while running is refused', async () => {
	const { session } = setup();
	await session.start();
	await assert.rejects(session.start(), /already running/);
	session.dispose();
});

test('a failure comes back as words and leaves the session ready to try again', async () => {
	const { session, workers } = setup();
	const first = session.start();
	workers[0].replies['start'] = { type: 'error', message: 'No microphone was found.' };
	await assert.rejects(first, /No microphone/);
	assert.equal(session.state, 'idle');

	workers[0].replies['start'] = { type: 'listening' };
	await session.start();
	assert.equal(session.state, 'listening');
	session.dispose();
});

test('at the time limit the listener hears it and the session stops itself', async () => {
	const { session, workers, events } = setup();
	await session.start();
	workers[0].emit({ type: 'limit' });
	await new Promise(r => setTimeout(r, 5));
	assert.deepEqual(events, [{ kind: 'limit' }]);
	assert.equal(session.state, 'idle');
	assert.equal(workers[0].sent.at(-1)?.['type'], 'stop');
});

test('a worker that dies is replaced on the next press', async () => {
	const { session, workers } = setup();
	await session.start();
	workers[0].die();
	assert.equal(session.state, 'idle');
	assert.equal(workers[0].killed, true);

	await session.start();
	assert.equal(workers.length, 2);
	assert.deepEqual(workers[1].sent.map(m => m['type']), ['init', 'start']);
	session.dispose();
});

test('a worker that dies while the model loads rejects the press', async () => {
	const { session, workers } = setup();
	const pending = session.start();
	workers[0].replies['init'] = undefined;
	workers[0].die();
	await assert.rejects(pending, /stopped unexpectedly|ready/);
	assert.equal(session.state, 'idle');
});

test('after a quiet while the worker and its memory are let go', async () => {
	const { session, workers } = setup(20);
	await session.start();
	await session.stop();
	await new Promise(r => setTimeout(r, 60));
	assert.equal(workers[0].killed, true);
});

test('the loudness the worker reports reaches the listener as it comes', async () => {
	const { session, workers, events } = setup();
	await session.start();
	workers[0].emit({ type: 'level', value: 0.5 });
	workers[0].emit({ type: 'level', value: 'x' });
	assert.deepEqual(events, [{ kind: 'level', value: 0.5 }, { kind: 'level', value: 0 }]);
});
