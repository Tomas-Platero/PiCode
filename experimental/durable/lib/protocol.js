// lib/protocol.js — the wire format shared by the daemon (lib/daemon.js) and its
// clients (lib/client.js). One local endpoint, newline-delimited JSON.
//
// Framing: every message is ONE JSON object on ONE line, UTF-8, terminated by "\n".
//   client → daemon request:  {"id": <number>, "method": "<name>", "params": {...}}
//   daemon → client response: {"id": <number>, "ok": true, "result": {...}}
//                          or {"id": <number>, "ok": false, "error": "<reason>"}
//   daemon → client event (no id, pushed without being asked):
//                          {"event": "events", "conversationId": <id>, "events": [...]}
//
// The endpoint is LOCAL ONLY: a Windows named pipe or a Unix domain socket.
// Never a TCP port — a daemon that runs the owner's tools must not be
// reachable from another machine.
import net from "node:net";
import path from "node:path";
import { DATA_DIR } from "./common.js";

export const PROTOCOL_VERSION = 1;

/** The local-only endpoint the daemon listens on. */
export function daemonEndpoint() {
	return process.platform === "win32"
		? "\\\\.\\pipe\\picode-durable-agent" // Windows named pipe
		: path.join(DATA_DIR, "durable.sock"); // Unix domain socket (under the gitignored .data/)
}

/**
 * True when something is listening on the endpoint (a live daemon, not a stale socket).
 * Probes are retried: a named-pipe server briefly re-arms its listening instance after
 * every client, so a single probe right after a burst of clients can fail spuriously —
 * and a false "daemon is down" would let a second process write to the storage.
 */
export function endpointIsUp(endpoint = daemonEndpoint(), { retries = 3, pauseMs = 250 } = {}) {
	const once = () => new Promise((resolve) => {
		const probe = net.connect(endpoint);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
	return (async () => {
		for (let attempt = 0; attempt < retries; attempt++) {
			if (attempt > 0) await new Promise((r) => setTimeout(r, pauseMs));
			if (await once()) return true;
		}
		return false;
	})();
}

/**
 * Splits a socket into newline-delimited JSON messages.
 * `onMessage` is called with each parsed object; unparseable lines are dropped.
 * `send` writes one object as one line.
 */
export class LineStream {
	constructor(socket, onMessage) {
		this.socket = socket;
		this.buffer = "";
		this.closed = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			this.buffer += chunk;
			let idx;
			while ((idx = this.buffer.indexOf("\n")) >= 0) {
				const raw = this.buffer.slice(0, idx).trim();
				this.buffer = this.buffer.slice(idx + 1);
				if (!raw) continue;
				let message = null;
				try {
					message = JSON.parse(raw);
				} catch {
					message = null;
				}
				if (message !== null) onMessage(message);
			}
		});
	}

	send(message) {
		if (this.closed) return;
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	close() {
		this.closed = true;
		try {
			this.socket.end();
		} catch {
			// the socket may already be gone; closing twice is not an error
		}
	}
}
