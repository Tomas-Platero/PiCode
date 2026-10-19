// PROOF 1 (phase A): start a multi-step durable run and tell the operator to
// kill the process mid-run. The submission coordinates are written to
// .data/proof1.json BEFORE the kill so phase B can find them.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CTX, MODEL, DATA_DIR, resetDatabase, openHarness } from "./lib/common.js";

export const PROOF1_DB = "proof1.sqlite";
resetDatabase(PROOF1_DB); // one database per proof; every run of this proof starts clean

const { harness, sqlitePath } = await openHarness({ db: PROOF1_DB });

const root = await harness.root(CTX, {
	agent: {
		model: MODEL,
		instructions:
			"You are a careful worker. Follow instructions literally. When asked to run steps one at a time, make one tool call, wait for its result, then make the next.",
	},
});

const submission = await root.submit(
	{ type: "input", content: "Run the slow_step tool SIX times: steps 1 through 6, seconds 2 each, one call at a time. When all six steps are done, reply with exactly: RUN-COMPLETED-AFTER-RESUME" },
	CTX,
);

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
	path.join(DATA_DIR, "proof1.json"),
	JSON.stringify({ conversationId: root.id, submissionId: submission.id, pid: process.pid }, null, 2),
);

console.log("=== PROOF 1 phase A: durable run started ===");
console.log(`storage:      ${sqlitePath}`);
console.log(`conversation: ${root.id}`);
console.log(`submission:   ${submission.id}`);
console.log(`PID:          ${process.pid}`);
console.log(`>>> KILL ME NOW:  kill -9 ${process.pid}    (about 20 seconds of work are running)`);
console.log("--- committed transcript (live) ---");

const view = await root.viewState(CTX);
let seen = 0;
view.subscribe((v) => {
	const entries = v?.entries ?? [];
	if (entries.length > seen) {
		for (const e of entries.slice(seen)) {
			console.log(`  commit: ${e.kind}`);
		}
		seen = entries.length;
	}
});

const settled = await submission.wait(CTX);
console.log(`--- run settled on its own (${settled.status}); it was NOT killed in time ---`);
await harness.close(CTX);
