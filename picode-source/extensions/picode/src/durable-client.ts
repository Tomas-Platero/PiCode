/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'node:net';
import * as path from 'node:path';

/**
 * The wire client of the durable daemon, **copied** from the agent that owns the
 * protocol (`picode-source/durable/lib/protocol.js` and `lib/client.js`). The connector is a
 * different process from that agent and cannot import from its directory at runtime,
 * so the small framing is duplicated here instead — a duplication the owner accepted, and
 * one that stays honest by naming its source: if the protocol there changes, this file is
 * the one that has to move with it.
 *
 * Framing: every message is ONE JSON object on ONE line, UTF-8, terminated by "\n".
 *   client → daemon request:  {"id": <number>, "method": "<name>", "params": {...}}
 *   daemon → client response: {"id": <number>, "ok": true, "result": {...}}
 *                          or {"id": <number>, "ok": false, "error": "<reason>"}
 *   daemon → client event (no id, pushed without being asked):
 *                          {"event": "events", "conversationId": <id>, "events": [...]}
 *
 * The endpoint is LOCAL ONLY: a Windows named pipe or a Unix domain socket. Never a TCP
 * port — a daemon that runs the owner's tools must not be reachable from another machine.
 */

export const PROTOCOL_VERSION = 1;

/** The named pipe the daemon listens on, matching the agent's choice exactly. */
const WINDOWS_PIPE = '\\\\.\\pipe\\picode-durable-agent';

/**
 * The endpoint the daemon listens on. On Windows it is the fixed named pipe; on POSIX it is
 * the socket under the daemon's own `.data/` folder, so the caller supplies the durable
 * folder (the `picode.durable.folder` setting).
 */
export function daemonEndpoint(durableFolder?: string): string {
	return process.platform === 'win32'
		? WINDOWS_PIPE
		: path.join(durableFolder ?? 'picode-source/durable', '.data', 'durable.sock');
}

/** Thrown when the daemon is not running (or does not answer in time). */
export class DaemonUnavailableError extends Error { }

/**
 * Splits a socket into newline-delimited JSON messages.
 * `onMessage` is called with each parsed object; unparseable lines are dropped.
 * `send` writes one object as one line, and stops after `close`.
 */
export class LineStream {

	constructor(socket: net.Socket, onMessage: (message: unknown) => void) {
		this.socket = socket;
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			this.buffer += chunk;
			let idx: number;
			while ((idx = this.buffer.indexOf('\n')) >= 0) {
				const raw = this.buffer.slice(0, idx).trim();
				this.buffer = this.buffer.slice(idx + 1);
				if (!raw) {
					continue;
				}
				let message: unknown = null;
				try {
					message = JSON.parse(raw);
				} catch {
					message = null;
				}
				if (message !== null) {
					onMessage(message);
				}
			}
		});
	}

	private readonly socket: net.Socket;
	private buffer = '';
	private closed = false;

	send(message: unknown): void {
		if (this.closed) {
			return;
		}
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	close(): void {
		this.closed = true;
		try {
			this.socket.end();
		} catch {
			// The socket may already be gone; closing twice is not an error.
		}
	}
}

/**
 * A connected daemon client: request/response matching plus pushed-event listeners.
 *
 * `connect` is **bounded** (`timeoutMs`, default 3 s) and fails with a
 * `DaemonUnavailableError` whose message names the endpoint — a client never hangs on a
 * missing daemon, exactly as the agent's own client does.
 */
export class DaemonClient {

	constructor(socket: net.Socket) {
		this.line = new LineStream(socket, message => this.onMessage(message));
		socket.on('close', () => this.onClosed());
		// 'close' follows and does the cleanup; the error itself is the connection's business.
		socket.on('error', () => { });
	}

	private readonly line: LineStream;
	private live = true;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly eventListeners = new Set<(message: unknown) => void>();

	/** Connect to the daemon. Bounded; see the class comment. */
	static connect(endpoint: string, timeoutMs = 3000): Promise<DaemonClient> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(endpoint);
			const fail = (cause: unknown) => {
				clearTimeout(timer);
				socket.destroy();
				reject(new DaemonUnavailableError(
					`no durable daemon is running at ${endpoint} — start it with "PiCode: Start Durable Agent"`,
					{ cause },
				));
			};
			const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs);
			socket.once('connect', () => {
				clearTimeout(timer);
				resolve(new DaemonClient(socket));
			});
			socket.once('error', fail);
		});
	}

	private onMessage(message: unknown): void {
		const record = message as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown; event?: unknown };
		if (typeof record?.id === 'number' && this.pending.has(record.id)) {
			const { resolve, reject } = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			if (record.ok) {
				resolve(record.result);
			} else {
				reject(new Error(typeof record.error === 'string' ? record.error : 'daemon error'));
			}
			return;
		}
		if (record?.event) {
			for (const listener of this.eventListeners) {
				listener(message);
			}
		}
	}

	private onClosed(): void {
		if (!this.live) {
			return;
		}
		this.live = false;
		for (const [, { reject }] of this.pending) {
			reject(new Error('the daemon closed the connection'));
		}
		this.pending.clear();
		for (const listener of this.eventListeners) {
			listener({ event: 'closed' });
		}
	}

	/** Send a request; resolves with the response's `result` or rejects with its `error`. */
	request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.live) {
			return Promise.reject(new Error('the daemon connection is closed'));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.line.send({ id, method, params });
		});
	}

	/** Receive pushed event lines. Returns an unsubscribe function. */
	onEvent(listener: (message: unknown) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	close(): void {
		this.live = false;
		this.line.close();
	}
}
