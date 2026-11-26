/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { LocalPipeServer } from '../picodeAgentBridgePipe.js';
import { MAX_LINE_BYTES } from '../picodeAgentBridgeProtocol.js';

/**
 * The pipe answers on this computer and refuses every client that arrives over the network.
 * `\\localhost` and `\\<computer>` go through the network redirector exactly as a client on
 * another computer does, which is what `PIPE_REJECT_REMOTE_CLIENTS` refuses. A pipe Node creates
 * on its own accepts both (measured 2026-11-26), which is why the helper exists.
 */
(process.platform === 'win32' ? suite : suite.skip)('PiCode agent bridge: local pipe', function () {

	this.timeout(60_000);

	let server: LocalPipeServer | undefined;
	const name = `picode-agent-test-${randomBytes(6).toString('hex')}`;

	suiteSetup(async () => {
		server = await LocalPipeServer.start(name, {
			onLine: (connection, line) => server?.send(connection, `echo:${line}`),
			onTooLong: connection => server?.send(connection, 'too-long'),
			onClose: () => { },
			onExit: () => { },
		});
	});

	test('a line over the limit is refused once and its tail is not read as another line', async () => {
		const replies = await new Promise<string[]>((resolve, reject) => {
			const socket = connect(`\\\\.\\pipe\\${name}`);
			let received = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				received += chunk;
				const lines = received.split('\n').filter(Boolean);
				if (lines.length >= 2) {
					socket.end();
					resolve(lines);
				}
			});
			socket.on('error', reject);
			socket.on('connect', () => socket.write(`${'x'.repeat(MAX_LINE_BYTES + 300_000)}\nnext\n`));
		});
		assert.deepStrictEqual(replies, ['too-long', 'echo:next']);
	});

	suiteTeardown(() => server?.dispose());

	function roundTrip(host: string, line: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const socket = connect(`\\\\${host}\\pipe\\${name}`);
			let received = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				received += chunk;
				if (received.includes('\n')) {
					socket.end();
					resolve(received.split('\n')[0]);
				}
			});
			socket.on('error', reject);
			socket.on('connect', () => socket.write(`${line}\n`));
		});
	}

	test('a client on this computer gets its lines through, in UTF-8', async () => {
		assert.strictEqual(await roundTrip('.', 'hola, ¿qué tal? ✓'), 'echo:hola, ¿qué tal? ✓');
	});

	test('several clients at once each get their own replies', async () => {
		const replies = await Promise.all(['a', 'b', 'c'].map(line => roundTrip('.', line)));
		assert.deepStrictEqual(replies, ['echo:a', 'echo:b', 'echo:c']);
	});

	test('a client through \\\\localhost (the network path) is refused', async () => {
		await assert.rejects(roundTrip('localhost', 'x'));
	});

	test('a client through \\\\<this computer> (the network path) is refused', async () => {
		await assert.rejects(roundTrip(hostname(), 'x'));
	});

	test('the same name cannot be taken by a second listener', async () => {
		await assert.rejects(LocalPipeServer.start(name, { onLine: () => { }, onTooLong: () => { }, onClose: () => { }, onExit: () => { } }));
	});
});
