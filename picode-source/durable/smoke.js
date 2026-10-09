// Smoke test: one question and answer through the OmniRoute gateway.
import { CTX, MODEL, openHarness, answerText, resetDatabase } from "./lib/common.js";

const DB = "smoke.sqlite";
resetDatabase(DB);
const { harness } = await openHarness({ db: DB });
const root = await harness.root(CTX, { agent: { model: MODEL } });
const submission = await root.submit({ type: "input", content: "Reply with exactly: SMOKE-OK" }, CTX);
const settled = await submission.wait(CTX);
console.log("settled:", settled.status);
const text = await answerText(root, settled);
console.log("answer:", text ?? JSON.stringify(settled).slice(0, 800));
await harness.close(CTX);
