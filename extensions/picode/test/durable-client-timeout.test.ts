/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The wire client's deadline: a daemon that accepts the socket and then goes quiet must not leave
 * a request pending forever.
 *
 * This is not hypothetical. `durable-client.ts` bounded `connect` but not `request`, and the Tasks
 * block sets a `reading` flag before awaiting `readDurableStatus()`; one unanswered request left
 * that flag set, so every later refresh returned early and the block froze on its last frame — a
 * conversation that had finished kept reading "running" while the transcript tab said `done`.
 *
 * The tests below use a real socket (a named pipe on Windows, a socket in the temp dir elsewhere)
 * because that is where the hang lived: a fake client would have passed while the real one hung.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DaemonClient } from '../src/durable-client.ts';

/** A unique endpoint per test, so two runs cannot collide. */
function endpointFor(label: string): string {
	const unique = `${process.pid}-${label}-${Math.random().toString(36).slice(2, 8)}`;
	return process.platform === 'win32'
		? `\\\\.\\pipe\\picode-test-${unique}`
		: join(tmpdir(), `picode-test-${unique}.sock`);
}

interface Fixture {
	readonly endpoint: string;
	readonly answers: number;
	close(): Promise<void>;
}

/**
 * A server that answers the Nth request and onwards, and stays silent before that.
 *
 * With `answers = 2` the first request is swallowed — the exact shape of a daemon that is alive
 * (the socket accepts) but not answering.
 */
async function serve(endpoint: string, options: { answers: number }): Promise<Fixture> {
	let received = 0;
	const server = net.createServer(socket => {
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim().length === 0) {
					continue;
				}
				const request = JSON.parse(line) as { id: number };
				received++;
				if (received < options.answers) {
					continue; // swallowed: no answer, the socket stays open
				}
				socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { answered: received } })}\n`);
			}
		});
		socket.on('error', () => { });
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(endpoint, () => resolve());
	});
	return {
		endpoint,
		get answers() { return received; },
		close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
	};
}

test('a request that is never answered rejects at its deadline instead of hanging', async () => {
	const fixture = await serve(endpointFor('silent'), { answers: Number.POSITIVE_INFINITY });
	const client = await DaemonClient.connect(fixture.endpoint, 2000);
	try {
		const started = Date.now();
		await assert.rejects(
			client.request('sessions', {}, 150),
			/the durable daemon did not answer "sessions" within 150 ms/,
		);
		assert.ok(Date.now() - started < 1500, 'the deadline was not the one asked for');
		assert.equal(fixture.answers, 1, 'the request did reach the socket');
	} finally {
		client.close();
		await fixture.close();
	}
});

test('a swallowed request does not block the next one, so the refresh keeps moving', async () => {
	// The daemon accepts and stays quiet for the first request, then answers.
	const fixture = await serve(endpointFor('after-timeout'), { answers: 2 });
	const client = await DaemonClient.connect(fixture.endpoint, 2000);
	try {
		await assert.rejects(client.request('ping', {}, 120), /did not answer "ping"/);

		// The same client: the deadline removed its own pending entry, so this is a normal request.
		const answer = await client.request('ping', {}, 2000) as { answered: number };
		assert.equal(answer.answered, 2);
	} finally {
		client.close();
		await fixture.close();
	}
});

test('an answer that arrives in time resolves, and no deadline fires afterwards', async () => {
	const fixture = await serve(endpointFor('prompt'), { answers: 1 });
	const client = await DaemonClient.connect(fixture.endpoint, 2000);
	try {
		const answer = await client.request('ping', {}, 400) as { answered: number };
		assert.equal(answer.answered, 1);
		// Past the (already cancelled) deadline: a leaked timer would reject an unhandled promise.
		await new Promise(resolve => setTimeout(resolve, 500));
	} finally {
		client.close();
		await fixture.close();
	}
});
