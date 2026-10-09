// PROOF 1 (phase B): reopen the same SQLite storage after the kill -9 and
// resume the interrupted run. Prints what survived the crash, then waits for
// the run to complete.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CTX, DATA_DIR, openHarness, answerText, entryText } from "./lib/common.js";

const PROOF1_DB = "proof1.sqlite"; // same database phase A used — must NOT be reset here
const file = path.join(DATA_DIR, "proof1.json");
if (!existsSync(file)) throw new Error("no proof1.json — run proof1-kill.js first");
const rec = JSON.parse(readFileSync(file, "utf8"));

const { harness, sqlitePath } = await openHarness({ db: PROOF1_DB });
const root = await harness.conversation(rec.conversationId, CTX);
if (!root) throw new Error(`conversation ${rec.conversationId} not found in storage`);

const viewBefore = await root.viewState(CTX);
const entriesBefore = viewBefore.value?.entries ?? [];
console.log("=== PROOF 1 phase B: reopened storage after the kill ===");
console.log(`storage:                 ${sqlitePath}`);
console.log(`conversation:            ${root.id}`);
console.log(`entries that survived:   ${entriesBefore.length}`);
for (const e of entriesBefore) console.log(`  survived: ${e.kind}`);

console.log("resuming the harness...");
harness.resume();

const submission = await harness.submission(rec.submissionId, CTX);
if (!submission) throw new Error(`submission ${rec.submissionId} not found`);

const settled = await submission.wait(CTX);
console.log(`--- interrupted run resumed and settled: ${settled.status} ---`);
if (settled.status === "done" && settled.type === "input") {
	console.log(`FINAL ANSWER: ${await answerText(root, settled)}`);
} else {
	console.log("settled:", JSON.stringify(settled, null, 2).slice(0, 2000));
}

const viewAfter = await root.viewState(CTX);
const entriesAfter = viewAfter.value?.entries ?? [];
console.log(`entries after resume:    ${entriesAfter.length}`);
console.log("--- full transcript (kind + text where present) ---");
for (const e of entriesAfter) {
	const t = entryText(e);
	console.log(`  ${e.kind}${t ? ": " + t.slice(0, 140) : ""}`);
}
await harness.close(CTX);
