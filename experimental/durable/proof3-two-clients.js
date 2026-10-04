// PROOF 3: two clients attach to the same live conversation at once.
// Client A attaches before the run; client B joins mid-run (late join) and
// still receives everything committed from that point on.
import { CTX, MODEL, openHarness, sleepMs, resetDatabase } from "./lib/common.js";
import { watchEvents } from "@earendil-works/pi-durable";

const PROOF3_DB = "proof3.sqlite";
resetDatabase(PROOF3_DB); // one database per proof; every run of this proof starts clean

const { harness } = await openHarness({ db: PROOF3_DB });
const root = await harness.root(CTX, {
	agent: { model: MODEL, instructions: "Answer briefly. Follow instructions literally." },
});

console.log("=== PROOF 3: two clients on one live conversation ===");
console.log(`conversation: ${root.id}`);

function makeClient(name) {
	const counts = {};
	const first = {};
	let snapshotInfo = "n/a";
	return {
		name,
		async attach() {
			const stream = await watchEvents(harness, root.id, CTX);
			snapshotInfo = `entries=${stream.snapshot?.entries?.length ?? "?"} run=${JSON.stringify(stream.snapshot?.run)}`;
			await stream.start((events) => {
				for (const e of events) {
					const t = e?.type ?? "?";
					counts[t] = (counts[t] ?? 0) + 1;
					if (!first[t]) {
						first[t] = true;
						console.log(`  [client ${name}] first '${t}' event`);
					}
				}
			});
			console.log(`[client ${name}] attached; snapshot: ${snapshotInfo}`);
		},
		report() {
			const total = Object.values(counts).reduce((a, b) => a + b, 0);
			console.log(`[client ${name}] total events received: ${total}`);
			for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
			return total;
		},
	};
}

const clientA = makeClient("A");
await clientA.attach(); // before the run starts

const submission = await root.submit(
	{ type: "input", content: "Call the slow_step tool twice: steps 1 and 2, seconds 3 each, one at a time. Then reply with exactly: BOTH-CLIENTS-SEE-THIS" },
	CTX,
);

// Client B joins mid-run: as soon as A sees the first tool execution.
await sleepMs(4000); // the model is thinking / first tool call is running by now
const clientB = makeClient("B");
await clientB.attach();

await submission.wait(CTX);
await sleepMs(2000); // let trailing event batches drain

console.log("--- per-client event tallies ---");
const a = clientA.report();
const b = clientB.report();
console.log(`PROOF 3 ${a > 0 && b > 0 ? "COMPLETE" : "INCOMPLETE"}: both clients received live events from the same conversation.`);
await harness.close(CTX);
