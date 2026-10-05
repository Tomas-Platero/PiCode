// lib/daemon.js — the ONE owner of sessions.sqlite, served to local clients.
//
// pi-durable's spec allows one process to own a storage at a time, and its
// watches are fed by same-process commits only — which is why `attach` used to
// poll the SQLite and why "two clients" only worked inside one process. The
// daemon fixes both at once: it opens the ONE shared sessions.sqlite and
// becomes its single owner, then serves a small NDJSON protocol over a LOCAL
// endpoint (Windows named pipe / Unix domain socket — never a TCP port, since a
// process that runs the owner's tools must not be reachable off the machine).
//
// Permission delegation: the deterministic guard (lib/guard.js) blocks
// destructive commands in code. A protocol client that CAN decide (the ACP
// endpoint, lib/acp.js) registers itself with `permissions.listen` for its
// conversations; on a guarded call the daemon pushes a `permission` event to
// that client, relays the client's answer back into the guard hook through
// `permissions.decide`, and offers `allow` as the allow_always path. With no
// listener, the guard blocks exactly as before — the CLI's behaviour is
// unchanged.
//
// Every conversation run happens inside this process, so every subscriber —
// any number of them, from any number of client processes — sees the same live
// `watchEvents` stream. Clients never open the database; they only talk to the
// daemon. See README.md ("The daemon") for the full protocol.
import net from "node:net";
import { AgentDoc, watchEvents } from "@earendil-works/pi-durable";
import { CTX, SHARED_DB, answerText, listConversations, openHarness } from "./common.js";
import { allowCommand, makeGuardExtension } from "./guard.js";
import { loadSkills, makeSkillsExtension } from "./skills.js";
import { loadAgents, resolveAgentChange } from "./agents.js";
import { DEFAULT_PROFILE_DIR } from "./profile.js";
import { armMcpFilter, closeMcpConnections, connectBridge } from "./mcp.js";
import { parseModelSetting } from "./settings.js";
import { LineStream, PROTOCOL_VERSION, daemonEndpoint, endpointIsUp } from "./protocol.js";

/** Resolve `model`/`agent` request parameters against the daemon's own resolved options. */
function agentFor(resolved, agents, params) {
	const agent = {};
	const model = parseModelSetting(params.model ?? resolved.options.model.value);
	if (model) agent.model = model;
	const change = resolveAgentChange(agents, params.agent ?? resolved.options.agent?.value, DEFAULT_PROFILE_DIR);
	if (change) Object.assign(agent, change);
	return agent;
}

async function requireConversation(harness, conversationId) {
	const conversation = await harness.conversation(conversationId, CTX);
	if (!conversation) {
		throw new Error(`No conversation "${conversationId}" in ${SHARED_DB} — run \`node cli.js sessions\` to list ids.`);
	}
	return conversation;
}

/**
 * Start the daemon: connect the MCP bridge once, open the shared storage, and
 * serve the protocol until `shutdown` or Ctrl+C. Resolved durable options
 * (`picode.durable.*` / flags) come from the caller, which has already printed
 * the `[settings]` lines.
 */
export async function startDaemon(resolved) {
	const agents = loadAgents(DEFAULT_PROFILE_DIR);
	const skills = loadSkills(DEFAULT_PROFILE_DIR);
	const bridge = await connectBridge(resolved.options.mcp.value, DEFAULT_PROFILE_DIR);
	// If anything below fails (the storage already owned, the endpoint taken), the
	// MCP connections must not keep this half-started process alive.
	try {
		return await serveStorage(resolved, bridge, agents, skills);
	} catch (error) {
		await closeMcpConnections(bridge.connections).catch(() => {});
		throw error;
	}
}

/** How long a permission request may sit unanswered before the guard treats it as rejected. */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

async function serveStorage(resolved, bridge, agents, skills) {
	const extensions = [
		makeGuardExtension({ enabled: resolved.options.guard.value, consultPermission }),
		makeSkillsExtension(skills),
	];
	if (bridge.extension) extensions.push(bridge.extension);
	const { harness, storage } = await openHarness({ db: SHARED_DB, extensions });

	const endpoint = daemonEndpoint();
	const subscribers = new Map(); // LineStream → Set<conversationId> it subscribed to
	const streams = new Map(); // conversationId → { stream, refs } (one watchEvents per conversation, fanned out)
	const permissionListeners = new Map(); // conversationId → Set<LineStream> that decide guarded calls (ACP)
	const pendingPermissions = new Map(); // permission requestId → resolve(answer)
	let nextPermissionId = 1;

	/**
	 * The guard's escape hatch for protocol clients that can decide: push the
	 * guarded call to every listener of this conversation and await the answer.
	 * `undefined` (no listener) means "decide deterministically", as before.
	 */
	function consultPermission(conversationId, call, verdict) {
		const listeners = permissionListeners.get(conversationId);
		if (!listeners || listeners.size === 0) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const requestId = `perm-${nextPermissionId++}`;
			const timer = setTimeout(() => finish({ approved: false, reason: "the permission request timed out" }), PERMISSION_TIMEOUT_MS);
			function finish(answer) {
				clearTimeout(timer);
				pendingPermissions.delete(requestId);
				resolve(answer);
			}
			pendingPermissions.set(requestId, finish);
			for (const line of listeners) {
				line.send({ event: "permission", conversationId, requestId, toolName: call?.name, args: call?.arguments ?? {}, command: verdict?.command, reason: verdict?.reason });
			}
		});
	}

	function fanOut(conversationId, events) {
		for (const [line, ids] of subscribers) {
			if (!ids.has(conversationId)) continue;
			line.send({ event: "events", conversationId, events });
		}
	}

	async function release(line, conversationId) {
		const ids = subscribers.get(line);
		if (!ids) return;
		ids.delete(conversationId);
		if (ids.size === 0) subscribers.delete(line);
		const holder = streams.get(conversationId);
		if (!holder) return;
		holder.refs--;
		if (holder.refs <= 0) {
			streams.delete(conversationId);
			try {
				await holder.stream.stop();
			} catch (error) {
				console.error(`[daemon] stopping the stream for ${conversationId} failed: ${error?.message ?? error}`);
			}
		}
	}

	const methods = {
		async ping() {
			return { protocol: PROTOCOL_VERSION, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000), streams: streams.size, cwd: process.cwd() };
		},

		async sessions() {
			return { conversations: await listConversations(harness, storage) };
		},

		/** Resolve (or create) a conversation without running anything. */
		async open(params, line) {
			if (params.conversationId != null) {
				const conversation = await requireConversation(harness, params.conversationId);
				return { conversationId: conversation.id };
			}
			const agent = agentFor(resolved, agents, params);
			if (bridge.filter) agent.tools = bridge.filter; // the MCP deferral, same as a direct `run`
			const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, CTX);
			return { conversationId: conversation.id };
		},

		/** Submit a prompt and settle. Subscribers receive the events live, whatever process they are in. */
		async run(params) {
			const conversation = await requireConversation(harness, params.conversationId);
			const change = agentFor(resolved, agents, params);
			if (change.model || change.instructions) await conversation.configure(change, CTX);
			await armMcpFilter(harness, conversation, bridge, CTX);
			const submission = await conversation.submit({ type: "input", content: String(params.prompt ?? "") }, CTX);
			const settled = await submission.wait(CTX);
			const answer = await answerText(conversation, settled, CTX);
			// `reason` (on "unanswered": aborted, failed, ...) lets protocol mappers turn a cancel into a cancel.
			return { conversationId: conversation.id, status: settled.status, answer, ...(settled.status !== "done" ? { reason: settled.reason } : {}) };
		},

		/** Fork at the newest entry, then run the prompt on the fork. */
		async fork(params) {
			const source = await requireConversation(harness, params.conversationId);
			const newest = (await source.entries({}, 1, undefined, CTX)).items[0];
			if (!newest) throw new Error(`Conversation ${source.id} has no entries to fork from.`);
			const agent = agentFor(resolved, agents, params);
			if (bridge.filter) agent.tools = bridge.filter;
			const forkOptions = { ownership: { kind: "ownerless" } };
			if (Object.keys(agent).length > 0) forkOptions.agent = agent;
			const fork = await source.fork(newest.id, forkOptions, CTX);
			console.error(`[daemon] fork ${source.id} @entry ${newest.id} → ${fork.id}`);
			const submission = await fork.submit({ type: "input", content: String(params.prompt ?? "") }, CTX);
			const settled = await submission.wait(CTX);
			const answer = await answerText(fork, settled, CTX);
			return { conversationId: fork.id, forkedFrom: source.id, status: settled.status, answer };
		},

		async allow(params) {
			const conversation = await requireConversation(harness, params.conversationId);
			const allowed = await allowCommand(harness, conversation, params.command, CTX);
			return { conversationId: conversation.id, allowed };
		},

		/** Abort the conversation's current run (session/cancel lands here). The waiting `run` settles. */
		async cancel(params) {
			const conversation = await requireConversation(harness, params.conversationId);
			await conversation.abort(CTX);
			return { conversationId: conversation.id, aborted: true };
		},

		/** Register this connection as the permission decider for one conversation (the ACP endpoint). */
		async "permissions.listen"(params, line) {
			const conversation = await requireConversation(harness, params.conversationId);
			let set = permissionListeners.get(conversation.id);
			if (!set) {
				set = new Set();
				permissionListeners.set(conversation.id, set);
			}
			set.add(line);
			return { conversationId: conversation.id, listening: true };
		},

		/** Deliver a permission decision made by the protocol client. */
		async "permissions.decide"(params) {
			const finish = pendingPermissions.get(String(params.requestId));
			if (!finish) throw new Error(`no pending permission request "${params.requestId}"`);
			finish({ approved: params.approved === true, reason: params.reason });
			return { requestId: String(params.requestId), decided: true };
		},

		/** Subscribe a client to a conversation's live events (plus its snapshot as the response). */
		async subscribe(params, line) {
			const conversation = await requireConversation(harness, params.conversationId);
			let holder = streams.get(conversation.id);
			if (!holder) {
				const stream = await watchEvents(harness, conversation.id, CTX);
				holder = { stream, refs: 0 };
				streams.set(conversation.id, holder);
				await stream.start(async (events) => fanOut(conversation.id, events));
			}
			holder.refs++;
			let ids = subscribers.get(line);
			if (!ids) {
				ids = new Set();
				subscribers.set(line, ids);
			}
			ids.add(conversation.id);
			return { conversationId: conversation.id, snapshot: holder.stream.snapshot };
		},

		async unsubscribe(params, line) {
			await release(line, params.conversationId);
			return { conversationId: params.conversationId, unsubscribed: true };
		},

		async shutdown() {
			console.error("[daemon] shutdown requested");
			setTimeout(async () => {
				try {
					for (const holder of streams.values()) await holder.stream.stop();
				} catch {
					// the streams may already be gone
				}
				try {
					await harness.close(CTX);
				} catch {
					// closing a harness twice must not keep the process alive
				}
				try {
					await closeMcpConnections(bridge.connections);
				} catch {
					// same
				}
				process.exit(0);
			}, 50).unref();
			return { stopping: true };
		},
	};

	async function dispatch(line, request) {
		if (!request || typeof request !== "object" || request.event !== undefined) return; // not a request
		const { id, method, params = {} } = request;
		if (typeof id !== "number" || typeof method !== "string") {
			line.send({ id: id ?? null, ok: false, error: "every line must be a request: {id, method, params}" });
			return;
		}
		try {
			const result = await methods[method](params, line);
			line.send({ id, ok: true, result });
		} catch (error) {
			line.send({ id, ok: false, error: error?.message ?? String(error) });
		}
	}

	const server = net.createServer((socket) => {
		const line = new LineStream(socket, (message) => {
			dispatch(line, message).catch((error) => console.error(`[daemon] dispatch failed: ${error?.message ?? error}`));
		});
		socket.on("close", () => {
			const ids = subscribers.get(line);
			if (ids) for (const conversationId of [...ids]) release(line, conversationId).catch(() => {});
			for (const [conversationId, set] of permissionListeners) {
				set.delete(line);
				if (set.size === 0) permissionListeners.delete(conversationId);
			}
		});
		socket.on("error", () => {}); // 'close' does the cleanup
	});

	const listen = () => new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	try {
		await listen();
	} catch (error) {
		if (error?.code === "EADDRINUSE" && await endpointIsUp(endpoint)) {
			throw new Error(`another daemon already owns ${SHARED_DB} (endpoint ${endpoint}) — one process owns the storage at a time. Stop it first or use its clients: node cli.js attach <id> / node cli.js send "<prompt>"`);
		}
		throw error;
	}

	console.error(`[daemon] owner of ${SHARED_DB} — listening on ${endpoint}`);
	console.error("[daemon] methods: ping sessions open run fork allow cancel permissions.listen permissions.decide subscribe unsubscribe shutdown");

	// Graceful Ctrl+C: same path as the shutdown method.
	process.on("SIGINT", () => {
		methods.shutdown().catch(() => process.exit(0));
	});

	return { endpoint, server, harness };
}
