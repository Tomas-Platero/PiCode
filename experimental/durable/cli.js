#!/usr/bin/env node
// cli.js — headless durable agent over the owner's OmniRoute gateway.
//
// One shared database (.data/sessions.sqlite) keeps every CLI conversation, so
// continuity is visible across process invocations. The proofs keep their own
// one-database-per-proof behaviour.
//
// Usage:
//   node cli.js run "<prompt>" [--agent <name>]
//   node cli.js sessions
//   node cli.js resume <conversationId> "<prompt>" [--agent <name>]
//   node cli.js fork <conversationId> "<prompt>" [--agent <name>]
//   node cli.js attach <conversationId>
//   node cli.js allow <conversationId> "<exact command>"   # guard opt-in
//
// The answer streams to stdout; tool activity and diagnostics go to stderr, so
// `node cli.js run "..." > answer.txt` captures just the answer.
import { CTX, MODEL, openHarness, sleepMs } from "./lib/common.js";
import { GuardDoc, makeGuardExtension, normalizeCommand } from "./lib/guard.js";
import { loadSkills, makeSkillsExtension } from "./lib/skills.js";
import { agentsDir, loadAgents } from "./lib/agents.js";
import { DEFAULT_PROFILE_DIR } from "./lib/profile.js";
import { closeMcpConnections, connectMcpServers, loadMcpConfig, makeMcpExtension, mcpPromptCost, mcpRemoveFilter } from "./lib/mcp.js";
import { AgentDoc, watchEvents } from "@earendil-works/pi-durable";

const DB = "sessions.sqlite"; // the ONE shared CLI database — never numbered, never per-run

// --- argument parsing -----------------------------------------------------------

function usage() {
	console.error(`Usage:
  node cli.js run "<prompt>" [--agent <name>] [--no-mcp]   new conversation, stream the answer
  node cli.js sessions                               list conversations in the shared database
  node cli.js resume <id> "<prompt>" [--agent <name>] [--no-mcp]
  node cli.js fork <id> "<prompt>" [--agent <name>] [--no-mcp]  fork, then run the prompt on the fork
  node cli.js attach <id>                            live event stream until Ctrl+C
  node cli.js allow <id> "<exact command>"           let the guard pass this exact command`);
}

function parseArgs(argv) {
	const positional = [];
	let agent;
	let mcp = true;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--agent") {
			agent = argv[++i];
			if (!agent) throw new Error("--agent requires a name");
		} else if (argv[i].startsWith("--agent=")) {
			agent = argv[i].slice("--agent=".length);
		} else if (argv[i] === "--no-mcp") {
			mcp = false;
		} else {
			positional.push(argv[i]);
		}
	}
	return { positional, agent, mcp };
}

// --- shared setup ----------------------------------------------------------------

async function openCliHarness(bridge = NO_BRIDGE) {
	// Extensions read the profile once at startup; the profile itself stays read-only.
	const skills = loadSkills(DEFAULT_PROFILE_DIR);
	const extensions = [makeGuardExtension(), makeSkillsExtension(skills)];
	if (bridge.extension) extensions.push(bridge.extension);
	return { ...(await openHarness({ db: DB, extensions })), skills, bridge };
}

const NO_BRIDGE = { connections: [], extension: undefined, filter: undefined };

/**
 * Connects the profile's MCP servers and reports what it found, one line per server.
 *
 * The tools are registered but kept OUT of the conversation (`filter`), so what reaches the
 * prompt is the small discovery tool and not three hundred schemas. The cost line below is
 * printed for both ways round: the experiment's whole claim about size is that number.
 */
async function connectBridge(enabled) {
	if (!enabled) {
		console.error("[mcp] disabled (--no-mcp): the agent runs without MCP tools.");
		return NO_BRIDGE;
	}
	const config = loadMcpConfig(DEFAULT_PROFILE_DIR);
	if (config.servers.size === 0) {
		console.error("[mcp] no servers configured");
		return NO_BRIDGE;
	}
	console.error(`[mcp] ${config.servers.size} server(s) configured (${config.sources.join(", ")})`);
	const connections = await connectMcpServers(config.servers);
	for (const connection of connections) {
		console.error(connection.status === "connected"
			? `[mcp] ${connection.name}: connected, ${connection.tools.length} tools`
			: `[mcp] ${connection.name}: NOT CONNECTED (${connection.error})`);
	}
	const cost = mcpPromptCost(connections);
	const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
	console.error(`[mcp] prompt cost: all ${cost.toolCount} tool(s) declared ≈ ${kib(cost.declaredBytes)}; deferred ≈ ${kib(cost.deferredBytes)}`);
	return {
		connections,
		extension: cost.toolCount > 0 ? makeMcpExtension(connections) : undefined,
		filter: mcpRemoveFilter(connections),
	};
}

/**
 * Arms the deferral on a conversation that already exists.
 *
 * Only when the conversation has no tool filter of its own: re-arming one that already
 * discovered tools would throw that discovery away and make the model search again.
 */
async function armMcpFilter(harness, conversation, bridge) {
	if (!bridge.filter) return;
	const state = await harness.snapshot(AgentDoc, conversation.id, CTX);
	if (state?.tools == null) {
		await conversation.configure({ tools: bridge.filter }, CTX);
	}
}

function resolveAgentChange(agents, agentName) {
	if (!agentName) return undefined;
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const known = agents.map((a) => a.name).join(", ") || "(none)";
		throw new Error(`No agent "${agentName}" in ${agentsDir(DEFAULT_PROFILE_DIR)}. Available: ${known}`);
	}
	console.error(`[agent] ${agent.name}${agent.description ? ` — ${agent.description.slice(0, 120)}` : ""}`);
	return { instructions: agent.instructions };
}

/** Conversation and entry ids are session-assigned integers in this storage. */
function describeNewest(entry) {
	return entry ? `entry ${entry.id} (${entry.kind})` : "never";
}

// --- streaming -------------------------------------------------------------------

function printEventLine(line) {
	process.stderr.write(`${line}\n`);
}

function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b?.type === "text").map((b) => b.text).join("");
}

/**
 * Attach an event stream, submit `prompt`, wait for the run to settle.
 * Text deltas → stdout; tools, guard blocks, retries → stderr.
 * The OmniRoute gateway answers in whole messages, so an assistant message that
 * never streamed deltas is printed complete from its message_end event.
 */
async function runPrompt(harness, conversation, prompt) {
	const stream = await watchEvents(harness, conversation.id, CTX);
	let wroteText = false;
	let sawDelta = false;
	let guardBlocks = 0;
	await stream.start(async (events) => {
		for (const e of events) {
			switch (e.type) {
				case "message_start":
					sawDelta = false;
					break;
				case "message_update":
					for (const change of e.changes ?? []) {
						if (change.type === "text_delta") {
							process.stdout.write(change.delta);
							wroteText = true;
							sawDelta = true;
						}
					}
					break;
				case "message_end": {
					// message_end carries the entry; its model messages hold the assistant text.
					const message = e.message ?? e.entry?.model?.find((m) => m.role === "assistant");
					const text = messageText(message).trim();
					if (!sawDelta && text && message?.role === "assistant") {
						process.stdout.write(text);
						wroteText = true;
					}
					break;
				}
				case "tool_execution_start":
					printEventLine(`\n[tool] ${e.toolName} ${JSON.stringify(e.args).slice(0, 200)}`);
					break;
				case "tool_execution_end": {
					const result = (e.entry?.model ?? []).map((m) =>
						(typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.filter((b) => b?.type === "text").map((b) => b.text).join("") : ""),
					).join(" ").trim();
					if (result) printEventLine(`[tool result] ${result.slice(0, 500)}`);
					if (result.startsWith("Blocked by the deterministic guard")) guardBlocks++;
					break;
				}
				case "auto_retry_start":
					printEventLine(`[retry ${e.attempt}] ${e.errorMessage?.slice(0, 200)}`);
					break;
				case "run_end":
					printEventLine(`\n[run settled]`);
					break;
			}
		}
	});

	const submission = await conversation.submit({ type: "input", content: prompt }, CTX);
	const settled = await submission.wait(CTX);
	// Let the last committed event batches drain before detaching (same pattern as proof3).
	await sleepMs(1500);
	await stream.stop();
	if (wroteText) process.stdout.write("\n");
	return { settled, guardBlocks };
}

function exitOnUnsettled(settled) {
	if (settled.status !== "done") {
		console.error(`\nrun did not settle: ${settled.status}${settled.reason ? ` (${JSON.stringify(settled.reason)})` : ""}`);
		process.exitCode = 1;
	}
}

// --- commands --------------------------------------------------------------------

async function cmdRun(args, agents) {
	const agentChange = resolveAgentChange(agents, args.agent);
	const bridge = await connectBridge(args.mcp !== false);
	const { harness } = await openCliHarness(bridge);
	try {
		const agent = { model: MODEL, ...(agentChange ?? {}) };
		if (bridge.filter) {
			// The deferral: every MCP tool is filtered out of the prompt; the discovery tool
			// brings one back when the model finds it.
			agent.tools = bridge.filter;
		}
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, CTX);
		console.error(`[conversation] ${conversation.id}`);
		const { settled, guardBlocks } = await runPrompt(harness, conversation, args.prompt);
		exitOnUnsettled(settled);
		if (guardBlocks > 0) console.error(`[guard] ${guardBlocks} tool call(s) blocked — see the tool results above.`);
		console.error(`[hint] resume with: node cli.js resume ${conversation.id} "<prompt>"`);
	} finally {
		await harness.close(CTX);
		await closeMcpConnections(bridge.connections);
	}
}

async function cmdSessions() {
	const { harness, storage } = await openCliHarness();
	// NOTE: the README/spec's Session.scanConversations is not on the runtime
	// Harness; read the storage directly, serialized on the session line.
	const conversations = await harness.readOnLine(async () => {
		const items = [];
		let cursor;
		for (;;) {
			const page = await storage.scanConversations({}, 100, cursor, CTX);
			items.push(...page.items);
			cursor = page.cursor;
			if (!cursor) break;
		}
		return items;
	});
	console.error(`${conversations.length} conversation(s) in ${DB}`);
	console.log("id\tentries\tlast activity\tnote");
	for (const record of conversations) {
		const page = await harness.readOnLine(() => storage.scanEntries({ conversationId: record.id }, 1000, undefined, CTX));
		const newest = page.items[0];
		const note = record.owner ? `subagent (task ${record.owner.taskId})` : record.parent ? `fork of ${record.parent.conversationId}` : "";
		console.log(
			`${record.id}\t${page.items.length}\t${describeNewest(newest)}\t${note}`,
		);
	}
	await harness.close(CTX);
}

async function openConversation(harness, id) {
	const conversation = await harness.conversation(id, CTX);
	if (!conversation) throw new Error(`No conversation "${id}" in ${DB} — run \`node cli.js sessions\` to list ids.`);
	return conversation;
}

async function cmdResume(args, agents) {
	const agentChange = resolveAgentChange(agents, args.agent);
	const bridge = await connectBridge(args.mcp !== false);
	const { harness } = await openCliHarness(bridge);
	try {
		const conversation = await openConversation(harness, args.positional[0]);
		if (agentChange) await conversation.configure(agentChange, CTX);
		await armMcpFilter(harness, conversation, bridge);
		const { settled, guardBlocks } = await runPrompt(harness, conversation, args.prompt);
		exitOnUnsettled(settled);
		if (guardBlocks > 0) console.error(`[guard] ${guardBlocks} tool call(s) blocked — see the tool results above.`);
	} finally {
		await harness.close(CTX);
		await closeMcpConnections(bridge.connections);
	}
}

async function cmdFork(args, agents) {
	const agentChange = resolveAgentChange(agents, args.agent);
	const bridge = await connectBridge(args.mcp !== false);
	const { harness } = await openCliHarness(bridge);
	try {
		const source = await openConversation(harness, args.positional[0]);
		const newest = (await source.entries({}, 1, undefined, CTX)).items[0];
		if (!newest) throw new Error(`Conversation ${source.id} has no entries to fork from.`);
		const forkAgent = { ...(agentChange ?? {}) };
		if (bridge.filter) {
			forkAgent.tools = bridge.filter;
		}
		const forkOptions = { ownership: { kind: "ownerless" } };
		if (Object.keys(forkAgent).length > 0) {
			forkOptions.agent = forkAgent;
		}
		const fork = await source.fork(newest.id, forkOptions, CTX);
		console.error(`[fork] ${source.id} @entry ${newest.id} → ${fork.id}`);
		console.error(`[hint] resume the fork with: node cli.js resume ${fork.id} "<prompt>"`);
		const { settled, guardBlocks } = await runPrompt(harness, fork, args.prompt);
		exitOnUnsettled(settled);
		if (guardBlocks > 0) console.error(`[guard] ${guardBlocks} tool call(s) blocked — see the tool results above.`);
	} finally {
		await harness.close(CTX);
		await closeMcpConnections(bridge.connections);
	}
}

const ENTRY_TEXT = (entry) => (Array.isArray(entry?.model) ? entry.model : []).map((m) =>
	typeof m?.content === "string"
		? m.content
		: Array.isArray(m?.content)
			? m.content.filter((b) => b?.type === "text").map((b) => b.text).join("")
			: "",
).join(" ").replace(/\s+$/, "");

function describeEntry(entry) {
	switch (entry.kind) {
		case "pi.user":
			return `[user] ${ENTRY_TEXT(entry)}`;
		case "pi.assistant": {
			const calls = (entry.model?.[0]?.content ?? []).filter((b) => b?.type === "toolCall").map((b) => `${b.name}(${JSON.stringify(b.arguments).slice(0, 120)})`);
			const text = ENTRY_TEXT(entry);
			return `[assistant]${calls.length ? ` tool calls: ${calls.join("; ")} —` : ""} ${text}`;
		}
		case "pi.tool-result": {
			const result = ENTRY_TEXT(entry);
			return `[tool result] ${result ? result.slice(0, 300) : "(no output)"}`;
		}
		case "pi.system":
			return `[system] prompt sections changed`; // the model-context diff; bodies live in the entry
		case "pi.reset":
			return `[reset] new context starts here`;
		case "pi.compaction":
			return `[compaction] older entries summarized`;
		default:
			return `[${entry.kind}]`;
	}
}

async function cmdAttach(args) {
	const { harness, storage } = await openCliHarness();
	const raw = args.positional[0];
	const conversationId = /^\d+$/.test(raw) ? Number(raw) : raw; // ids are integers in this storage
	const exists = await harness.readOnLine(() => storage.conversation(conversationId, CTX));
	if (!exists) throw new Error(`No conversation "${conversationId}" in ${DB} — run \`node cli.js sessions\` to list ids.`);
	console.error(`[attach] ${conversationId} — streaming committed entries; Ctrl+C to detach.`);

	// NOTE: watchEvents cannot cross processes (one process owns a storage; watches
	// are fed by same-process commits), so attach polls the shared SQLite
	// read-only, once a second, through the session's serialized read line.
	let lastSeen = 0; // entry ids are session-assigned integers
	let stopping = false;
	let waited = 0;
	while (!stopping) {
		await sleepMs(1000);
		waited++;
		if (waited % 30 === 0) printEventLine("[attach] … still attached");
		const page = await harness.readOnLine(() =>
			storage.scanEntries({ conversationId, minEntryId: lastSeen + 1 }, 1000, undefined, CTX));
		for (const entry of page.items.slice().reverse()) {
			if (entry.id > lastSeen) {
				lastSeen = entry.id;
				if (entry.kind === "pi.system") continue; // keep the stream readable
				printEventLine(describeEntry(entry));
			}
		}
	}
	await harness.close(CTX);
}

async function cmdAllow(args) {
	const command = normalizeCommand(args.prompt);
	if (!command) throw new Error('allow requires the exact command, quoted: node cli.js allow <id> "rm -rf build"');
	const { harness } = await openCliHarness();
	const conversation = await openConversation(harness, args.positional[0]);
	await conversation.commit(async (tx) => {
		const doc = await tx.doc(GuardDoc, conversation.id);
		if (!doc.allow.includes(command)) doc.allow.push(command);
	}, CTX);
	const doc = await harness.snapshot(GuardDoc, conversation.id, CTX);
	console.error(`[guard] allowed for ${conversation.id}:`);
	for (const entry of doc?.allow ?? []) console.log(`  ${entry}`);
	await harness.close(CTX);
}

// --- main ------------------------------------------------------------------------

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

try {
	switch (command) {
		case "run":
			args.prompt = args.positional[0];
			if (!args.prompt) throw new Error('run requires a prompt: node cli.js run "<prompt>"');
			await cmdRun(args, loadAgents(DEFAULT_PROFILE_DIR));
			break;
		case "sessions":
			await cmdSessions();
			break;
		case "resume":
			args.prompt = args.positional[1];
			if (!args.positional[0] || !args.prompt) throw new Error('resume requires <id> and "<prompt>"');
			await cmdResume(args, loadAgents(DEFAULT_PROFILE_DIR));
			break;
		case "fork":
			args.prompt = args.positional[1];
			if (!args.positional[0] || !args.prompt) throw new Error('fork requires <id> and "<prompt>"');
			await cmdFork(args, loadAgents(DEFAULT_PROFILE_DIR));
			break;
		case "attach":
			if (!args.positional[0]) throw new Error("attach requires <id>");
			await cmdAttach(args);
			break;
		case "allow":
			args.prompt = args.positional[1];
			if (!args.positional[0] || !args.prompt) throw new Error('allow requires <id> and the "<exact command>"');
			await cmdAllow(args);
			break;
		default:
			usage();
			process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 1;
	}
} catch (error) {
	console.error(`error: ${error?.message ?? error}`);
	process.exitCode = 1;
}
