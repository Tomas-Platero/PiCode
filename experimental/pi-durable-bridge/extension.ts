// extension.ts — the pi ⇄ pi-durable bridge.
//
// A pi extension (TypeScript, loaded with `pi --extension <this file>`; pi runs
// it through jiti, no build step). It registers three tools that hand work to
// the durable daemon in experimental/durable and read back what it did:
//
//   durable_send  — hand a prompt to the durable daemon and wait for its answer.
//                   The run executes INSIDE the daemon process: if pi dies
//                   mid-call, the daemon finishes the conversation anyway and
//                   the answer is committed to its SQLite.
//   durable_list  — list the durable conversations the daemon owns.
//   durable_read  — read one durable conversation's transcript.
//
// Wire format and client are REUSED, not reimplemented: everything talks through
// experimental/durable/lib/client.js and lib/protocol.js, imported by relative
// path. This extension never opens sessions.sqlite — the daemon is the single
// owner — and it never writes anywhere: no installs, no ~/.pi, no settings.
//
// One honest note on imports: the bridge directory has no node_modules of its
// own (nothing may be installed), so the one bare specifier the extension needs
// (`Type`, for the tool parameter schemas) is imported deep from the durable
// checkout's own node_modules — `../durable/node_modules/@earendil-works/pi-ai`
// — which is the exact same copy the daemon uses. lib/client.js and lib/protocol.js
// themselves pull in lib/common.js (they share its DATA_DIR), so importing them
// transitively loads the durable libraries into pi's process. That is load-only:
// nothing is opened, connected, or written at import time — connections happen
// lazily, per tool call, and a missing daemon fails fast with a plain message.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "../durable/node_modules/@earendil-works/pi-ai/dist/index.js";
import { DaemonClient, DaemonUnavailableError, daemonIsUp } from "../durable/lib/client.js";
import { daemonEndpoint } from "../durable/lib/protocol.js";
import { describeEntry, entryText } from "../durable/lib/render.js";

const START_HINT = "node experimental/durable/cli.js serve   (run from the repository root; --no-mcp starts faster)";

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
		"and every MCP server it was started with). Returns the durable conversation id and the final answer.",
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
			onUpdate?.({ content: [{ type: "text", text: `handed to the durable daemon (conversation ${conversationId}); waiting for it to settle…` }] });
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
	pi.registerTool(durableList);
	pi.registerTool(durableRead);
}
