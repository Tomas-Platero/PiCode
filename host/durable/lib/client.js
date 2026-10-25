// lib/client.js — the client side of the daemon protocol: connect to the local
// endpoint, send requests, and receive pushed event lines. Used by the CLI's
// `attach`, `send`, `sessions` and `allow` commands when the daemon owns the
// storage. A client NEVER opens sessions.sqlite itself — the daemon owns it.
//
// If the daemon is not running the client must say so plainly and not hang:
// connect() bounds the wait (3 s) and fails with DaemonUnavailableError, whose
// message names the endpoint and the command that starts the daemon.
import net from "node:net";
import { daemonEndpoint, endpointIsUp, LineStream, PROTOCOL_VERSION } from "./protocol.js";

/** Thrown when the daemon is not running (or does not answer in time). */
export class DaemonUnavailableError extends Error {}

/** True when something is listening on the daemon endpoint. */
export function daemonIsUp() {
	return endpointIsUp();
}

/** A connected daemon client. One instance per process is enough. */
export class DaemonClient {
	constructor(socket) {
		this.socket = socket;
		this.live = true;
		this.nextId = 1;
		this.pending = new Map(); // request id → { resolve, reject }
		this.eventListeners = new Set();
		this.line = new LineStream(socket, (message) => this.onMessage(message));
		socket.on("close", () => this.onClosed());
		socket.on("error", () => {}); // 'close' follows and does the cleanup
	}

	/**
	 * Connect to the daemon. Bounded: `timeoutMs` (default 3 s), then
	 * DaemonUnavailableError — a client never hangs on a missing daemon.
	 */
	static connect(timeoutMs = 3000) {
		return new Promise((resolve, reject) => {
			const socket = net.connect(daemonEndpoint());
			const fail = (error) => {
				clearTimeout(timer);
				socket.destroy();
				reject(new DaemonUnavailableError(
					`no durable daemon is running at ${daemonEndpoint()} — start it with: node cli.js serve`,
					{ cause: error },
				));
			};
			const timer = setTimeout(() => fail(new Error("timed out")), timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve(new DaemonClient(socket));
			});
			socket.once("error", fail);
		});
	}

	onMessage(message) {
		if (typeof message?.id === "number" && this.pending.has(message.id)) {
			const { resolve, reject } = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.ok) resolve(message.result);
			else reject(new Error(message.error ?? "daemon error"));
			return;
		}
		if (message?.event) {
			for (const listener of this.eventListeners) listener(message);
		}
	}

	onClosed() {
		if (!this.live) return;
		this.live = false;
		for (const [, { reject }] of this.pending) {
			reject(new Error("the daemon closed the connection"));
		}
		this.pending.clear();
		for (const listener of this.eventListeners) listener({ event: "closed" });
	}

	/** Send a request; resolves with the response's `result` or rejects with its `error`. */
	request(method, params = {}) {
		if (!this.live) return Promise.reject(new Error("the daemon connection is closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.line.send({ id, method, params });
		});
	}

	/** Receive pushed event lines: {event, conversationId, ...}. Returns an unsubscribe fn. */
	onEvent(listener) {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	close() {
		this.live = false;
		this.line.close();
	}
}

export { PROTOCOL_VERSION };
