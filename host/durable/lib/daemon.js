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
import path from "node:path";
import { AssistantEntry, UserEntry, watchEvents } from "@earendil-works/pi-durable";
import { CTX, SHARED_DB, answerText, backfillConversationCwds, listConversations, openHarness } from "./common.js";
import { allowCommand, makeGuardExtension } from "./guard.js";
import { loadSkills, makeSkillsExtension } from "./skills.js";
import { loadMemoryProtocol, makeMemoryExtension, memoryIsConnected } from "./memory.js";
import { SubagentExtension } from "./extensions.js";
import { loadAgents, resolveAgentChange } from "./agents.js";
import { DEFAULT_PROFILE_DIR } from "./profile.js";
import { armAllMcpFilters, armMcpFilter, closeMcpConnections, connectBridge, mcpBridgeWaitMs, NO_BRIDGE } from "./mcp.js";
import { parseModelSetting } from "./settings.js";
import { LineStream, PROTOCOL_VERSION, daemonEndpoint, endpointIsUp } from "./protocol.js";
import { CachedStreams } from "./streams.js";

/** Resolve `model`/`agent`/`cwd` request parameters against the daemon's own resolved options. */
export function agentFor(resolved, agents, params) {
	const agent = {};
	const model = parseModelSetting(params.model ?? resolved.options.model.value);
	if (model) agent.model = model;
	const change = resolveAgentChange(agents, params.agent ?? resolved.options.agent?.value, DEFAULT_PROFILE_DIR);
	if (change) Object.assign(agent, change);
	// The conversation's working directory — where its tools run. Only a directory that is
	// absolute is accepted: a relative one would mean wherever the daemon happens to have
	// been started, which is the daemon's own folder and nobody's project. `configure`
	// replaces the stored cwd, so `run` can re-home an existing conversation too.
	if (typeof params.cwd === "string" && params.cwd.length > 0 && path.isAbsolute(params.cwd)) {
		agent.cwd = params.cwd;
	}
	return agent;
}

/** One pi message from an unknown value, or `undefined` when it is not one. */
function toPiMessage(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const role = value.role;
	if (role !== "user" && role !== "assistant") return undefined;
	const content = value.content;
	let parts;
	if (Array.isArray(content)) {
		parts = content;
	} else if (typeof content === "string") {
		parts = [{ type: "text", text: content }];
	} else {
		return undefined;
	}
	// An assistant message with no parts is a REAL shape, not junk: pi writes it when a turn
	// was interrupted before it said anything (tool calls in flight, window closed). The
	// import's tail turn rides on it — without it, a transcript that ended mid-work records
	// as if it ended on the owner's own prompt, and the panel reads history as "Input Needed".
	// A user message with nothing is still refused: silence from the owner is not a turn.
	if (parts.length === 0 && role !== "assistant") return undefined;
	// Pass-through beyond the two checked fields: the message is the caller's own pi message
	// (usage, model, tool payloads included), and inventing or stripping fields here would
	// make the recorded turn someone else's idea of what happened. The one field the daemon
	// fills in when the caller left it out is the timestamp: the panel dates every
	// conversation from its messages' own stamps, and a recorded turn without one would
	// forever show the 1970 epoch ("57y ago").
	return {
		...value,
		role,
		content: parts,
		...(typeof value.timestamp === "number" ? {} : { timestamp: Date.now() }),
	};
}

async function requireConversation(harness, conversationId) {
	const conversation = await harness.conversation(conversationId, CTX);
	if (!conversation) {
		throw new Error(`No conversation "${conversationId}" in ${SHARED_DB} — run \`node cli.js sessions\` to list ids.`);
	}
	return conversation;
}

/**
 * Start the daemon: open the shared storage, serve the protocol IMMEDIATELY, and
 * connect the MCP bridge behind the endpoint. Resolved durable options
 * (`picode.durable.*` / flags) come from the caller, which has already printed
 * the `[settings]` lines.
 */
export async function startDaemon(resolved) {
	const agents = loadAgents(DEFAULT_PROFILE_DIR);
	const skills = loadSkills(DEFAULT_PROFILE_DIR);
	return await serveStorage(resolved, agents, skills);
}

/** How long a permission request may sit unanswered before the guard treats it as rejected. */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

async function serveStorage(resolved, agents, skills) {
	// The harness opens WITHOUT the MCP extension: the endpoint must answer while
	// the bridge still connects. The extension is installed into the registry once
	// the bridge has settled (below) — the registry is built for exactly that
	// ("the registry may keep changing while the Harness runs") — and the deferral
	// filter, armed by the waiting methods and by armAllMcpFilters, is what keeps
	// the late tools out of every prompt.
	const extensions = [
		makeGuardExtension({ enabled: resolved.options.guard.value, consultPermission }),
		makeSkillsExtension(skills),
		// The durable agent's own `subagent` tool: it hands a self-contained task to a background
		// anchor task, which owns a child conversation the panel's Tasks block lists. Without it the
		// model reaches for whatever else answers the same need — the profile packages' pane
		// launchers, which shell out to the separate Herdr CLI this installation does not carry, and
		// the chat answers with HERDR_UNAVAILABLE instead of work. The child conversation drops this
		// extension again (no recursion), and no profile package registers a tool of the same name.
		SubagentExtension,
	];
	const { harness, storage, registry, profileProblem } = await openHarness({ db: SHARED_DB, extensions });
	if (profileProblem) {
		// The profile cannot back a model run (openHarness already printed the one plain
		// line naming what is missing). That is a normal state, not a crash: the daemon
		// comes up anyway, serves ping/sessions/subscribe, and every run fails with the
		// SAME sentence instead of a stack trace or a hang — see `run`/`fork` below.
		console.error("[profile] the daemon stays up anyway: ping, sessions, open, subscribe and shutdown are served; every run/fork fails with the reason above until the profile is fixed.");
	}

	// The historical conversations carry the daemon's home directory as their cwd — they
	// were opened before the daemon recorded each one's working directory, and the
	// editor's per-project sessions panel shows them nowhere. Their project is on record
	// in their own transcripts; this writes it back once, before the endpoint serves a
	// listing, so the panel's first answer is already correct. A daemon whose every
	// conversation has a project cwd walks out of this in one pass of agent reads.
	try {
		await backfillConversationCwds(harness, storage);
	} catch (error) {
		console.error(`[daemon] the working-directory backfill failed (the daemon starts anyway): ${error instanceof Error ? error.message : String(error)}`);
	}

	// The MCP bridge connects BEHIND the endpoint: it is started once `listen` has
	// succeeded (further down), and until then `bridgeReady` is already resolved
	// with NO_BRIDGE. `bridge` mirrors the settled bridge for shutdown; the methods
	// that resolve an agent go through bridgeForAgent, never through `bridge`
	// directly, so a conversation's agent is never resolved against a
	// half-connected bridge.
	let bridge = NO_BRIDGE;
	let bridgeReady = Promise.resolve(NO_BRIDGE);

	/**
	 * The bounded wait every agent-resolving method holds before it touches a
	 * conversation's agent. The deferral filter is computed from the CONNECTED
	 * tools' names, so creating or configuring an agent before the bridge settles
	 * would leave the conversation offering every MCP tool unfiltered — the ~238
	 * KiB of schemas the deferral exists to prevent. The bound is the bridge's own
	 * (mcpBridgeWaitMs); if it passes without the bridge, say so and refuse rather
	 * than proceed into that case. `ping`, `sessions`, `subscribe`, `unsubscribe`,
	 * `allow`, `cancel`, `permissions.*` and `shutdown` never come here: nothing a
	 * client does to CHECK on the agent waits for eleven network connections.
	 */
	async function bridgeForAgent() {
		if (!resolved.options.mcp.value) return NO_BRIDGE; // nothing to wait for, nothing to filter
		const waitMs = mcpBridgeWaitMs(DEFAULT_PROFILE_DIR);
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(
				`the MCP bridge did not settle within ${Math.round(waitMs / 1000)}s — refusing to resolve a conversation's agent without the deferral filter (every MCP tool would be offered unfiltered). See the [mcp] lines on the daemon's terminal.`,
			)), waitMs);
			timer.unref();
		});
		try {
			return await Promise.race([bridgeReady, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	const endpoint = daemonEndpoint();
	const subscribers = new Map(); // LineStream → Set<conversationId> it subscribed to
	// conversationId → one watchEvents stream, fanned out, reference counted (lib/streams.js).
	const streams = new CachedStreams({
		stop: (stream) => stream.stop(),
		onStopError: (conversationId, error) => console.error(`[daemon] stopping the stream for ${conversationId} failed: ${error?.message ?? error}`),
	});
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
		await streams.giveBack(conversationId);
	}

	/**
	 * The conversation's snapshot as it is NOW, for a caller that found a stream already cached.
	 *
	 * `AgentEventStream.snapshot` is documented as "the `snapshot` event at attachment": the value
	 * `watchEvents` captured once, when the watch was created, never refreshed. That is exactly
	 * right for the client whose attach produced it and exactly wrong for everybody after — the
	 * cached stream is kept for the EVENTS it is there to fan out, so answering a second subscriber
	 * from it would hand over the state of the moment the first one attached. A run that settled
	 * long ago would still read as in flight, and the transcript would be the one from before it.
	 *
	 * So the answer is built by the library's own snapshot, on a stream of its own that is attached
	 * and stopped on this line: the shape cannot drift from `watchEvents`'s, and the cached stream
	 * keeps delivering events to the clients already subscribed, untouched.
	 */
	async function snapshotNow(conversationId) {
		const stream = await watchEvents(harness, conversationId, CTX);
		try {
			return stream.snapshot;
		} finally {
			try {
				await stream.stop();
			} catch (error) {
				console.error(`[daemon] stopping the transient stream for ${conversationId} failed: ${error?.message ?? error}`);
			}
		}
	}

	/**
	 * The part `run` and `start` share: resolve the agent the request asks for, arm the MCP deferral
	 * filter, and admit the prompt. Returns the submission; waiting on it is the caller's choice,
	 * which is the whole difference between the two methods.
	 */
	async function submitInput(conversation, params) {
		const change = agentFor(resolved, agents, params);
		if (change.model || change.instructions || change.cwd) await conversation.configure(change, CTX);
		// The deferral needs the CONNECTED tools' names: wait for the bridge (bounded).
		const settledBridge = await bridgeForAgent();
		await armMcpFilter(harness, conversation, settledBridge, CTX);
		return conversation.submit({ type: "input", content: String(params.prompt ?? "") }, CTX);
	}

	const methods = {
		async ping() {
			return { protocol: PROTOCOL_VERSION, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000), streams: streams.size, cwd: process.cwd() };
		},

		async sessions() {
			return { conversations: await listConversations(harness, storage) };
		},

		/** Resolve (or create) a conversation without running anything. */
		async open(params, _line) {
			if (params.conversationId != null) {
				const conversation = await requireConversation(harness, params.conversationId);
				// An existing conversation MAY be re-pointed at a directory: the import's repair
				// pass re-homes conversations that were recorded before the daemon stored each
				// one's working directory (they carry the daemon's home, and the per-project
				// sessions panel shows them nowhere). Only an absolute directory is accepted,
				// the same rule agentFor applies to new ones.
				if (typeof params.cwd === "string" && params.cwd.length > 0 && path.isAbsolute(params.cwd)) {
					await conversation.configure({ cwd: params.cwd }, CTX);
				}
				return { conversationId: conversation.id };
			}
			// A NEW conversation needs the deferral filter, so it waits for the bridge
			// (bounded — see bridgeForAgent). An existing one does not: nothing about
			// its agent is resolved here, and armMcpFilter covers it at `run` time.
			const settled = await bridgeForAgent();
			const agent = agentFor(resolved, agents, params);
			if (settled.filter) agent.tools = settled.filter; // the MCP deferral, same as a direct `run`
			const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, CTX);
			return { conversationId: conversation.id };
		},

		/**
		 * Record a FINISHED turn into a conversation without running anything.
		 *
		 * The editor's chat runs its own pi in the window and writes its turns here, so the
		 * conversation lives in the daemon's storage — visible from any window, continuable
		 * after any restart — while the brain stays pi's. Each message arrives as one pi
		 * message (`{role, content, ...}`); it is stored as the conversation's own
		 * `pi.user` / `pi.assistant` entry, the same shape a run writes, so listing and
		 * replay cannot tell a recorded turn from an executed one. Nothing is generated and
		 * no model is touched: a conversation recorded here never owes an answer.
		 */
		async record(params) {
			const conversation = await requireConversation(harness, params.conversationId);
			const messages = Array.isArray(params.messages) ? params.messages : [];
			if (messages.length === 0) return { conversationId: conversation.id, recorded: 0 };
			// The boundary where unknown JSON becomes durable entries: a message that does not
			// read as a pi message is refused with a sentence, not stored half-shaped.
			const clean = messages.map(toPiMessage);
			if (clean.some((message) => message === undefined)) {
				throw new Error("every recorded message must be {role: 'user' | 'assistant', content} — a pi message shape");
			}
			await conversation.commit(async (tx) => {
				for (const message of clean) {
					const token = message.role === "user" ? UserEntry : AssistantEntry;
					await tx.appendEntry(token, conversation.id, { model: [message] });
				}
			}, CTX);
			return { conversationId: conversation.id, recorded: clean.length };
		},

		/** Submit a prompt and settle. Subscribers receive the events live, whatever process they are in. */
		async run(params) {
			// A run genuinely needs a model: without a usable provider it must fail with the
			// plain reason — not succeed hollowly, not hang, not die with a stack trace.
			if (profileProblem) throw new Error(profileProblem);
			const conversation = await requireConversation(harness, params.conversationId);
			const submission = await submitInput(conversation, params);
			const settled = await submission.wait(CTX);
			const answer = await answerText(conversation, settled, CTX);
			// `reason` (on "unanswered": aborted, failed, ...) lets protocol mappers turn a cancel into a cancel.
			return { conversationId: conversation.id, status: settled.status, answer, ...(settled.status !== "done" ? { reason: settled.reason } : {}) };
		},

		/**
		 * Submit a prompt and return AT ONCE. The run belongs to the daemon: it keeps going after
		 * this connection closes, and its outcome is committed to the same storage `run` writes.
		 * Nothing is awaited here on purpose — the answer is read later through `subscribe` (the
		 * snapshot's `run`, then the `pi.assistant` entry).
		 *
		 * The settlement promise is not dropped: it is logged, so a run that dies in the background
		 * says so in the daemon log instead of vanishing.
		 */
		async start(params) {
			if (profileProblem) throw new Error(profileProblem);
			const conversation = await requireConversation(harness, params.conversationId);
			const submission = await submitInput(conversation, params);
			void submission.wait(CTX).then(
				(settled) => console.error(`[daemon] detached run ${conversation.id} (submission ${submission.id}) settled: ${settled.status}${settled.status !== "done" && settled.reason ? ` (${settled.reason})` : ""}`),
				(error) => console.error(`[daemon] detached run ${conversation.id} (submission ${submission.id}) failed: ${error?.message ?? error}`),
			);
			return { conversationId: conversation.id, submissionId: submission.id, status: "running" };
		},

		/** Fork at the newest entry, then run the prompt on the fork. */
		async fork(params) {
			if (profileProblem) throw new Error(profileProblem); // a fork runs a prompt: same rule as `run`
			const source = await requireConversation(harness, params.conversationId);
			const newest = (await source.entries({}, 1, undefined, CTX)).items[0];
			if (!newest) throw new Error(`Conversation ${source.id} has no entries to fork from.`);
			const settledBridge = await bridgeForAgent(); // the fork's agent needs the deferral filter
			const agent = agentFor(resolved, agents, params);
			if (settledBridge.filter) agent.tools = settledBridge.filter;
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
			// The claim is taken by `CachedStreams` before anything is awaited: a client that
			// unsubscribes while this request is taking its snapshot cannot drop the last reference,
			// stop the stream, and leave this subscriber attached to a stream that is already closed.
			const { holder, reused } = await streams.claim(conversation.id, () => watchEvents(harness, conversation.id, CTX));
			try {
				if (!reused) {
					await holder.stream.start(async (events) => fanOut(conversation.id, events));
				}
				let snapshot;
				try {
					// A stream attached just now answers for now; a cached one answers for its first attach.
					snapshot = reused ? await snapshotNow(conversation.id) : holder.stream.snapshot;
				} catch (error) {
					// A snapshot that cannot be taken is not a reason to lose the subscription: the cached
					// one is stale but real, and the caller keeps receiving this conversation's events.
					console.error(`[daemon] the current snapshot of ${conversation.id} could not be taken; answering with the cached one: ${error?.message ?? error}`);
					snapshot = holder.stream.snapshot;
				}
				let ids = subscribers.get(line);
				if (!ids) {
					ids = new Set();
					subscribers.set(line, ids);
				}
				ids.add(conversation.id);
				return { conversationId: conversation.id, snapshot };
			} catch (error) {
				// The request died after claiming the stream: give the claim back, or the reference count
				// would outlive the subscriber and keep the stream (and its memory) up for ever.
				await streams.giveBack(conversation.id);
				throw error;
			}
		},

		async unsubscribe(params, line) {
			await release(line, params.conversationId);
			return { conversationId: params.conversationId, unsubscribed: true };
		},

		async shutdown() {
			console.error("[daemon] shutdown requested");
			setTimeout(async () => {
				try {
					await streams.stopAll();
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
	console.error("[daemon] methods: ping sessions open run start record fork allow cancel permissions.listen permissions.decide subscribe unsubscribe shutdown");

	// Graceful Ctrl+C: same path as the shutdown method.
	process.on("SIGINT", () => {
		methods.shutdown().catch(() => process.exit(0));
	});

	// Belt and braces for the deaths a shutdown request cannot reach: the editor that
	// started this daemon crashing, being taskkilled, or the machine going down hard —
	// in none of those does any hook run, so the daemon needs its own reason not to
	// outlive its parent. The spawner that means it passes PICODE_PARENT_PIPE=1 and
	// holds THIS process's stdin open without ever writing to it. When that process
	// dies — any death — the kernel closes its end of the pipe, stdin reads EOF, and
	// the daemon stops itself through the SAME graceful path as `shutdown` (streams
	// stopped, storage closed cleanly). It cannot be fooled by a stale pid: no pid is
	// ever checked — the pipe is not a name but a kernel object owned by the parent,
	// and EOF IS the parent being gone. A plain `node cli.js serve` never sets the
	// variable, so manual runs keep meaning Ctrl+C and the endpoint, nothing else.
	if (process.env.PICODE_PARENT_PIPE === "1") {
		const stdin = process.stdin;
		if (stdin && !stdin.isTTY && stdin.readable !== false) {
			stdin.resume();
			stdin.once("end", () => {
				console.error("[daemon] the editor's lifeline pipe closed — the process that started this daemon is gone; shutting down.");
				methods.shutdown().catch(() => process.exit(0));
			});
			stdin.once("error", () => {}); // 'end' does the work; an errored pipe is a closing pipe
		}
	}

	// The endpoint is up and served; only now does the bridge start connecting.
	// When it settles, every conversation created while it was connecting and
	// carrying no tools filter of its own is armed with the deferral filter BEFORE
	// the extension is installed — so no conversation is ever left offering the
	// MCP tools unfiltered, whatever path created it.
	bridgeReady = (async () => {
		if (!resolved.options.mcp.value) return NO_BRIDGE; // --no-mcp: nothing to wait for, nothing to filter
		try {
			const settled = await connectBridge(resolved.options.mcp.value, DEFAULT_PROFILE_DIR);
			const armed = await armAllMcpFilters(harness, storage, settled, CTX);
			if (armed > 0) console.error(`[mcp] deferral filter armed on ${armed} conversation(s) that had none of their own`);
			if (settled.extension) registry.install(settled.extension);
			// The memory protocol rides with the memory tools, never before them: installed here,
			// after the bridge settled, and only when `engram` is one of the servers that answered.
			// The words come from the profile, written by the connector, so this agent and the chat
			// say the same thing about the same memory.
			if (memoryIsConnected(settled.connections)) {
				const protocol = loadMemoryProtocol(DEFAULT_PROFILE_DIR);
				if (protocol === undefined) {
					console.error("[memory] engram connected but no memory protocol is in the profile — the agent will not be told when to use it");
				} else {
					registry.install(makeMemoryExtension(protocol));
				}
			}
			bridge = settled;
			return settled;
		} catch (error) {
			// No extension was installed, so no conversation can see an MCP tool:
			// continuing without the bridge is safe — said loudly rather than silently.
			console.error(`[mcp] the bridge failed (${error?.message ?? error}) — continuing without MCP tools.`);
			bridge = NO_BRIDGE;
			return NO_BRIDGE;
		}
	})();

	return { endpoint, server, harness };
}
