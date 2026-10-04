/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable daemon's wire client, run on its own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `durable-client.ts` carries no `vscode` import: the NDJSON framing, the request/response
 * matching and the bounded connect are the parts worth exercising, and none of them needs
 * an editor. The socket is faked with an `EventEmitter`, so no test touches a real pipe.
 */

import assert from 'assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { DaemonClient, DaemonUnavailableError, daemonEndpoint, LineStream } from '../src/durable-client.ts';

/** A socket the client can talk to without a daemon: writes are recorded for the test to read. */
function fakeSocket(): EventEmitter & { written: string[]; setEncoding(): void; write(chunk: string): boolean; end(): void; destroy(): void } {
	const socket = new EventEmitter() as EventEmitter & { written: string[]; setEncoding(): void; write(chunk: string): boolean; end(): void; destroy(): void };
	socket.written = [];
	socket.setEncoding = () => { };
	socket.write = (chunk: string) => { socket.written.push(chunk); return true; };
	socket.end = () => { };
	socket.destroy = () => { };
	return socket;
}

test('LineStream delivers one message per JSON line and drops unparseable ones', () => {
	const received: unknown[] = [];
	const socket = fakeSocket();
	new LineStream(socket as never, message => received.push(message));

	socket.emit('data', '{"a":1}\nnot json at all\n{"b":');
	socket.emit('data', '2}\n');

	assert.deepStrictEqual(received, [{ a: 1 }, { b: 2 }]);
});

test('LineStream.send writes exactly one line of JSON', () => {
	const socket = fakeSocket();
	const line = new LineStream(socket as never, () => { });

	line.send({ id: 7, method: 'ping' });

	assert.deepStrictEqual(socket.written, ['{"id":7,"method":"ping"}\n']);
	// After close, sends are dropped rather than written to a dead socket.
	line.close();
	line.send({ id: 8 });
	assert.deepStrictEqual(socket.written, ['{"id":7,"method":"ping"}\n']);
});

test('DaemonClient matches a response to its request id', async () => {
	const socket = fakeSocket();
	const client = new DaemonClient(socket as never);

	const pending = client.request('ping');
	assert.strictEqual(socket.written.length, 1);
	const sent = JSON.parse(socket.written[0]);
	assert.strictEqual(sent.method, 'ping');

	socket.emit('data', `${JSON.stringify({ id: sent.id, ok: true, result: { streams: 2 } })}\n`);

	assert.deepStrictEqual(await pending, { streams: 2 });
});

test('DaemonClient rejects with the daemon error and keeps working afterwards', async () => {
	const socket = fakeSocket();
	const client = new DaemonClient(socket as never);

	const failing = client.request('sessions');
	const sent = JSON.parse(socket.written[0]);
	socket.emit('data', `${JSON.stringify({ id: sent.id, ok: false, error: 'boom' })}\n`);
	await assert.rejects(failing, /boom/);

	const next = client.request('ping');
	const sent2 = JSON.parse(socket.written[1]);
	socket.emit('data', `${JSON.stringify({ id: sent2.id, ok: true, result: { protocol: 1 } })}\n`);
	assert.deepStrictEqual(await next, { protocol: 1 });
});

test('DaemonClient hands pushed events to its listeners', () => {
	const socket = fakeSocket();
	const client = new DaemonClient(socket as never);
	const events: unknown[] = [];
	client.onEvent(message => events.push(message));

	socket.emit('data', `${JSON.stringify({ event: 'events', conversationId: 3, events: [] })}\n`);

	assert.deepStrictEqual(events, [{ event: 'events', conversationId: 3, events: [] }]);
});

test('DaemonClient rejects pending requests when the daemon closes the connection', async () => {
	const socket = fakeSocket();
	const client = new DaemonClient(socket as never);

	const pending = client.request('ping');
	socket.emit('close');

	await assert.rejects(pending, /closed/);
	// After the close, every request is refused at once — never left hanging.
	await assert.rejects(client.request('ping'), /closed/);
});

test('daemonEndpoint is the local named pipe on Windows and a socket under the folder elsewhere', () => {
	if (process.platform === 'win32') {
		assert.strictEqual(daemonEndpoint('somewhere/durable'), '\\\\.\\pipe\\picode-durable-agent');
	} else {
		assert.strictEqual(daemonEndpoint('somewhere/durable').endsWith('.data/durable.sock'), true);
	}
});
