#!/usr/bin/env node
// cli.js — headless durable agent over the owner's OmniRoute gateway.
//
// One shared database (.data/sessions.sqlite) keeps every CLI conversation, so
// continuity is visible across process invocations. The proofs keep their own
// one-database-per-proof behaviour.
//
// Two ways to touch that database:
//   • the DAEMON (`serve`) owns it and serves live events over a local
//     endpoint; several client processes connect at once (attach/send/…);
//   • the direct commands (run/resume/fork/…) open it in this process, and
//     refuse with an actionable message when a daemon already owns it — one
//     process owns the storage at a time.
//
// Usage:
//   node cli.js serve [--no-mcp] [--no-guard]           become the owner; serve local clients
//   node cli.js run "<prompt>" [--agent <name>]         NEW conversation, owned by THIS process
//   node cli.js sessions                                list conversations (daemon first, direct fallback)
//   node cli.js resume <conversationId> "<prompt>"      continue an existing conversation (direct)
//   node cli.js fork <conversationId> "<prompt>"        fork at the newest entry (direct)
//   node cli.js send [id] "<prompt>" [--agent <name>]   run a prompt THROUGH the daemon
//   node cli.js attach <conversationId>                 live events from the daemon, Ctrl+C to detach
//   node cli.js allow <conversationId> "<exact command>"  guard opt-in (daemon first, direct fallback)
//   node cli.js acp                                      speak ACP v1 over stdio (an editor's entry point)
//
// The answer streams to stdout; tool activity and diagnostics go to stderr, so
// `node cli.js run "..." > answer.txt` captures just the answer.
import { CTX, SHARED_DB, listConversations, openHarness, sleepMs } from "./lib/common.js";
import { allowCommand, makeGuardExtension, normalizeCommand } from "./lib/guard.js";
import { loadSkills, makeSkillsExtension } from "./lib/skills.js";
import { loadAgents, resolveAgentChange } from "./lib/agents.js";
import { DURABLE_KEYS, parseModelSetting, printDurableOptions, resolveDurableOptions } from "./lib/settings.js";
import { DEFAULT_PROFILE_DIR } from "./lib/profile.js";
import { armMcpFilter, closeMcpConnections, connectBridge, NO_BRIDGE } from "./lib/mcp.js";
import { makeRunRenderer, makeAttachRenderer } from "./lib/render.js";
import { DaemonClient, DaemonUnavailableError, daemonIsUp } from "./lib/client.js";
import { daemonEndpoint } from "./lib/protocol.js";
import { startDaemon } from "./lib/daemon.js";
import { startAcpAgent } from "./lib/acp.js";
import { watchEvents } from "@earendil-works/pi-durable";

// --- argument parsing -----------------------------------------------------------

function usage() {
	console.error(`Usage:
  node cli.js serve [--no-mcp] [--no-guard]           own ${SHARED_DB} and serve local clients (Ctrl+C to stop)
  node cli.js stop                                    ask the daemon to shut down gracefully
  node cli.js run "<prompt>" [--agent <name>] [--model provider/model] [--no-mcp] [--no-guard]
  node cli.js sessions                               list conversations (through the daemon when it is up)
  node cli.js resume <id> "<prompt>" [--agent <name>] [--model provider/model] [--no-mcp] [--no-guard]
  node cli.js fork <id> "<prompt>" [--agent <name>] [--model provider/model] [--no-mcp] [--no-guard]
  node cli.js send [id] "<prompt>" [--agent <name>] [--model provider/model]   run a prompt through the daemon
  node cli.js attach <id>                            live events from the daemon, Ctrl+C to detach
  node cli.js allow <id> "<exact command>"           let the guard pass this exact command
  node cli.js acp                                    speak ACP v1 over stdio (requires a running daemon)

Options also come from PiCode's settings (picode.durable.*) when the flags are not given:
  picode.durable.mcp / .guard / .model / .agent — flag > setting > default.
  --no-mcp / --no-guard are daemon-level choices: the daemon decides them once at startup
  (node cli.js serve --no-mcp); send/attach run whatever the running daemon offers.`);
}

function parseArgs(argv) {
	const positional = [];
	let agent;
	let mcp = true;
	let noGuard = false;
	let model;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--agent") {
			agent = argv[++i];
			if (!agent) throw new Error("--agent requires a name");
		} else if (argv[i].startsWith("--agent=")) {
			agent = argv[i].slice("--agent=".length);
		} else if (argv[i] === "--no-mcp") {
			mcp = false;
		} else if (argv[i] === "--no-guard") {
			noGuard = true;
		} else if (argv[i] === "--model") {
			model = argv[++i];
			if (!model) throw new Error("--model requires provider/model, for example omni/auto");
		} else if (argv[i].startsWith("--model=")) {
			model = argv[i].slice("--model=".length);
		} else {
			positional.push(argv[i]);
		}
	}
	return { positional, agent, mcp, noGuard, model };
}

// --- shared setup (the direct, in-process owner) ---------------------------------

async function openCliHarness(bridge = NO_BRIDGE, guardEnabled = true) {
	// Extensions read the profile once at startup; the profile itself stays read-only.
	const skills = loadSkills(DEFAULT_PROFILE_DIR);
	const extensions = [makeGuardExtension({ enabled: guardEnabled }), makeSkillsExtension(skills)];
	if (bridge.extension) extensions.push(bridge.extension);
	return { ...(await openHarness({ db: SHARED_DB, extensions })), skills, bridge };
}

// --- streaming -------------------------------------------------------------------

/**
 * Attach an event stream, submit `prompt`, wait for the run to settle.
 * Text deltas → stdout; tools, guard blocks, retries → stderr (lib/render.js).
 * The OmniRoute gateway answers in whole messages, so an assistant message that
 * never streamed deltas is printed complete from its message_end event.
 */
async function runPrompt(harness, conversation, prompt) {
	const renderer = makeRunRenderer();
	const stream = await watchEvents(harness, conversation.id, CTX);
	await stream.start(async (events) => {
		for (const event of events) renderer.onEvent(event);
	});
	const submission = await conversation.submit({ type: "input", content: prompt }, CTX);
	const settled = await submission.wait(CTX);
	// Let the last committed event batches drain before detaching (same pattern as proof3).
	await sleepMs(1500);
	await stream.stop();
	if (renderer.wroteText) process.stdout.write("\n");
	return { settled, guardBlocks: renderer.guardBlocks };
}

function exitOnUnsettled(status) {
	if (status !== "done") {
		console.error(`\nrun did not settle: ${status}`);
		process.exitCode = 1;
	}
}

function printGuardBlocks(guardBlocks) {
	if (guardBlocks > 0) console.error(`[guard] ${guardBlocks} tool call(s) blocked — see the tool results above.`);
}

// --- direct commands (this process owns the storage) ------------------------------

async function cmdRun(args, agents, options) {
	const agentChange = resolveAgentChange(agents, options.agent?.value, DEFAULT_PROFILE_DIR);
	const bridge = await connectBridge(options.mcp.value, DEFAULT_PROFILE_DIR);
	const { harness } = await openCliHarness(bridge, options.guard.value);
	try {
		const model = parseModelSetting(options.model.value); // "provider/model" — validated at resolve time
		const agent = { model, ...(agentChange ?? {}) };
		if (bridge.filter) {
			// The deferral: every MCP tool is filtered out of the prompt; the discovery tool
			// brings one back when the model finds it.
			agent.tools = bridge.filter;
		}
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, CTX);
		console.error(`[conversation] ${conversation.id}`);
		const { settled, guardBlocks } = await runPrompt(harness, conversation, args.prompt);
		exitOnUnsettled(settled.status);
		printGuardBlocks(guardBlocks);
		console.error(`[hint] resume with: node cli.js resume ${conversation.id} "<prompt>"`);
	} finally {
		await harness.close(CTX);
		await closeMcpConnections(bridge.connections);
	}
}

async function openConversation(harness, id) {
	const conversation = await harness.conversation(id, CTX);
	if (!conversation) throw new Error(`No conversation "${id}" in ${SHARED_DB} — run \`node cli.js sessions\` to list ids.`);
	return conversation;
}

async function cmdResume(args, agents, options) {
	const agentChange = resolveAgentChange(agents, options.agent?.value, DEFAULT_PROFILE_DIR);
	const bridge = await connectBridge(options.mcp.value, DEFAULT_PROFILE_DIR);
	const { harness } = await openCliHarness(bridge, options.guard.value);
	try {
		const conversation = await openConversation(harness, args.positional[0]);
		if (agentChange) await conversation.configure(agentChange, CTX);
		await armMcpFilter(harness, conversation, bridge, CTX);
		const { settled, guardBlocks } = await runPrompt(harness, conversation, args.prompt);
		exitOnUnsettled(settled.status);
		printGuardBlocks(guardBlocks);
	} finally {
		await harness.close(CTX);
		await closeMcpConnections(bridge.connections);
	}
}

async function cmdFork(args, agents, options) {
	const agentChange = resolveAgentChange(agents, options.agent?.value, DEFAULT_PROFILE_DIR);
	const bridge = await connectBridge(options.mcp.value, DEFAULT_PROFILE_DIR);
	const { harness } = await openCliHarness(bridge, options.guard.value);
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
		exitOnUnsettled(settled.status);
		printGuardBlocks(guardBlocks);
	} finally {
		await harness.close(CTX);
		await closeMcpConnections(bridge.connections);
	}
}

async function cmdAllowDirect(args) {
	const command = normalizeCommand(args.prompt);
	if (!command) throw new Error('allow requires the exact command, quoted: node cli.js allow <id> "rm -rf build"');
	const { harness } = await openCliHarness();
	const conversation = await openConversation(harness, args.positional[0]);
	const allowed = await allowCommand(harness, conversation, command, CTX);
	console.error(`[guard] allowed for ${conversation.id}:`);
	for (const entry of allowed) console.log(`  ${entry}`);
	await harness.close(CTX);
}

// --- daemon commands (the daemon owns the storage; this process is a client) ------

function printSessions(conversations, where) {
	console.error(`${conversations.length} conversation(s) in ${SHARED_DB} (${where})`);
	console.log("id\tentries\tlast activity\tnote");
	for (const row of conversations) {
		console.log(`${row.id}\t${row.entries}\t${row.newest}\t${row.note}`);
	}
}

async function cmdServe(resolved) {
	await startDaemon(resolved);
	// The daemon serves until `shutdown` or Ctrl+C; keep the process alive.
	await new Promise(() => {});
}

async function cmdSend(args) {
	const parts = args.positional;
	let conversationId;
	let prompt;
	if (parts.length >= 2) {
		conversationId = /^\d+$/.test(parts[0]) ? Number(parts[0]) : parts[0]; // ids are integers in this storage
		prompt = parts[1];
	} else {
		prompt = parts[0];
	}
	if (!prompt) throw new Error('send requires a prompt: node cli.js send [id] "<prompt>"');

	const client = await DaemonClient.connect();
	try {
		console.error(`[send] through the daemon at ${daemonEndpoint()}`);
		if (conversationId === undefined) {
			const opened = await client.request("open", { model: args.model, agent: args.agent });
			conversationId = opened.conversationId;
		}
		console.error(`[conversation] ${conversationId}`);
		const renderer = makeRunRenderer();
		client.onEvent((message) => {
			if (message.event !== "events" || message.conversationId !== conversationId) return;
			for (const event of message.events ?? []) renderer.onEvent(event);
		});
		await client.request("subscribe", { conversationId });
		const result = await client.request("run", { conversationId, prompt, model: args.model, agent: args.agent });
		if (renderer.wroteText) process.stdout.write("\n");
		exitOnUnsettled(result.status);
		printGuardBlocks(renderer.guardBlocks);
		console.error(`[hint] continue through the daemon with: node cli.js send ${conversationId} "<prompt>"`);
	} finally {
		client.close();
	}
}

async function cmdAttach(args) {
	const raw = args.positional[0];
	const conversationId = /^\d+$/.test(raw) ? Number(raw) : raw; // ids are integers in this storage
	const client = await DaemonClient.connect();
	console.error(`[attach] ${conversationId} — live events from the daemon at ${daemonEndpoint()}; Ctrl+C to detach.`);
	const renderer = makeAttachRenderer();
	client.onEvent((message) => {
		if (message.event === "closed") {
			console.error(`[attach] the daemon closed the connection — it was stopped or restarted.`);
			process.exitCode = 1;
			return;
		}
		if (message.conversationId !== conversationId) return;
		if (message.event === "snapshot") renderer.onEvent({ type: "snapshot", entries: message.snapshot?.entries ?? [] });
		else if (message.event === "events") for (const event of message.events ?? []) renderer.onEvent(event);
	});
	// subscribe's response carries the conversation's snapshot; events follow live.
	const { snapshot } = await client.request("subscribe", { conversationId });
	renderer.onEvent({ type: "snapshot", entries: snapshot?.entries ?? [] });
	process.on("SIGINT", () => {
		client.close();
		process.exit(0);
	});
	await new Promise(() => {}); // attached until Ctrl+C or the daemon goes away
}

async function cmdSessions() {
	if (await daemonIsUp()) {
		// The daemon owns the storage; read through it (never open a second harness).
		const client = await DaemonClient.connect();
		try {
			const { conversations } = await client.request("sessions", {});
			printSessions(conversations, `via daemon at ${daemonEndpoint()}`);
		} finally {
			client.close();
		}
		return;
	}
	// No daemon: nobody owns the storage, so this process may open it read-style.
	console.error(`[sessions] no daemon running — reading ${SHARED_DB} directly.`);
	const { harness, storage } = await openCliHarness();
	printSessions(await listConversations(harness, storage), `direct`);
	await harness.close(CTX);
}

async function cmdAllow(args) {
	const command = normalizeCommand(args.prompt);
	if (!command) throw new Error('allow requires the exact command, quoted: node cli.js allow <id> "rm -rf build"');
	if (await daemonIsUp()) {
		// A write: it must go through the owner (the daemon), never a second harness.
		const client = await DaemonClient.connect();
		try {
			const { allowed } = await client.request("allow", { conversationId: args.positional[0], command });
			console.error(`[guard] allowed for ${args.positional[0]} (via daemon):`);
			for (const entry of allowed) console.log(`  ${entry}`);
		} finally {
			client.close();
		}
		return;
	}
	await cmdAllowDirect(args);
}

/** Ask the running daemon to shut down gracefully (streams closed, storage checkpointed). */
async function cmdStop() {
	const client = await DaemonClient.connect();
	try {
		await client.request("shutdown", {});
		console.error(`[daemon] stopping — ${daemonEndpoint()}`);
	} finally {
		client.close();
	}
}

/**
 * The ACP entry point: speak the Agent Client Protocol (v1) over stdio, mapped
 * onto the daemon. stdout carries ONLY ACP messages; diagnostics go to stderr.
 * This process is a client of the daemon — never a second owner of the storage.
 */
async function cmdAcp() {
	if (!(await daemonIsUp())) {
		console.error(`error: no durable daemon is running at ${daemonEndpoint()} — start it with: node cli.js serve. The ACP endpoint is a client of the daemon, never a second owner of ${SHARED_DB}.`);
		process.exitCode = 1;
		return;
	}
	console.error(`[acp] ${SHARED_DB} durable agent speaking ACP v1 over stdio (daemon at ${daemonEndpoint()})`);
	await startAcpAgent();
}

/** The one-owner rule, said in a sentence a human can act on (not a raw SQLite error). */
async function refuseWhileDaemonOwns(command, positional) {
	if (!(await daemonIsUp())) return false;
	console.error(`error: the durable daemon already owns ${SHARED_DB} — one process owns the storage at a time.
Run the prompt through the daemon instead:
  node cli.js send ${positional ? `${positional} ` : ""}"<prompt>"        (or attach: node cli.js attach <id>)
Or stop the daemon (Ctrl+C on its terminal) to run the agent in this process again.`);
	process.exitCode = 1;
	return true;
}

// --- main ------------------------------------------------------------------------

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

// PiCode's settings are the home of these options (Part B lives in the editor);
// this program reads the file read-only and applies flag > setting > default.
// The [settings] lines print for the commands that actually run the agent —
// including `serve`, which runs every conversation from now on.
const RUNS_AGENT = command === "run" || command === "resume" || command === "fork" || command === "serve";
const resolved = resolveDurableOptions({
	flags: { mcp: args.mcp === false ? false : undefined, guard: args.noGuard ? false : undefined, model: args.model, agent: args.agent },
});
if (RUNS_AGENT) printDurableOptions(resolved);
// Register the provider the model names: loadOmniProvider reads PI_AGENT_PROVIDER
// when the harness opens. Only a flag or a setting may move it off the env value.
if (RUNS_AGENT && (resolved.options.model.source === "flag" || resolved.options.model.source === DURABLE_KEYS.model)) {
	process.env.PI_AGENT_PROVIDER = parseModelSetting(resolved.options.model.value).provider;
}

try {
	switch (command) {
		case "serve":
			await cmdServe(resolved);
			break;
		case "run":
			args.prompt = args.positional[0];
			if (!args.prompt) throw new Error('run requires a prompt: node cli.js run "<prompt>"');
			if (await refuseWhileDaemonOwns("run")) break;
			await cmdRun(args, loadAgents(DEFAULT_PROFILE_DIR), resolved.options);
			break;
		case "sessions":
			await cmdSessions();
			break;
		case "resume":
			args.prompt = args.positional[1];
			if (!args.positional[0] || !args.prompt) throw new Error('resume requires <id> and "<prompt>"');
			if (await refuseWhileDaemonOwns("resume", args.positional[0])) break;
			await cmdResume(args, loadAgents(DEFAULT_PROFILE_DIR), resolved.options);
			break;
		case "fork":
			args.prompt = args.positional[1];
			if (!args.positional[0] || !args.prompt) throw new Error('fork requires <id> and "<prompt>"');
			if (await refuseWhileDaemonOwns("fork", args.positional[0])) break;
			await cmdFork(args, loadAgents(DEFAULT_PROFILE_DIR), resolved.options);
			break;
		case "send":
			await cmdSend(args);
			break;
		case "stop":
			await cmdStop();
			break;
		case "acp":
			await cmdAcp();
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
	if (error instanceof DaemonUnavailableError) {
		console.error(`error: ${error.message}`);
	} else {
		console.error(`error: ${error?.message ?? error}`);
	}
	process.exitCode = 1;
}
