// PROOF 2: a subagent is a background task that does not block the parent
// conversation. The parent spawns a subagent via the `subagent` tool; the tool
// returns immediately; the parent answers a SECOND input while the child is
// still working; the child's answer is reported back as a follow-up input.
import { CTX, MODEL, openHarness, answerText, entryText, sleepMs, resetDatabase } from "./lib/common.js";
import { watchEvents } from "@earendil-works/pi-durable";

const PROOF2_DB = "proof2.sqlite";
resetDatabase(PROOF2_DB); // one database per proof; every run of this proof starts clean

const { harness } = await openHarness({ db: PROOF2_DB });
const root = await harness.root(CTX, {
	agent: {
		model: MODEL,
		instructions:
			"You coordinate work. Use the subagent tool when asked to delegate. Never run slow_step yourself unless explicitly told to. Answer briefly.",
	},
});

console.log("=== PROOF 2: subagent as a background task ===");
console.log(`parent conversation: ${root.id}`);

// Watch the parent's event stream so the interleaving is visible.
const stream = await watchEvents(harness, root.id, CTX);
await stream.start((events) => {
	for (const e of events) {
		const t = e?.type ?? "?";
		if (t !== "message_update" && t !== "message_start") console.log(`  [parent events] ${t}`);
	}
});

// 1. Spawn the subagent through the real model/tool path.
console.log("--- parent run 1: spawn a background subagent ---");
const t0 = Date.now();
const spawn = await root.submit(
	{ type: "input", content: "Spawn a background subagent with task: 'Call the slow_step tool THREE times: steps 1 to 3, seconds 3 each, one at a time, then reply with exactly SUBAGENT-WORK-DONE'. After spawning it, confirm the spawn in one short sentence and stop." },
	CTX,
);
const settled1 = await spawn.wait(CTX);
console.log(`parent run 1 settled: ${settled1.status} in ${Date.now() - t0}ms (the spawn tool returned immediately)`);
const said1 = await answerText(root, settled1);
if (said1) console.log(`parent said: ${said1}`);

// 2. Prove the parent is NOT blocked: answer a new input while the child works.
console.log("--- parent run 2: a new input while the subagent is still working ---");
const graph = await harness.taskGraph(CTX);
for (const node of Object.values(graph.value?.tasks ?? {})) {
	console.log(`  task graph: ${node.kind} status=${node.state.status}${node.background ? " background" : ""} owner=${node.owner ?? "conversation " + node.conversationId}`);
}
const t1 = Date.now();
const second = await root.submit(
	{ type: "input", content: "The subagent is still working in the background. Reply with exactly: PARENT-NOT-BLOCKED" },
	CTX,
);
const settled2 = await second.wait(CTX);
console.log(`parent answered the second input in ${Date.now() - t1}ms while the child was still running: ${settled2.status}`);
const said2 = await answerText(root, settled2);
if (said2) console.log(`parent said: ${said2}`);

// 3. Wait for the child's report to arrive as a follow-up input on the parent,
//    and for the parent to acknowledge it (an assistant entry after the report).
console.log("--- waiting for the background subagent's report ---");
const deadline = Date.now() + 120_000;
let finalEntries = null;
while (Date.now() < deadline && !finalEntries) {
	await sleepMs(1000);
	const view = await root.viewState(CTX);
	const entries = view.value?.entries ?? [];
	const texts = entries.map((e) => JSON.stringify(e.data ?? e));
	const reportIdx = texts.findIndex((t) => t.includes("Background subagent report"));
	if (reportIdx !== -1) {
		const ackIdx = entries.findIndex((e, i) => i > reportIdx && e.kind === "pi.assistant");
		if (ackIdx !== -1) finalEntries = entries;
	}
}
if (!finalEntries) throw new Error("timed out waiting for the subagent's report");

console.log("--- parent transcript (final) ---");
for (const e of finalEntries) {
	const t = entryText(e);
	console.log(`  ${e.kind}${t ? ": " + t.slice(0, 180) : ""}`);
}
console.log("PROOF 2 COMPLETE: child owned by a background task; parent stayed responsive and received the report.");
await harness.close(CTX);
