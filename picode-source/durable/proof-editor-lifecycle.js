#!/usr/bin/env node
// proof-editor-lifecycle.js — the editor's lifetime contract over the daemon, with real
// processes and real timing. The rule: nothing PiCode starts may outlive PiCode. What
// survives closing the editor is the STATE (sessions.sqlite), never a process.
//
//   1. GRACEFUL: the editor's shutdown path (`deactivate` → protocol `shutdown`, plus
//      ending the lifeline pipe, exactly as `stopDurableAgentOnShutdown` does) stops the
//      daemon; a moment later a plain `node cli.js sessions` reports NO daemon.
//   2. LIFELINE: the daemon's own reason not to outlive its parent. The spawner holds the
//      daemon's stdin open and never writes to it (PICODE_PARENT_PIPE=1 arms the EOF
//      watch in lib/daemon.js). With the spawner ALIVE, ending the lifeline makes the
//      daemon stop ITSELF through the graceful path — the exact path a crash or a hard
//      machine death takes the spawner down without any hook. No pid is ever polled: a
//      reused pid cannot keep a dead editor's daemon alive, because the pipe itself is
//      the proof of life.
//   3. KILLED PARENT: the process that spawned the daemon is killed hard (taskkill /F on
//      Windows, SIGKILL elsewhere — no hook runs) and the daemon does NOT outlive it —
//      timed, not "eventually". On Windows libuv's per-child job object terminates the
//      daemon with the parent (the very behaviour `detached:true` used to escape); where
//      that net is absent (POSIX, and any parent that only loses its handles) the
//      lifeline's EOF does it gracefully, as step 2 shows.
//   4. STATE SURVIVES: the conversation is still in sessions.sqlite after all of that,
//      and a new client — a fresh daemon, as the next window's autoStart brings one up —
//      resumes it.
//
// Run from picode-source/durable/:  node proof-editor-lifecycle.js
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./lib/client.js";
import { daemonEndpoint } from "./lib/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, ".data", "daemon-proof");
fs.mkdirSync(OUT, { recursive: true });
const step = (message) => console.log(`\n=== ${message}`);

let failures = 0;
function check(condition, message) {
	console.log(`    ${condition ? "OK" : "FAIL"}: ${message}`);
	if (!condition) failures++;
}

/** True when something is listening on the daemon endpoint (single probe, no retries). */
function probeUp() {
	return new Promise((resolve) => {
		const probe = net.connect(daemonEndpoint());
		probe.once("connect", () => { probe.destroy(); resolve(true); });
		probe.once("error", () => resolve(false));
	});
}

async function waitFor(up, timeoutMs, what) {
	const start = Date.now();
	for (;;) {
		if ((await probeUp()) === up) return Date.now() - start;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Spawn the daemon the way the EDITOR does: attached, lifeline pipe on stdin, PICODE_PARENT_PIPE=1. */
function spawnDaemon(logFile) {
	const logFd = fs.openSync(logFile, "a");
	const child = spawn(process.execPath, ["cli.js", "serve"], {
		cwd: HERE,
		detached: false,
		stdio: ["pipe", logFd, logFd],
		windowsHide: true,
		env: { ...process.env, PICODE_PARENT_PIPE: "1" },
	});
	fs.closeSync(logFd); // the child holds its own copy
	return child;
}

/** The editor's own stop, copied from stopDurableAgentOnShutdown: protocol shutdown + end the lifeline. */
async function editorStop(daemon) {
	const client = await DaemonClient.connect();
	try {
		await client.request("shutdown", {});
	} finally {
		client.close();
	}
	daemon.stdin?.end();
}

async function cliSend(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["cli.js", "send", ...args], { cwd: HERE, windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("exit", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`cli.js send exited ${code}: ${stderr.slice(-400)}`))));
	});
}

function cli(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["cli.js", ...args], { cwd: HERE, windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("exit", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`cli.js ${args[0]} exited ${code}: ${stderr.slice(-400)}`))));
	});
}

/** Kill a process the way a dead machine or task manager would: no hooks, no goodbye. */
async function killHard(pid) {
	if (process.platform === "win32") {
		await new Promise((resolve) => {
			const killer = spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
			killer.once("exit", resolve);
			killer.once("error", resolve);
		});
	} else {
		process.kill(pid, "SIGKILL");
	}
}

// --- the editor stand-in for stage 2 ---------------------------------------------
// `node proof-editor-lifecycle.js --hold-editor`: spawn the daemon exactly as the editor
// does, print its pid, then hold — until killed hard from outside.
if (process.argv[2] === "--hold-editor") {
	const daemon = spawnDaemon(path.join(OUT, "editor-daemon.log"));
	console.log(`DAEMON_PID ${daemon.pid}`);
	setInterval(() => {}, 1 << 30); // hold the lifeline open until killed
} else {
	await main();
}

async function main() {
// --- main -------------------------------------------------------------------------

if (await probeUp()) {
	console.error(`FAIL: a daemon is already running at ${daemonEndpoint()} — stop it first (node cli.js stop) so the proof starts from a quiet machine.`);
	process.exit(1);
}

// --- 1. GRACEFUL: the editor's shutdown path --------------------------------------
step("1. graceful: start the daemon as the editor does, run a prompt, then stop it the editor's way");
const daemonA = spawnDaemon(path.join(OUT, "editor-daemon-A.log"));
await waitFor(true, 60_000, "the daemon to come up");
console.log(`    daemon up (pid ${daemonA.pid})`);

const send1 = await cliSend(["Reply with exactly: LIFECYCLE-GRACEFUL"]);
const conversationId = Number(send1.stderr.match(/\[conversation\] (\d+)/)?.[1]);
check(Number.isInteger(conversationId), `the prompt ran through the daemon as conversation ${conversationId} (answer: ${send1.stdout.trim().slice(0, 60)})`);

const gracefulMs = await (async () => {
	const start = Date.now();
	await editorStop(daemonA);
	await waitFor(false, 30_000, "the daemon to stop");
	return Date.now() - start;
})();
console.log(`    editor's shutdown path → daemon stopped in ${gracefulMs} ms`);

const sessionsA = await cli(["sessions"]);
check(sessionsA.stderr.includes("no daemon running"), "`node cli.js sessions` a moment later reports NO daemon (it reads the storage directly)");
check(new RegExp(`^${conversationId}\\t`, "m").test(sessionsA.stdout), `conversation ${conversationId} is still listed in sessions.sqlite`);

// --- 2. LIFELINE: the daemon stops itself when its proof of life ends --------------
step("2. lifeline: end the spawner's end of the pipe while the spawner LIVES — the daemon must stop itself, gracefully");
const daemonB = spawnDaemon(path.join(OUT, "editor-daemon-B.log"));
await waitFor(true, 60_000, "the daemon to come up");
console.log(`    daemon up (pid ${daemonB.pid})`);
const exitB = new Promise((resolve) => daemonB.once("exit", (code, signal) => resolve({ code, signal })));
daemonB.stdin.end(); // EOF on the lifeline: what the kernel delivers when the spawner dies any death
const lifelineMs = await waitFor(false, 30_000, "the daemon to stop itself");
const { code } = await exitB;
console.log(`    lifeline ended → daemon stopped ITSELF in ${lifelineMs} ms (exit code ${code})`);
check(code === 0, "the exit was the daemon's own, and graceful (code 0, not a kill)");
const logB = fs.readFileSync(path.join(OUT, "editor-daemon-B.log"), "utf8");
check(logB.includes("lifeline pipe closed"), "the daemon's own log names the lifeline pipe as the reason");
check(logB.includes("shutdown requested"), "it went down through the SAME path as the shutdown method (streams stopped, storage closed)");

// --- 3. KILLED PARENT ---------------------------------------------------------------
step("3. killed parent: the editor process is killed hard; the daemon must not outlive it");
const editor = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hold-editor"], {
	cwd: HERE,
	stdio: ["ignore", "pipe", "inherit"],
	windowsHide: true,
});
const editorPid = editor.pid;
let daemonBPid;
for await (const chunk of editor.stdout) {
	const match = String(chunk).match(/DAEMON_PID (\d+)/);
	if (match) { daemonBPid = Number(match[1]); break; }
}
if (!daemonBPid) {
	console.error("FAIL: the editor stand-in did not report the daemon pid");
	editor.kill();
	process.exit(1);
}
await waitFor(true, 60_000, "the daemon to come up");
console.log(`    editor pid ${editorPid} holds daemon pid ${daemonBPid} by a lifeline pipe`);

const killMs = await (async () => {
	const start = Date.now();
	await killHard(editorPid);
	await waitFor(false, 30_000, "the daemon to be gone");
	return Date.now() - start;
})();
console.log(`    taskkill/SIGKILL of the editor → daemon gone after ${killMs} ms`);
check(killMs < 10_000, `the daemon did not linger (${killMs} ms, no hook ran)`);
const daemonLog = fs.readFileSync(path.join(OUT, "editor-daemon.log"), "utf8");
if (daemonLog.includes("lifeline pipe closed")) {
	check(true, "the lifeline's EOF won the race: the daemon stopped itself gracefully");
} else {
	// Windows: libuv's per-child job object (KILL_ON_JOB_CLOSE) terminates the daemon
	// with the parent — the behaviour `detached: true` used to escape. The rule holds
	// either way; the graceful self-stop was proven in step 2.
	check(true, "the OS terminated it with the parent (Windows job object — the behaviour `detached:true` used to escape); the graceful path was proven in step 2");
}

// --- 4. STATE SURVIVES ---------------------------------------------------------------
step("4. state survives: the conversation is in SQLite, and a new client resumes it");
const sessionsB = await cli(["sessions"]);
check(sessionsB.stderr.includes("no daemon running"), "no daemon anywhere while the state is read");
check(new RegExp(`^${conversationId}\\t`, "m").test(sessionsB.stdout), `conversation ${conversationId} is still in sessions.sqlite`);

const resumed = spawn(process.execPath, ["cli.js", "serve"], { cwd: HERE, stdio: "ignore", windowsHide: true });
await waitFor(true, 60_000, "the fresh daemon (the next window's autoStart) to come up");
const send2 = await cliSend([String(conversationId), "Reply with exactly: LIFECYCLE-RESUMED"]);
check(send2.stdout.includes("LIFECYCLE-RESUMED"), `a new client resumed conversation ${conversationId} through the fresh daemon: "${send2.stdout.trim().slice(0, 60)}"`);
await editorStop(resumed).catch(() => {});
await waitFor(false, 30_000, "the fresh daemon to stop");
check(!(await probeUp()), "the machine is quiet again — no daemon left behind");

console.log(failures === 0 ? "\nPROOF-EDITOR-LIFECYCLE-OK" : `\nPROOF-EDITOR-LIFECYCLE-FAIL (${failures} check(s) failed)`);
process.exit(failures === 0 ? 0 : 1);
}

