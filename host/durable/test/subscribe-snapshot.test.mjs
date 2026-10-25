// MANUAL, NOT PART OF `npm run verify`: the first test below spends ONE real model call (the
// `start` it has to observe settling). Run it by hand, when the subscribe path changes:
//
//   node --test host/durable/test/subscribe-snapshot.test.mjs
//
// REGRESSION 1: `subscribe` must answer with the conversation as it is NOW, even when it reuses
// the event stream that a client already holds.
//
// The daemon caches one `watchEvents` stream per conversation while its reference count is above
// zero, and `AgentEventStream.snapshot` is documented as "the `snapshot` event at attachment" — a
// value captured once, never refreshed. So a client that keeps a subscription open for the life of
// a run (the transcript tab does exactly that) used to freeze the snapshot the daemon handed to
// everybody else: a later `subscribe` — `durable_result`, the TASKS block, `durable_read`, the
// export — read `run` and a transcript without the run's entries, and reported a conversation that
// settled as still running.
//
// REGRESSION 2: a subscribe that claims the stream must claim it BEFORE it awaits anything, so a
// client that unsubscribes meanwhile cannot drop the last reference, stop the stream, and leave the
// newcomer attached to a stream that is already closed (with the daemon reporting no stream at
// all).
//
// Both run against an isolated daemon — its own data folder, its own endpoint, its own settings
// file — so no real agent, storage or pipe is touched. The second test uses `record` (no model).

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DURABLE = join(HERE, '..');
const CLI = join(DURABLE, 'cli.js');
const BS = String.fromCharCode(92);

/** The profile the daemon reads for its model. Read-only; never written by this test. */
const PROFILE = process.env.PICODE_TEST_PROFILE
	|| join(DURABLE, '..', '..', 'PiCode-win32-x64', 'data', 'pi-agent');

/** A private data folder, endpoint and settings file: nothing of the real agent is touched. */
const work = mkdtempSync(join(tmpdir(), 'picode-subscribe-snapshot-'));
const dataDir = join(work, 'data');
mkdirSync(dataDir, { recursive: true });
const settingsFile = join(work, 'settings.json');
writeFileSync(settingsFile, JSON.stringify({ 'picode.durable.mcp': false, 'picode.durable.guard': false }, null, '\t'));
const endpoint = process.platform === 'win32'
	? `${BS}${BS}.${BS}pipe${BS}picode-subscribe-snapshot-${process.pid}`
	: join(work, 'durable.sock');

const daemon = spawn(process.execPath, [CLI, 'serve', '--no-mcp', '--no-guard'], {
	cwd: DURABLE,
	env: {
		...process.env,
		PICODE_DURABLE_DATA: dataDir,
		PICODE_DURABLE_ENDPOINT: endpoint,
		PICODE_USER_SETTINGS: settingsFile,
		PI_AGENT_PROFILE: PROFILE,
	},
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true,
});

const daemonLines = [];
daemon.stderr.setEncoding('utf8');
daemon.stderr.on('data', (chunk) => {
	for (const line of String(chunk).split(/\r?\n/)) {
		if (line.trim().length > 0) {
			daemonLines.push(line);
		}
	}
});

after(async () => {
	const exited = new Promise((resolve) => daemon.once('exit', resolve));
	try { daemon.kill(); } catch { /* already gone */ }
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
	daemon.unref();
	try { rmSync(work, { recursive: true, force: true }); } catch { /* Windows keeps a handle */ }
});

/** One client on the daemon's line protocol (lib/protocol.js): one JSON object per line. */
function connect(timeoutMs = 20000) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(endpoint);
		let buffer = '';
		let nextId = 1;
		const pending = new Map();
		const listeners = new Set();
		const client = {
			request(method, params = {}) {
				const id = nextId++;
				return new Promise((res, rej) => {
					pending.set(id, { res, rej });
					socket.write(JSON.stringify({ id, method, params }) + '\n');
					setTimeout(() => {
						if (pending.delete(id)) {
							rej(new Error(`${method} timed out`));
						}
					}, timeoutMs);
				});
			},
			onEvent(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			close() { socket.destroy(); },
		};
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const raw = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!raw.trim()) {
					continue;
				}
				let message;
				try { message = JSON.parse(raw); } catch { continue; }
				if (message.id !== undefined) {
					const entry = pending.get(message.id);
					if (!entry) {
						continue;
					}
					pending.delete(message.id);
					if (message.ok) {
						entry.res(message.result);
					} else {
						entry.rej(new Error(message.error));
					}
					continue;
				}
				for (const listener of listeners) {
					listener(message);
				}
			}
		});
		socket.on('error', reject);
		socket.on('connect', () => resolve(client));
	});
}

/** Wait until the daemon answers `ping` (it opens its storage before it listens). */
async function waitForDaemon() {
	const deadline = Date.now() + 30000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const client = await connect(3000);
			try {
				await client.request('ping');
				return;
			} finally {
				client.close();
			}
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`the isolated daemon never answered on ${endpoint}: ${lastError?.message ?? 'no error'}`
		+ `\n--- daemon stderr ---\n${daemonLines.join('\n')}`);
}

/** The daemon's own count of cached conversation streams. */
async function streamCount() {
	const client = await connect(5000);
	try {
		const ping = await client.request('ping');
		return ping.streams;
	} finally {
		client.close();
	}
}

test('a second subscribe sees the settled run, even while another client holds the stream', async () => {
	await waitForDaemon();

	const writer = await connect();
	const opened = await writer.request('open', {});
	const conversationId = opened.conversationId;
	console.log(`conversation under test: ${conversationId}`);

	// The prompt settles in a few seconds, which is the model call this file spends.
	const started = await writer.request('start', {
		conversationId,
		prompt: 'Answer with exactly the word READY and nothing else. Do not use any tool.',
	});
	console.log(`start answered: ${JSON.stringify(started)}`);

	// THE TAB: subscribed during the run, and it stays subscribed across the settlement.
	const holder = await connect();
	const held = await holder.request('subscribe', { conversationId });
	const heldEntries = (held.snapshot?.entries ?? []).length;
	console.log(`held snapshot at attach: entries=${heldEntries} run=${JSON.stringify(held.snapshot?.run ?? null)}`);
	assert.ok(held.snapshot?.run !== undefined, 'the held subscription must be attached while the run is in flight');

	// Settlement, observed on that same open stream: the tab's own view of the run ending.
	const settled = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { off(); reject(new Error('the run never settled')); }, 180000);
		const off = holder.onEvent((message) => {
			if (message.event !== 'events' || message.conversationId !== conversationId) {
				return;
			}
			for (const event of message.events ?? []) {
				if (event?.type === 'run_end') {
					clearTimeout(timer);
					off();
					resolve(event);
				}
			}
		});
	});
	console.log(`run ended on the held stream: ${JSON.stringify(settled)}`);

	// THE PANEL: a fresh client asks where the work stands.
	const reader = await connect();
	const answer = await reader.request('subscribe', { conversationId });
	const snapshot = answer.snapshot ?? {};
	const entries = snapshot.entries ?? [];
	const kinds = entries.map((entry) => entry.kind);
	console.log(`fresh subscribe: entries=${entries.length} run=${JSON.stringify(snapshot.run ?? null)}`
		+ ` generation=${JSON.stringify(snapshot.generation ?? null)} lastKind=${kinds.at(-1) ?? 'none'}`);
	console.log(`entry kinds: ${kinds.join(', ')}`);

	try {
		assert.equal(snapshot.run, undefined,
			'the snapshot of a settled run must not carry `run`');
		assert.ok(entries.length > heldEntries,
			`the snapshot must include the entries the run committed (held ${heldEntries}, read ${entries.length})`);
		assert.equal(kinds.at(-1), 'pi.assistant',
			'the newest entry must be the run answer');
	} finally {
		await reader.request('unsubscribe', { conversationId }).catch(() => undefined);
		reader.close();
		await holder.request('unsubscribe', { conversationId }).catch(() => undefined);
		holder.close();
		writer.close();
	}
});

test('a client leaving mid-subscribe does not leave the newcomer on a stopped stream', async () => {
	await waitForDaemon();

	const writer = await connect();
	const opened = await writer.request('open', {});
	const conversationId = opened.conversationId;

	// Enough entries that taking a fresh snapshot is not instantaneous, which is the window the
	// unsubscribe below has to land in. `record` needs no model.
	for (let round = 0; round < 300; round++) {
		await writer.request('record', {
			conversationId,
			messages: [{ role: 'user', content: `filler ${round}` }, { role: 'assistant', content: 'ok' }],
		});
	}
	console.log(`conversation ${conversationId} prepared; streams before: ${await streamCount()}`);

	// A holds the only reference.
	const leaving = await connect();
	const heldAnswer = await leaving.request('subscribe', { conversationId });
	const heldEntries = (heldAnswer.snapshot?.entries ?? []).length;
	console.log(`holder attached: entries=${heldEntries}`);

	let witnessed = 0;
	for (let round = 1; round <= 5; round++) {
		// Connected BEFORE the race: the socket handshake is not part of what is being measured.
		const newcomer = await connect();
		const batches = [];
		newcomer.onEvent((message) => {
			if (message.event === 'events' && message.conversationId === conversationId) {
				batches.push(message.events ?? []);
			}
		});

		// The newcomer's subscribe is written first, so its handler reaches the cached stream first;
		// the only client holding that stream leaves immediately after, dropping the count to zero
		// while the newcomer is still taking its snapshot.
		const subscribing = newcomer.request('subscribe', { conversationId });
		const unsubscribing = leaving.request('unsubscribe', { conversationId });
		const answer = await subscribing;
		await unsubscribing;
		const subscribingEntries = (answer.snapshot?.entries ?? []).length;
		const streams = await streamCount();
		console.log(`round ${round}: newcomer entries=${subscribingEntries} streams=${streams}`);

		// The stream the newcomer claimed must still be the cached one — not a dead holder.
		assert.equal(streams, 1,
			`the daemon must still hold the stream the newcomer claimed (found ${streams})`);
		assert.ok(subscribingEntries > 0, 'the newcomer must get a snapshot with entries');

		// And it must be alive: a commit now has to reach the newcomer as a live batch.
		await writer.request('record', { conversationId, messages: [{ role: 'user', content: `ping ${round}` }] });
		const deadline = Date.now() + 5000;
		while (batches.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		console.log(`round ${round}: live batches received=${batches.length}`
			+ ` firstTypes=${JSON.stringify((batches[0] ?? []).map((event) => event?.type))}`);
		assert.ok(batches.length > 0,
			'an entry committed after the race must reach the newcomer as a live event batch');
		witnessed++;

		// Hand the reference back before the next round, and leave via the newcomer this time so the
		// leaving client is the one that held the stream the round before.
		await newcomer.request('unsubscribe', { conversationId }).catch(() => undefined);
		await leaving.request('subscribe', { conversationId }).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 50));
		newcomer.close();
	}

	console.log(`rounds witnessed: ${witnessed}`);
	await leaving.request('unsubscribe', { conversationId }).catch(() => undefined);
	leaving.close();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const after = await streamCount();
	console.log(`streams after everybody left: ${after}`);
	assert.equal(after, 0, 'the stream must be dropped once nobody holds it');
	writer.close();
});
