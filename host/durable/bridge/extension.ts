// extension.ts — the pi ⇄ durable bridge.
//
// A pi extension (TypeScript, loaded with `pi --extension <this file>`; pi runs
// it through jiti, no build step). It registers five tools that hand work to
// the durable daemon in durable/ and read back what it did:
//
//   durable_send   — hand a prompt to the durable daemon and wait for its answer.
//                    The run executes INSIDE the daemon process: if pi dies
//                    mid-call, the daemon finishes the conversation anyway and
//                    the answer is committed to its SQLite.
//   durable_submit — the same hand-off, but it RETURNS AT ONCE. Nothing waits:
//                    the run keeps going in the daemon and `durable_result`
//                    reads the outcome later. This is the one to use when there
//                    is other work to do while the long task runs.
//   durable_result — ask one durable conversation where its work stands: still
//                    running, or the final answer once it settled.
//   durable_list   — list the durable conversations the daemon owns.
//   durable_read   — read one durable conversation's transcript.
//
// Wire format and client are REUSED, not reimplemented: everything talks through
// durable/lib/client.js and lib/protocol.js, imported by relative
// path. This extension never opens sessions.sqlite — the daemon is the single
// owner — and it never writes anywhere: no installs, no ~/.pi, no settings.
//
// One honest note on imports: `@earendil-works/pi-coding-agent` is pi's own documented
// specifier for extensions (pi's `docs/extensions.md` imports `ExtensionAPI` exactly this
// way), so the running pi answers it wherever pi lives; and the package is a declared
// devDependency of the tree, pinned to the same version the editor ships
// (`distribution/runtime.json`), so inside this tree the same specifier also resolves from
// the tree itself — not from whatever pi happens to be running. The bridge directory has no
// node_modules of its own (nothing may be installed), so the other bare specifier the
// extension needs (`Type`, for the tool parameter schemas) is imported deep from the durable
// checkout's own node_modules — `../durable/node_modules/@earendil-works/pi-ai`
// — which is the exact same copy the daemon uses. lib/client.js and lib/protocol.js
// themselves pull in lib/common.js (they share its DATA_DIR), so importing them
// transitively loads the durable libraries into pi's process. That is load-only:
// nothing is opened, connected, or written at import time — connections happen
// lazily, per tool call, and a missing daemon fails fast with a plain message.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "../node_modules/@earendil-works/pi-ai/dist/index.js";
import { DaemonClient, DaemonUnavailableError, daemonIsUp } from "../lib/client.js";
import { daemonEndpoint } from "../lib/protocol.js";
import { describeEntry, entryText } from "../lib/render.js";

const START_HINT = "node durable/cli.js serve   (run from the repository root; --no-mcp starts faster)";

/** Every tool failure is a plain sentence for the model, never a hang. */
function fail(error: unknown): never {
	if (error instanceof DaemonUnavailableError || String((error as Error)?.message ?? error).includes("no durable daemon")) {
		throw new Error(`the durable daemon is not running (endpoint ${daemonEndpoint()}) — start it with: ${START_HINT}`);
	}
	throw error instanceof Error ? error : new Error(String(error));
}

async function withClient<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
	if (!(await daemonIsUp())) {
		throw new DaemonUnavailableError(`no durable daemon is running at ${daemonEndpoint()}`);
	}
	const client = await DaemonClient.connect(3000); // bounded: says so plainly, never hangs
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

const durableSend = defineTool({
	name: "durable_send",
	label: "Durable send",
	description:
		"Hand a prompt to the durable agent daemon and return its answer. " +
		"The prompt runs in a SEPARATE durable process that keeps working even if this pi session is killed. " +
		"Use it for work that must survive a crash, or to delegate slow work (the durable side has a slow_step tool " +
		"and every MCP server it was started with). Returns the durable conversation id and the final answer. " +
		"DELEGATE ON TIME: this editor's window can close while you work — anything expected to run long " +
		"(builds, long investigations, parallel tasks) belongs here BEFORE you start it, not after it was cut. " +
		"A conversation only survives the window because its work does.",
	parameters: Type.Object({
		prompt: Type.String({ description: "The prompt to run in the durable conversation." }),
		conversationId: Type.Optional(
			Type.Number({ description: "Continue an existing durable conversation instead of creating a new one." }),
		),
	}),
	async execute(_toolCallId, params, _signal, onUpdate) {
		try {
			// NOTE: the abort signal is deliberately ignored below. The run belongs to
			// the daemon once submitted — that is the entire point of the bridge — and
			// the daemon protocol has no cancel; killing pi does not stop the work.
			const { conversationId } = await withClient((client) =>
				params.conversationId != null
					? client.request("open", { conversationId: params.conversationId })
					: client.request("open", {}),
			);
			onUpdate?.({ content: [{ type: "text", text: `handed to the durable daemon (conversation ${conversationId}); waiting for it to settle…` }], details: { conversationId, status: "running" } });
			const run = await withClient((client) =>
				client.request("run", { conversationId, prompt: params.prompt }),
			);
			const answer = run.answer ?? `(no text answer — run status: ${run.status})`;
			return {
				content: [{ type: "text", text: `durable conversation ${conversationId} answered:\n${answer}` }],
				details: { conversationId, status: run.status, answer },
			};
		} catch (error) {
			fail(error);
		}
	},
});

const durableSubmit = defineTool({
	name: "durable_submit",
	label: "Durable submit",
	description:
		"Hand a prompt to the durable agent daemon and RETURN IMMEDIATELY, without waiting for the answer. " +
		"The run continues inside the durable process (it survives this pi session being killed) and its result is " +
		"committed to the durable conversation. Use it when there is other work to do meanwhile: you get the " +
		"conversation id now, and `durable_result` reads the answer later. " +
		"The run is queued, not parallel: if that conversation is already running something, this waits its turn.",
	parameters: Type.Object({
		prompt: Type.String({ description: "The prompt to run in the durable conversation." }),
		conversationId: Type.Optional(
			Type.Number({ description: "Continue an existing durable conversation instead of creating a new one." }),
		),
	}),
	async execute(_toolCallId, params, _signal, onUpdate) {
		try {
			// No signal handling, for the same reason as durable_send: once submitted, the work is the
			// daemon's, and abandoning this call does not abandon it.
			const { conversationId } = await withClient((client) =>
				params.conversationId != null
					? client.request("open", { conversationId: params.conversationId })
					: client.request("open", {}),
			);
			onUpdate?.({ content: [{ type: "text", text: `handing the prompt to durable conversation ${conversationId}…` }], details: { conversationId, status: "submitting" } });
			const started = await withClient((client) =>
				client.request("start", { conversationId, prompt: params.prompt }),
			);
			return {
				content: [{
					type: "text",
					text: `handed to durable conversation ${conversationId} — it keeps running in the daemon. ` +
						`Ask durable_result { conversationId: ${conversationId} } for the answer when you need it.`,
				}],
				details: { conversationId, submissionId: started.submissionId, status: "running" },
			};
		} catch (error) {
			fail(error);
		}
	},
});

const durableResult = defineTool({
	name: "durable_result",
	label: "Durable result",
	description:
		"Ask one durable conversation how its work stands: still running, or the final answer once it settled. " +
		"This is how the answer to a `durable_submit` is collected — it does not wait, it reports what is there now.",
	parameters: Type.Object({
		conversationId: Type.Number({ description: "The durable conversation id (returned by durable_submit or durable_list)." }),
	}),
	async execute(_toolCallId, params) {
		try {
			// subscribe answers with the snapshot and then keeps pushing events; unsubscribing at once
			// leaves the daemon exactly as it was (its stream is reference counted, daemon.js release()).
			const { snapshot } = await withClient(async (client) => {
				const answer = await client.request("subscribe", { conversationId: params.conversationId });
				await client.request("unsubscribe", { conversationId: params.conversationId });
				return answer;
			});
			const entries: { kind: string }[] = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
			const running = Boolean(snapshot?.run);
			const answerEntry = [...entries].reverse().find((e) => e.kind === "pi.assistant");
			const answer = answerEntry ? entryText(answerEntry) : null;
			const head = running
				? `durable conversation ${params.conversationId} is still running.`
				: answer === null
					? `durable conversation ${params.conversationId} is idle and has no answer yet.`
					: `durable conversation ${params.conversationId} answered:\n${answer}`;
			return {
				content: [{ type: "text", text: head }],
				details: { conversationId: params.conversationId, running, answer },
			};
		} catch (error) {
			fail(error);
		}
	},
});

const durableList = defineTool({
	name: "durable_list",
	label: "Durable list",
	description:
		"List the durable agent's conversations (id, entry count, last activity). " +
		"Use it to see what the durable side has done, e.g. work that was handed off with durable_send.",
	parameters: Type.Object({}),
	async execute() {
		try {
			const { conversations } = await withClient((client) => client.request("sessions"));
			if (conversations.length === 0) {
				return { content: [{ type: "text", text: "the durable daemon has no conversations yet." }], details: { conversations: [] } };
			}
			const lines = conversations.map((c: { id: number; entries: number; newest: string; note: string }) =>
				`#${c.id}  ${c.entries} entries  — ${c.newest}${c.note ? `  (${c.note})` : ""}`,
			);
			return {
				content: [{ type: "text", text: `${conversations.length} durable conversation(s):\n${lines.join("\n")}` }],
				details: { conversations },
			};
		} catch (error) {
			fail(error);
		}
	},
});

const durableRead = defineTool({
	name: "durable_read",
	label: "Durable read",
	description:
		"Read the transcript of one durable conversation (all entries, including the final assistant answer). " +
		"Use it after durable_list to inspect what actually happened on the durable side.",
	parameters: Type.Object({
		conversationId: Type.Number({ description: "The durable conversation id (from durable_list)." }),
	}),
	async execute(_toolCallId, params) {
		try {
			const { snapshot } = await withClient(async (client) => {
				const sub = await client.request("subscribe", { conversationId: params.conversationId });
				await client.request("unsubscribe", { conversationId: params.conversationId });
				return sub;
			});
			const entries = (snapshot?.entries ?? []).filter((e: { kind: string }) => e.kind !== "pi.system");
			const lines = entries.map((e: never) => describeEntry(e));
			// Keep the model-facing result bounded; the newest entries matter most.
			const joined = lines.join("\n");
			const text = joined.length > 16000 ? `…(older entries cut)…\n${joined.slice(-16000)}` : joined;
			const answerEntry = [...entries].reverse().find((e: { kind: string }) => e.kind === "pi.assistant");
			return {
				content: [{ type: "text", text: `durable conversation ${params.conversationId} — ${entries.length} entries:\n${text}` }],
				details: {
					conversationId: params.conversationId,
					entries: entries.length,
					inFlight: Boolean(snapshot?.run),
					lastAssistant: answerEntry ? entryText(answerEntry) : null,
				},
			};
		} catch (error) {
			fail(error);
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(durableSend);
	pi.registerTool(durableSubmit);
	pi.registerTool(durableResult);
	pi.registerTool(durableList);
	pi.registerTool(durableRead);
}
