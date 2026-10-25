// proof-record.js — reproducible evidence for the daemon's `record` method.
//
// What it proves, with a real daemon and real storage:
//   1. `record` appends a finished turn (user + assistant messages) to a conversation
//      WITHOUT running any model — no profile, no provider, no run.
//   2. The recorded turn is indistinguishable from an executed one: the conversation
//      shows up in `sessions`, and its snapshot carries the same `pi.user` /
//      `pi.assistant` shape a run writes (the panel maps it the same way).
//   3. A second `record` on the same conversation appends — history grows in order.
//   4. A bad message shape is refused with a sentence, not stored half-shaped — an
//      empty ASSISTANT message is the exception: it is the interrupted-turn shape the
//      import records so a transcript that ended mid-work does not read as "owes".
//
// Run from picode-source/durable/:  node proof-record.js
// Isolated by construction: its own data dir and its own endpoint, set HERE before the
// lib modules load (DATA_DIR is import-time), and inherited by the spawned daemon — so
// it never touches a real daemon's storage or pipe, whatever else is running.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const DATA = ".data/record-proof";
process.env.PICODE_DURABLE_DATA = DATA;
process.env.PICODE_DURABLE_ENDPOINT = process.platform === "win32"
	? "\\\\.\\pipe\\picode-durable-proof-record"
	: "";
if (process.env.PICODE_DURABLE_ENDPOINT === "") delete process.env.PICODE_DURABLE_ENDPOINT;
const { DaemonClient } = await import("./lib/client.js");

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const step = (line) => console.log(`\n=== ${line}`);
const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(1); };

step("1. starting the isolated daemon (no mcp, no guard — record needs neither)");
const daemon = spawn(process.execPath, ["cli.js", "serve", "--no-mcp", "--no-guard"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
const log = [];
daemon.stdout.on("data", (chunk) => log.push(String(chunk)));
daemon.stderr.on("data", (chunk) => log.push(String(chunk)));

const client = await new Promise((resolve) => {
	let tries = 0;
	const probe = setInterval(() => {
		tries++;
		DaemonClient.connect(500).then((connected) => {
			clearInterval(probe);
			resolve(connected);
		}).catch(() => {
			if (tries > 60) { clearInterval(probe); resolve(undefined); }
		});
	}, 500);
});
if (client === undefined) { console.error(log.join("")); fail("the daemon did not come up"); }
console.log("daemon up on the isolated endpoint");

try {
	step("2. open a conversation and record one finished turn");
	const opened = await client.request("open", { cwd: process.cwd() });
	if (!Number.isFinite(opened.conversationId)) fail("open returned no conversationId");
	const id = opened.conversationId;
	console.log(`conversation ${id} opened (no run, no model)`);

	const recorded = await client.request("record", {
		conversationId: id,
		messages: [
			{ role: "user", content: "Fix the chat" },
			{ role: "assistant", content: "Done: the chat answers again." },
		],
	});
	if (recorded.recorded !== 2) fail(`record reported ${JSON.stringify(recorded)}`);
	console.log(`record wrote ${recorded.recorded} messages with no model involved`);

	step("3. the recorded turn reads like an executed one");
	const listed = await client.request("sessions", {});
	const row = (listed.conversations ?? []).find((conversation) => conversation.id === id);
	if (row === undefined) fail("the recorded conversation does not show up in sessions");
	console.log(`sessions lists it: entries=${row.entries ?? "?"}`);

	const subscribed = await client.request("subscribe", { conversationId: id });
	const snapshot = subscribed.snapshot ?? {};
	const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
	const roles = entries
		.filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")
		.map((entry) => `${entry.kind}="${(entry.model ?? [])[0]?.content?.[0]?.text ?? ""}"`);
	console.log(`snapshot entries: ${roles.join(" | ")}`);
	if (roles.length !== 2) fail(`the snapshot does not carry the two recorded turns (${roles.length})`);
	if (!roles[0].startsWith("pi.user=") || !roles[1].startsWith("pi.assistant=")) fail("the order or kind of the recorded turns is wrong");
	// Release the watch before the next step needs a fresh one: a held stream is reused by the next
	// subscriber (it keeps fanning out events), and its snapshot is only the one taken when the
	// subscribe asks for it — this step wants its own.
	await client.request("unsubscribe", { conversationId: id });

	step("4. a second record appends in order");
	await client.request("record", {
		conversationId: id,
		messages: [{ role: "user", content: "Now the panel" }],
	});
	const again = await client.request("subscribe", { conversationId: id });
	const count = (again.snapshot?.entries ?? []).filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant").length;
	if (count !== 3) fail(`the second record did not append (snapshot has ${count} turns)`);
	console.log("history grew in order: 3 turns");
	// Release the watch: the next subscriber would reuse this stream, and 5b wants a snapshot of the
	// state as it is now rather than the one this attach took.
	await client.request("unsubscribe", { conversationId: id });

	step("5. a bad shape is refused with a sentence");
	let refused = "";
	try {
		await client.request("record", { conversationId: id, messages: [{ role: "system", content: "nope" }] });
		fail("a bad message shape was accepted");
	} catch (error) {
		refused = error.message;
	}
	console.log(`refused: ${refused}`);
	if (!refused.includes("pi message shape")) fail("the refusal does not say what is wrong");
	let emptyUser = "";
	try {
		await client.request("record", { conversationId: id, messages: [{ role: "user", content: [] }] });
		fail("an empty user message was accepted");
	} catch (error) {
		emptyUser = error.message;
	}
	if (!emptyUser.includes("pi message shape")) fail("an empty user message must be refused");
	console.log(`empty user message refused: ${emptyUser}`);

	step("5b. an assistant message with no parts is accepted — the interrupted turn");
	const interrupted = await client.request("record", {
		conversationId: id,
		messages: [{ role: "assistant", content: [] }],
	});
	if (interrupted.recorded !== 1) fail(`the interrupted turn did not record (${JSON.stringify(interrupted)})`);
	const after = await client.request("subscribe", { conversationId: id });
	// The snapshot reads oldest-first (step 3 proved it); the interrupted turn is its tail.
	const last = (after.snapshot?.entries ?? [])
		.filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")
		.at(-1);
	if (last?.kind !== "pi.assistant") fail(`the interrupted turn did not land as pi.assistant (${last?.kind})`);
	console.log("the interrupted turn landed as the conversation's pi.assistant tail");
	await client.request("unsubscribe", { conversationId: id });

	step("6. shutdown");
	await client.request("shutdown", {});
	console.log("daemon stopped");
} finally {
	await new Promise((resolve) => {
		daemon.once("exit", resolve);
		setTimeout(() => { try { daemon.kill(); } catch { /* already gone */ } resolve(); }, 3000);
	});
	rmSync(DATA, { recursive: true, force: true });
}
console.log("\nPROOF OK");
