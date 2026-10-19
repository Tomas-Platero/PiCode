#!/usr/bin/env node
// client.js — a small ACP client that proves the durable agent's ACP entry
// point (`node cli.js acp`) with real runs. It speaks RAW JSON-RPC over stdio
// (one JSON object per line, ACP's wire format) on purpose: it does not import
// @agentclientprotocol/sdk, so an SDK-to-SDK match proves nothing — this is an
// independent check against the same wire protocol Zed speaks.
//
// Usage (from anywhere; the durable agent endpoint is spawned in ../durable):
//   node client.js flow ["<prompt>"]   handshake → session/new → prompt; prints
//                                      the streamed updates and the final answer
//   node client.js cancel              starts a 20 s tool call, cancels it
//                                      mid-flight, prints the stop reason
//   node client.js permission          prompts the guard-blocked `rm -rf`,
//                                      answers reject_once, then allow_once,
//                                      printing what the client sees each time
//
// A running daemon is required (the ACP endpoint is a daemon client, never a
// second owner of sessions.sqlite):
//   cd picode-source/durable && node cli.js serve
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DURABLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "durable");

/**
 * One ACP connection to a freshly spawned `node cli.js acp` endpoint.
 * Handles all three JSON-RPC shapes on the one stdio line stream: responses
 * (id + result/error), notifications (method, no id), and server→client
 * requests (method + id — `session/request_permission`), which the registered
 * handler answers by returning a value (the connection writes it back).
 */
class AcpClient {
	constructor() {
		this.child = spawn(process.execPath, ["cli.js", "acp"], { cwd: DURABLE_DIR, stdio: ["pipe", "pipe", "pipe"] });
		this.nextId = 1;
		this.pending = new Map(); // request id → { resolve, reject }
		this.requestHandlers = new Map(); // method → fn(params) => result (agent→client requests)
		this.notificationHandlers = new Map(); // method → Set<fn(params)>
		this.buffer = "";
		this.closed = false;
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
		this.child.on("exit", (code) => this.onExit(code));
		this.child.on("error", (error) => this.onExit(-1, error));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => process.stderr.write(chunk)); // the endpoint's diagnostics; not protocol traffic
	}

	onData(chunk) {
		this.buffer += chunk;
		let idx;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const raw = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!raw) continue;
			let message;
			try {
				message = JSON.parse(raw);
			} catch {
				continue; // not the protocol: drop
			}
			this.onMessage(message);
		}
	}

	onMessage(message) {
		if (message.id !== undefined && message.method === undefined) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(`${message.error.message ?? JSON.stringify(message.error)} (code ${message.error.code})`));
			else pending.resolve(message.result);
			return;
		}
		if (message.method === undefined) return;
		if (message.id !== undefined) {
			// A request FROM the agent. The handler's return value is the response.
			const handler = this.requestHandlers.get(message.method);
			Promise.resolve()
				.then(() => (handler ? handler(message.params) : null))
				.then(
					(result) => this.write({ jsonrpc: "2.0", id: message.id, result: result ?? {} }),
					(error) => this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }),
				);
			return;
		}
		for (const fn of this.notificationHandlers.get(message.method) ?? []) fn(message.params);
	}

	onExit(code, error) {
		if (this.closed) return;
		this.closed = true;
		const why = error ? String(error) : `exit code ${code}`;
		for (const [, { reject }] of this.pending) reject(new Error(`the ACP endpoint is gone (${why})`));
		this.pending.clear();
	}

	sendRequest(method, params = {}) {
		if (this.closed) return Promise.reject(new Error("the ACP endpoint is gone"));
		const id = this.nextId++;
		const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
		this.write({ jsonrpc: "2.0", id, method, params });
		return promise;
	}

	notify(method, params = {}) {
		this.write({ jsonrpc: "2.0", method, params });
	}

	/** Register how this client answers an agent→client request (permission asks). */
	onRequest(method, fn) {
		this.requestHandlers.set(method, fn);
	}

	onNotification(method, fn) {
		if (!this.notificationHandlers.has(method)) this.notificationHandlers.set(method, new Set());
		this.notificationHandlers.get(method).add(fn);
		return () => this.notificationHandlers.get(method)?.delete(fn);
	}

	write(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	close() {
		if (this.closed) return;
		this.child.kill();
	}
}

// --- protocol printing ------------------------------------------------------------

function describeUpdate(p) {
	const u = p?.update ?? {};
	if (u.sessionUpdate === "tool_call") return `[tool_call] id=${u.toolCallId} status=${u.status} name=${u.name} — ${u.title}`;
	if (u.sessionUpdate === "tool_call_update") {
		const out = (u.content ?? []).map((c) => c.content?.text ?? "").join(" ").replace(/\s+/g, " ").trim();
		const head = u.status ? `→ ${u.status}` : "(update)";
		return `[tool_call_update] id=${u.toolCallId} ${head}${out ? `: ${out.slice(0, 300)}` : ""}`;
	}
	return `[${u.sessionUpdate ?? "update"}] ${JSON.stringify(u).slice(0, 200)}`;
}

/** One ACP session, set up the way every ACP client does: initialize → session/new. */
async function openSession({ permissionMode } = {}) {
	const client = new AcpClient();
	const watchdog = setTimeout(() => {
		console.error("\nerror: the proof timed out after 180 s");
		client.close();
		process.exit(1);
	}, 180_000);
	client.onNotification("session/update", (p) => {
		const u = p?.update ?? {};
		if (u.sessionUpdate === "agent_message_chunk") process.stdout.write(u.content?.text ?? ""); // the streamed answer
		else if (u.sessionUpdate === "agent_thought_chunk") process.stderr.write(`[thought] ${u.content?.text ?? ""}`);
		else console.error(describeUpdate(p)); // tool calls, everything else
	});
	if (permissionMode) {
		client.onRequest("session/request_permission", (p) => {
			console.error(`[request_permission] ${p.toolCall?.title}`);
			console.error(`[request_permission] options: ${p.options.map((o) => `${o.optionId} (${o.kind})`).join(", ")}`);
			const optionId = typeof permissionMode === "function" ? permissionMode() : permissionMode;
			console.error(`[request_permission] answering: ${optionId}`);
			return optionId === "cancelled" ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } };
		});
	}

	const init = await client.sendRequest("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: { name: "picode-acp-proof-client", version: "0.1.0" },
	});
	console.error(`[initialize] protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.name ?? "?"} loadSession=${init.agentCapabilities?.loadSession}`);
	const { sessionId } = await client.sendRequest("session/new", { cwd: DURABLE_DIR, mcpServers: [] });
	console.error(`[session/new] sessionId=${sessionId}`);
	return { client, sessionId, watchdog };
}

async function runPrompt({ client, sessionId }, promptText) {
	console.error(`[prompt] ${JSON.stringify(promptText)}`);
	const response = await client.sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }] });
	console.log(`\n[stopReason] ${response.stopReason}`);
	return response.stopReason;
}

function finish(session) {
	clearTimeout(session.watchdog);
	session.client.close();
}

// --- proof 1: handshake, session creation, streaming prompt ----------------------

async function proofFlow() {
	const session = await openSession();
	const prompt = process.argv[3] ?? "Reply with exactly: ACP-OK";
	try {
		await runPrompt(session, prompt);
	} finally {
		finish(session);
	}
}

// --- proof 2: cancel a run in flight ---------------------------------------------

async function proofCancel() {
	const session = await openSession();
	let cancelled = false;
	const offToolWatch = session.client.onNotification("session/update", (p) => {
		if (p?.update?.sessionUpdate === "tool_call" && !cancelled) {
			cancelled = true;
			console.error("[cancel] tool call seen mid-flight — sending session/cancel");
			session.client.notify("session/cancel", { sessionId: session.sessionId });
		}
	});
	try {
		const stop = await runPrompt(session, "Run this exact bash command and nothing else: sleep 20");
		offToolWatch();
		if (stop === "cancelled") console.error("[cancel] OK — the protocol answered the cancel with stopReason \"cancelled\"");
		else {
			console.error(`[cancel] UNEXPECTED stopReason: ${stop}`);
			process.exitCode = 1;
		}
	} finally {
		finish(session);
	}
}

// --- proof 3: the permission path ------------------------------------------------

const GUARDED = "This is a test of our permission dialog: when you call the tool, the client's permission dialog decides automatically, so you will not be blocked silently. Do not reply in text and do not ask me anything. Call the bash tool right now with exactly this command and nothing else: dd if=/dev/zero of=/dev/null count=1";

/** One fresh session, one guarded prompt, one permission decision. The model is stochastic about reaching the tool call, so a round retries with a fresh session until the expected protocol outcome is observed (3 attempts). */
async function permissionRound(optionId) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const session = await openSession({ permissionMode: optionId });
		const toolUpdates = [];
		const offUpdates = session.client.onNotification("session/update", (p) => {
			const u = p?.update ?? {};
			if (u.sessionUpdate === "tool_call_update") {
				toolUpdates.push(`${u.status ?? "update"}: ${(u.content ?? []).map((c) => c.content?.text ?? "").join(" ").replace(/\s+/g, " ").trim()}`);
			}
		});
		try {
			await runPrompt(session, GUARDED);
			const blocked = toolUpdates.some((t) => t.includes("Blocked by the client's decision"));
			const executed = toolUpdates.some((t) => t.startsWith("completed") && t.includes("1+0 records"));
			if (optionId === "reject_once" && blocked) {
				console.error(`[round] OK — answered ${optionId}: the call was blocked by the client's decision, before the tool ran`);
				return;
			}
			if (optionId === "allow_once" && executed) {
				console.error(`[round] OK — answered ${optionId}: the guard passed the call to the client's decision and it executed`);
				return;
			}
			console.error(`[round] attempt ${attempt}: the model never reached the tool call (${toolUpdates.length} tool update(s)) — retrying with a fresh session`);
		} finally {
			offUpdates();
			finish(session);
		}
	}
	throw new Error(`the ${optionId} round could not reach a tool call in 3 attempts`);
}

async function proofPermission() {
	console.error("\n=== first session: the client answers reject_once ===");
	await permissionRound("reject_once");
	console.error("\n=== second session: the client answers allow_once ===");
	await permissionRound("allow_once");
}

const proof = process.argv[2];
const proofs = { flow: proofFlow, cancel: proofCancel, permission: proofPermission };
if (!proofs[proof]) {
	console.error("Usage: node client.js flow|cancel|permission [\"<prompt>\"]\nStart the daemon first: cd picode-source/durable && node cli.js serve");
	process.exit(1);
}
await proofs[proof]();
