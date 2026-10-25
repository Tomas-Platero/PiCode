// lib/acp.js — the Agent Client Protocol (ACP) entry point: the durable agent
// speaking ACP v1 over stdio, so any ACP client (Zed, JetBrains, this repo's
// picode-source/durable-acp-client) can drive the durable daemon.
//
// Why v1 (protocolVersion 1, the SDK's stable entry point) and not the v2
// draft: v1 is what existing clients speak, and the SDK itself marks v2 as an
// unstable draft whose wire protocol "may change incompatibly in any SDK
// release". v1.7's schema already carries the parts of the v2 lifecycle that
// matter — streaming flows through `session/update` while the prompt turn is
// in flight (the `session/prompt` response only carries `stopReason`), and
// `session/load` folds resume into session setup — so choosing v2 would trade
// client compatibility for draft instability.
//
// This endpoint is a CLIENT of the daemon (lib/client.js), never a second
// owner of sessions.sqlite: one process owns the storage at a time, and every
// run happens inside the daemon, where all subscribers see the same live
// watchEvents stream. Storage, guard, skills and MCP bridge are all reused.
//
// Mapping (ACP → durable):
//   initialize          → what this endpoint serves; capabilities below
//   session/new         → daemon `open` (a new ownerless conversation) + `subscribe`
//   session/load        → daemon `open <id>` + `subscribe`, then the snapshot
//                         is replayed to the client as session/update notifications
//   session/list        → daemon `sessions`
//   session/prompt      → daemon `run`; durable's live agent events are mapped to
//                         session/update while the run is in flight
//   session/cancel      → daemon `cancel` (Conversation.abort)
//   session/request_permission → the guard's destructive-command verdicts are
//                         offered to the ACP client for a decision instead of
//                         being silently blocked (see lib/daemon.js
//                         `permissions.*` and lib/guard.js consultPermission)
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { DaemonClient, DaemonUnavailableError } from "./client.js";
import { daemonEndpoint } from "./protocol.js";

const AGENT_INFO = { name: "picode-durable", version: "0.1.0" };

/** ACP ToolKind guesses for the tools this agent actually has. */
function toolKind(name) {
	if (name === "bash") return "execute";
	if (name === "read") return "read";
	if (name === "write" || name === "edit") return "edit";
	if (name === "grep" || name === "glob" || name === "find") return "search";
	if (String(name).startsWith("mcp__")) return "fetch";
	return "other";
}

/** Durable settled status → ACP stopReason. */
function stopReasonFor(settled) {
	if (settled?.status === "done") return "end_turn";
	const reason = String(settled?.reason ?? "");
	if (/abort|cancel/i.test(reason)) return "cancelled";
	return "refusal";
}

/** Content blocks → one plain-text prompt. Text and resource links are kept; anything else is named and skipped (this agent advertises no image/audio/embeddedContext prompt capabilities). */
function promptText(blocks) {
	const parts = [];
	for (const block of blocks ?? []) {
		if (block?.type === "text") parts.push(String(block.text ?? ""));
		else if (block?.type === "resource_link") parts.push(`${block.name ?? "resource"}: ${block.uri ?? "(no uri)"}`);
		else parts.push(`[unsupported content block: ${block?.type ?? "unknown"}]`);
	}
	return parts.join("\n").trim();
}

/** A transcript entry's tool-result message, when it has one. */
function toolResultMessage(entry) {
	const messages = Array.isArray(entry?.model) ? entry.model : [];
	return messages.find((m) => m?.role === "toolResult" || m?.isError !== undefined) ?? null;
}

/** Concatenated text of a pi-ai message's content (a string or an array of blocks). */
function textOfMessage(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b?.type === "text").map((b) => b.text).join("");
}

/** The assistant text carried by a message_end entry. */
function assistantTextOf(entry) {
	const messages = Array.isArray(entry?.model) ? entry.model : Array.isArray(entry?.data) ? entry.data : [];
	for (const m of messages) {
		if (m?.role !== "assistant") continue;
		const text = textOfMessage(m);
		if (text.trim()) return text;
	}
	return "";
}

/**
 * Map one durable AgentEvent to zero or more ACP session/update payloads.
 * `state` is the per-session stream state ({sawDelta}) used to avoid sending an
 * assistant message twice: the OmniRoute gateway answers in whole messages, so
 * when no text deltas streamed, message_end carries the full text.
 */
export function eventToUpdates(event, state) {
	switch (event?.type) {
		case "message_start":
			state.sawDelta = false;
			return [];
		case "message_update":
			return (event.changes ?? []).flatMap((change) => {
				if (change.type === "text_delta") {
					state.sawDelta = true;
					return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: change.delta } }];
				}
				if (change.type === "thinking_delta") {
					return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: change.delta } }];
				}
				return [];
			});
		case "message_end": {
			const message = event.message ?? event.entry?.model?.find((m) => m?.role === "assistant");
			const text = message ? assistantTextOf({ model: [message] }) : assistantTextOf(event.entry);
			if (state.sawDelta || !text) return [];
			return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }];
		}
		case "tool_execution_start":
			return [{
				sessionUpdate: "tool_call",
				toolCallId: String(event.toolCallId),
				title: `${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`,
				name: event.toolName,
				kind: toolKind(event.toolName),
				status: "in_progress",
				rawInput: event.args ?? {},
			}];
		case "tool_execution_update": {
			const output = event.output;
			const text = typeof output === "string" ? output : output?.append ?? output?.set;
			if (!text) return [];
			return [{
				sessionUpdate: "tool_call_update",
				toolCallId: String(event.toolCallId),
				content: [{ type: "content", content: { type: "text", text } }],
			}];
		}
		case "tool_execution_end": {
			const result = toolResultMessage(event.entry);
			const isError = result ? result.isError === true : false;
			const text = Array.isArray(event.entry?.model) ? event.entry.model.map(textOfMessage).join(" ").trim() : "";
			return [{
				sessionUpdate: "tool_call_update",
				toolCallId: String(event.toolCallId),
				status: isError ? "failed" : "completed",
				content: text ? [{ type: "content", content: { type: "text", text } }] : [],
			}];
		}
		default:
			return []; // run_start/turn_start/usage/retries are daemon-internal; the prompt response carries the settle
	}
}

/** Snapshot entry → replay updates (session/load tells the client what already happened). */
export function entryToReplayUpdates(entry) {
	switch (entry?.kind) {
		case "pi.user": {
			const messages = Array.isArray(entry.model) ? entry.model : [];
			const text = messages.map(textOfMessage).join(" ").trim();
			return text ? [{ sessionUpdate: "user_message_chunk", content: { type: "text", text } }] : [];
		}
		case "pi.assistant": {
			const updates = [];
			const messages = Array.isArray(entry.model) ? entry.model : [];
			for (const m of messages) {
				if (!Array.isArray(m?.content)) continue;
				for (const block of m.content) {
					if (block?.type === "toolCall") {
						updates.push({
							sessionUpdate: "tool_call",
							toolCallId: String(block.id ?? `replay-${updates.length}`),
							title: `${block.name} ${JSON.stringify(block.arguments ?? {}).slice(0, 200)}`,
							name: block.name,
							kind: toolKind(block.name),
							status: "completed",
						});
					}
				}
			}
			const text = assistantTextOf(entry);
			if (text) updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
			return updates;
		}
		case "pi.tool-result": {
			const result = toolResultMessage(entry);
			if (!result) return [];
			const text = textOfMessage(result);
			return [{
				sessionUpdate: "tool_call_update",
				toolCallId: String(result.toolCallId ?? "unknown"),
				status: result.isError ? "failed" : "completed",
				content: text ? [{ type: "content", content: { type: "text", text } }] : [],
			}];
		}
		default:
			return []; // system/reset/compaction entries are the agent's bookkeeping
	}
}

/**
 * Run the ACP endpoint over stdio until stdin closes. The caller (cli.js `acp`)
 * has already checked the daemon is up and printed its own diagnostics.
 */
export async function startAcpAgent() {
	const client = await DaemonClient.connect();

	// sessionId ↔ durable conversation id: the conversation id IS the session id.
	const sessions = new Map(); // sessionId(string conversationId) → { sawDelta }

	function toConversationId(sessionId) {
		return /^\d+$/.test(String(sessionId)) ? Number(sessionId) : sessionId; // durable ids are integers
	}

	function requireSession(sessionId) {
		if (!sessions.has(String(sessionId))) throw new Error(`unknown session "${sessionId}" — create it with session/new or load it with session/load`);
		return toConversationId(sessionId);
	}

	async function sendUpdates(conn, sessionId, updates) {
		for (const update of updates) {
			await conn.client.notify(acp.methods.client.session.update, { sessionId, update });
		}
	}

	/** The guard wants a decision: turn the daemon's permission push into a real ACP permission round-trip. */
	async function handlePermission(conn, message) {
		const sessionId = String(message.conversationId);
		const toolCall = {
			toolCallId: String(message.requestId),
			title: `${message.toolName} ${JSON.stringify(message.args ?? {}).slice(0, 200)}`,
			name: message.toolName,
			kind: toolKind(message.toolName),
			status: "pending",
			rawInput: message.args ?? {},
		};
		await conn.client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "tool_call", ...toolCall } });
		let response;
		try {
			response = await conn.client.request(acp.methods.client.session.requestPermission, {
				sessionId,
				toolCall,
				options: [
					{ optionId: "allow_once", name: "Allow this command once", kind: "allow_once" },
					{ optionId: "allow_always", name: "Always allow this exact command for this session", kind: "allow_always" },
					{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
				],
			});
		} catch {
			// the client hung up mid-request: treat it as a rejection so the run does not hang
			await client.request("permissions.decide", { requestId: message.requestId, approved: false, reason: "the permission request failed" }).catch(() => {});
			return;
		}
		const outcome = response?.outcome;
		if (outcome?.outcome === "cancelled") {
			await client.request("permissions.decide", { requestId: message.requestId, approved: false, reason: "cancelled" });
			return;
		}
		const optionId = outcome?.optionId;
		if (optionId === "allow_once" || optionId === "allow_always") {
			if (optionId === "allow_always") {
				// allow_always = the deterministic allow list: every later call passes without asking.
				await client.request("allow", { conversationId: message.conversationId, command: message.command }).catch(() => {});
			}
			await client.request("permissions.decide", { requestId: message.requestId, approved: true });
		} else {
			await client.request("permissions.decide", { requestId: message.requestId, approved: false, reason: "the client rejected the call" });
		}
	}

	const app = acp.agent(AGENT_INFO);

	app.onRequest("initialize", () => ({
		protocolVersion: acp.PROTOCOL_VERSION,
		agentCapabilities: {
			loadSession: true,
			promptCapabilities: { image: false, audio: false, embeddedContext: false },
			sessionCapabilities: { list: true },
		},
		agentInfo: AGENT_INFO,
	}));

	app.onRequest("authenticate", () => ({})); // no authMethods advertised, so a client should never call this

	app.onRequest("session/new", async () => {
		const opened = await client.request("open", {});
		const sessionId = String(opened.conversationId);
		await client.request("subscribe", { conversationId: opened.conversationId });
		await client.request("permissions.listen", { conversationId: opened.conversationId });
		sessions.set(sessionId, { sawDelta: false });
		return { sessionId };
	});

	app.onRequest("session/load", async (cx) => {
		const sessionId = String(cx.params.sessionId);
		const conversationId = toConversationId(sessionId); // any durable conversation id may be loaded
		await client.request("open", { conversationId });
		const { snapshot } = await client.request("subscribe", { conversationId });
		await client.request("permissions.listen", { conversationId });
		sessions.set(sessionId, { sawDelta: false });
		for (const entry of snapshot?.entries ?? []) {
			await sendUpdates(cx.client, sessionId, entryToReplayUpdates(entry));
		}
		return {};
	});

	app.onRequest("session/list", async () => {
		const { conversations } = await client.request("sessions", {});
		return {
			sessions: conversations.map((row) => ({
				sessionId: String(row.id),
				cwd: process.cwd(), // every tool runs in the daemon's working directory
				title: row.note || `conversation ${row.id} (${row.entries} entries)`,
				updatedAt: null, // the daemon's session rows carry entry ids, not timestamps
			})),
		};
	});

	app.onRequest("session/prompt", async (cx) => {
		const { sessionId } = cx.params;
		const conversationId = requireSession(sessionId);
		const prompt = promptText(cx.params.prompt);
		if (!prompt) throw new Error("the prompt carried no text this agent can read");
		// The run settles inside the daemon; while it is in flight this endpoint's
		// subscription turns durable's events into session/update notifications.
		const settled = await client.request("run", { conversationId, prompt });
		return { stopReason: stopReasonFor(settled) };
	});

	app.onNotification("session/cancel", async (cx) => {
		const conversationId = requireSession(cx.params.sessionId);
		await client.request("cancel", { conversationId }).catch(() => {});
	});

	// Fan durable's pushed events out to the ACP client, and answer permission
	// pushes with a real session/request_permission round-trip. The connection's
	// client context is valid outside request handlers — that is the point.
	app.onConnect((connection) => {
		client.onEvent((message) => {
			if (message.event === "permission") {
				handlePermission(connection, message).catch((error) => console.error(`[acp] permission round-trip failed: ${error?.message ?? error}`));
				return;
			}
			if (message.event !== "events") return;
			const sessionId = String(message.conversationId);
			const state = sessions.get(sessionId);
			if (!state) return; // not ours (a CLI attach also sees nothing; this endpoint only mirrors its own sessions)
			(async () => {
				for (const event of message.events ?? []) {
					await sendUpdates(connection, sessionId, eventToUpdates(event, state));
				}
			})().catch((error) => console.error(`[acp] forwarding events failed: ${error?.message ?? error}`));
		});
	});

	const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
	app.connect(stream);

	process.stdin.on("end", () => {
		client.close();
		process.exit(0);
	});

	return { endpoint: "stdio", daemon: daemonEndpoint() };
}

export { DaemonUnavailableError };
