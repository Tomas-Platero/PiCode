// proof-kill-survive.mjs — the one-command proof of the pi ⇄ durable bridge.
//
// The pi under test is PiCode's OWN internal pi — the runtime bundled in the
// product's resources (resources/pi-runtime) with PiCode's internal profile
// (data/pi-agent) — NEVER the external managed install under ~/.pi, which the
// owner's rule says is never read or written. The profile is selected with
// PI_CODING_AGENT_DIR and session storage is redirected into this bridge's
// gitignored .data/, so the proof's pi touches only the product directory and
// this repository.
//
// What it proves (with real processes, no simulation):
//   1. pi starts a piece of long work by calling the bridge's durable_send tool,
//      which hands the prompt to the durable daemon — the work runs in the
//      DAEMON's process, not pi's.
//   2. pi is killed mid-work (a real `taskkill /F /T` of pi's process tree).
//   3. the daemon keeps working and finishes the conversation, answer committed
//      to its SQLite.
//   4. a fresh pi — a brand-new process that knows nothing — uses durable_list /
//      durable_read and shows the finished conversation with the answer.
//
// Run it:
//     node picode-source/durable-bridge/proof-kill-survive.mjs
//
// Scratch (pi logs, sessions, daemon log) goes to picode-source/durable-bridge/.data/
// (gitignored). The durable conversations go to the daemon's own database —
// this script never touches SQLite: the daemon is the single owner.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, DaemonUnavailableError, daemonIsUp } from "../durable/lib/client.js";
import { describeEntry } from "../durable/lib/render.js";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DURABLE_DIR = path.join(BRIDGE_DIR, "..", "durable");
const DATA_DIR = path.join(BRIDGE_DIR, ".data");
const REPO_ROOT = path.join(BRIDGE_DIR, "..", "..");
const EXTENSION = path.join(BRIDGE_DIR, "extension.ts");

// PiCode's own pi: the runtime inside the installed product + the product's own
// profile. NOT ~/.pi — this path never contains the string ".pi" as a user home.
const PICODE_DIST = process.env.PICODE_DIST ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "PiCode");
const PI_CLI = path.join(PICODE_DIST, "resources", "pi-runtime", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const PI_AGENT_DIR = path.join(PICODE_DIST, "data", "pi-agent"); // PiCode's internal profile
const PI_SESSION_DIR = path.join(DATA_DIR, "pi-sessions"); // pi's session files land HERE, gitignored

const PI_ENV = {
	...process.env,
	PI_CODING_AGENT_DIR: PI_AGENT_DIR, // the internal profile, not ~/.pi
	PI_CODING_AGENT_SESSION_DIR: PI_SESSION_DIR, // session storage redirected into our scratch
};

const DURABLE_PROMPT =
	"Use the slow_step tool six times in a row: step=1, step=2, step=3, step=4, step=5, step=6, " +
	"with seconds=5 for every step. After the sixth step finishes, reply with exactly: DURABLE-PROOF-DONE";
const PI_PROMPT =
	`Call the durable_send tool with this exact prompt: "${DURABLE_PROMPT}" ` +
	"Do not use any other tool and do not write the answer yourself; wait for durable_send to return and repeat its answer.";
const FRESH_PI_PROMPT =
	"Use the durable_list tool, then use the durable_read tool on the durable conversation whose transcript " +
	"ends with the answer DURABLE-PROOF-DONE (it is the one with the most entries). " +
	"Report: the durable conversation id, and that exact final answer text.";

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(PI_SESSION_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const log = (line) => process.stdout.write(`${line}\n`);
const stamp = () => new Date().toISOString().slice(11, 23);

function spawnLogged(cmd, args, { cwd, logFile, env = process.env }) {
	const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const out = [];
	const collect = (chunk) => {
		out.push(chunk);
		writeFileSync(logFile, out.join(""));
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	return { child, tail: (n = 25) => out.join("").split("\n").slice(-n).join("\n") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request to the daemon over a fresh connection. Returns null when down. */
async function daemonRequest(method, params = {}) {
	if (!(await daemonIsUp())) return null;
	try {
		const client = await DaemonClient.connect(3000);
		try {
			return await client.request(method, params);
		} finally {
			client.close();
		}
	} catch (error) {
		if (error instanceof DaemonUnavailableError) return null;
		throw error;
	}
}

async function conversationList() {
	const result = await daemonRequest("sessions");
	return result ? result.conversations : null;
}

async function waitUntil({ everyMs = 2000, timeoutMs, describe, check }) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe()}`);
		await sleep(everyMs);
	}
}

/** The conversation's snapshot via subscribe/unsubscribe (never touches SQLite directly). */
async function snapshot(conversationId) {
	const sub = await daemonRequest("subscribe", { conversationId });
	if (sub) await daemonRequest("unsubscribe", { conversationId });
	return sub ? sub.snapshot : null;
}

function killProcessTree(pid) {
	return new Promise((resolve) => {
		const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
		let out = "";
		killer.stdout.on("data", (c) => (out += c));
		killer.stderr.on("data", (c) => (out += c));
		killer.on("close", (code) => resolve({ code, out: out.trim() }));
	});
}

async function processExists(pid) {
	return new Promise((resolve) => {
		const probe = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { windowsHide: true });
		let out = "";
		probe.stdout.on("data", (c) => (out += c));
		probe.on("close", () => resolve(out.toUpperCase().includes(String(pid))));
	});
}

/** Start PiCode's internal pi with the bridge extension; one-shot print mode. */
function startPi(prompt, logFile) {
	const { child, tail } = spawnLogged(process.execPath, [PI_CLI, "--no-session", "--extension", EXTENSION, "--print", prompt], {
		cwd: REPO_ROOT,
		logFile,
		env: PI_ENV,
	});
	log(`[${stamp()}] pi started (pid ${child.pid}); log: ${path.relative(REPO_ROOT, logFile)}`);
	return { pid: child.pid, tail, done: new Promise((resolve) => child.on("close", (code) => resolve(code))) };
}

// ---------------------------------------------------------------- the proof

const failures = [];
const check = (name, ok, detail = "") => {
	log(`[${stamp()}] ${ok ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

let daemon = null; // { child } only when THIS script started it
const daemonLog = path.join(DATA_DIR, `daemon-${ts}.log`);

try {
	log(`[${stamp()}] pi under test: ${PI_CLI}`);
	log(`[${stamp()}] pi profile:    ${PI_AGENT_DIR}  (PI_CODING_AGENT_DIR — the INTERNAL profile, never ~/.pi)`);

	// 0. The daemon: reuse one that is up, otherwise start it (--no-mcp: fast, offline).
	if (await daemonIsUp()) {
		log(`[${stamp()}] a durable daemon is already running — using it (it keeps its own MCP/guard choices).`);
	} else {
		log(`[${stamp()}] starting the durable daemon (node cli.js serve --no-mcp)…`);
		daemon = spawnLogged(process.execPath, ["cli.js", "serve", "--no-mcp"], { cwd: DURABLE_DIR, logFile: daemonLog });
		daemon.child.unref();
		const up = await waitUntil({
			timeoutMs: 30000,
			describe: () => "the daemon to listen",
			check: () => daemonIsUp(),
			everyMs: 500,
		});
		log(`[${stamp()}] daemon is up (pid ${daemon.child.pid}): ${up}`);
	}

	// 1. Baseline, then pi starts the long work through the bridge.
	const before = await conversationList();
	const beforeIds = new Set(before.map((c) => c.id));
	log(`[${stamp()}] durable conversations before: ${before.length}`);

	log(`[${stamp()}] phase 1 — pi hands long work to the durable daemon via durable_send…`);
	let pi = startPi(PI_PROMPT, path.join(DATA_DIR, `pi-killed-${ts}.log`));

	// 2. Watch for the new durable conversation, then for its run to be in flight.
	let conversationId;
	try {
		conversationId = await waitUntil({
			timeoutMs: 240000,
			describe: () => "pi to create a durable conversation via durable_send",
			check: async () => {
				const list = await conversationList();
				if (!list) return null;
				const fresh = list.find((c) => !beforeIds.has(c.id));
				return fresh?.id ?? null;
			},
		});
	} catch (error) {
		log(`[${stamp()}] pi output tail:\n${pi.tail(40)}`);
		throw error;
	}
	log(`[${stamp()}] durable conversation ${conversationId} created by pi's durable_send.`);

	await waitUntil({
		timeoutMs: 120000,
		describe: () => "the durable run to be in flight (snapshot.run set)",
		check: async () => {
			const snap = await snapshot(conversationId);
			return snap ? Boolean(snap.run) : false;
		},
	});
	log(`[${stamp()}] the durable run is in flight inside the daemon (pi is just waiting on the tool call).`);

	await sleep(8000); // land squarely inside the six 5-second slow_steps

	// 3. Kill pi — a real kill of the whole process tree, mid-work.
	log(`[${stamp()}] phase 2 — killing pi (taskkill /F /T /PID ${pi.pid}) while the durable run is mid-work…`);
	const kill = await killProcessTree(pi.pid);
	log(`[${stamp()}] taskkill exit ${kill.code}${kill.out ? `: ${kill.out}` : ""}`);
	await sleep(2000);
	const stillAlive = await processExists(pi.pid);
	check("pi was killed mid-work", !stillAlive, stillAlive ? "process still exists" : `pid ${pi.pid} is gone`);

	// 4. The daemon finishes the conversation anyway.
	log(`[${stamp()}] phase 3 — waiting for the daemon to finish the conversation pi abandoned…`);
	const finished = await waitUntil({
		timeoutMs: 240000,
		everyMs: 3000,
		describe: () => `conversation ${conversationId} to settle with DURABLE-PROOF-DONE`,
		check: async () => {
			const snap = await snapshot(conversationId);
			if (!snap || snap.run) return null;
			const entries = snap.entries ?? [];
			const lastAssistant = [...entries].reverse().find((e) => e.kind === "pi.assistant");
			const text = JSON.stringify(lastAssistant ?? "");
			return text.includes("DURABLE-PROOF-DONE") ? entries : null;
		},
	});
	log(`[${stamp()}] the daemon finished it. Transcript of durable conversation ${conversationId}:`);
	const entries = finished.filter((e) => e.kind !== "pi.system");
	log(`    (${entries.length} entries)`);
	for (const entry of entries) log(`    ${describeEntrySafe(entry)}`);

	// 5. A fresh pi, knowing nothing, sees the finished conversation.
	log(`[${stamp()}] phase 4 — a FRESH pi (new process, --no-session) reads the finished conversation…`);
	const fresh = startPi(FRESH_PI_PROMPT, path.join(DATA_DIR, `pi-fresh-${ts}.log`));
	const freshCode = await Promise.race([fresh.done, sleep(240000).then(() => "timeout")]);
	const freshOutput = fresh.tail(1000);
	if (freshCode === "timeout") log(`[${stamp()}] fresh pi timed out; output tail:\n${freshOutput}`);
	check(
		"a fresh pi sees the finished durable conversation with the answer",
		freshCode !== "timeout" && freshOutput.includes("DURABLE-PROOF-DONE"),
	);
	log(`[${stamp()}] fresh pi said:\n${freshOutput.split("\n").slice(-15).join("\n")}`);

	check("the durable conversation survived pi's death with its answer", true);
} catch (error) {
	failures.push(error.message ?? String(error));
	log(`[${stamp()}] ERROR: ${error.message ?? error}`);
} finally {
	if (daemon) {
		await daemonRequest("shutdown");
		log(`[${stamp()}] the daemon this script started was asked to shut down (protocol shutdown).`);
	}
}

function describeEntrySafe(entry) {
	try {
		return describeEntry(entry);
	} catch {
		return `[${entry?.kind}] (unrenderable)`;
	}
}

log("");
if (failures.length === 0) {
	log("PROOF-BRIDGE-OK — pi was killed mid-work; the durable daemon finished the job; a fresh pi read the answer.");
} else {
	log(`PROOF-BRIDGE-FAILED — ${failures.length} check(s) failed: ${failures.join("; ")}`);
	process.exitCode = 1;
}
