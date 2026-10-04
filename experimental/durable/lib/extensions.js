// Proof extensions: a deterministic slow tool, and a background subagent.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, defineTask } from "@earendil-works/pi-durable";
import { configure } from "@earendil-works/pi-durable";

/**
 * slow_step: sleeps `seconds` (capped at 5) and reports progress through
 * running output. `replay: "safe"` means that if the process is killed
 * mid-call, the call reruns on resume instead of feeding the model an
 * "interrupted" error — the run continues where it stopped.
 */
const slowStep = defineTool({
	name: "slow_step",
	description: "Do one slow unit of work: sleep for the given number of seconds (max 5) while streaming progress.",
	parameters: Type.Object({
		step: Type.Number({ description: "which step this is (1-based)" }),
		seconds: Type.Number({ description: "how long this step takes, in seconds (max 5)" }),
	}),
	replay: "safe",
	executionMode: "sequential",
	execute: async (args, api) => {
		const total = Math.min(args.seconds, 5) * 1000;
		const end = Date.now() + total;
		while (Date.now() < end) {
			const left = Math.ceil((end - Date.now()) / 1000);
			api.output(`step ${args.step}: ${left}s left...\n`);
			await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())));
		}
		api.output(`step ${args.step}: done\n`);
		return {};
	},
});

export const ProofTools = defineExtension({
	name: "proof-tools",
	tools: [slowStep],
});

/**
 * Background subagent, following the README's "Abort and Subagents" pattern:
 * the `subagent` tool spawns a background anchor task; the anchor task owns a
 * child conversation, drives it, and reports the child's answer back to the
 * parent conversation as a follow-up input. Because the anchor is a
 * background task, the child does not keep the parent busy: the parent can
 * answer other inputs while the child works.
 */
export const SubagentRun = defineTask({
	name: "proof.subagent-run",
	version: 1,
	initial: (input) => ({
		phase: "run",
		parentConversationId: input.parentConversationId,
		prompt: input.prompt,
		childConversationId: null,
	}),
	phases: {
		run: async (task, runtime, context) => {
			// 1. Create (or find, after a crash — dedupe via the ownership index)
			//    the child conversation, owned by this anchor task.
			let childId = task.state.checkpoint.childConversationId;
			if (!childId) {
				// NOTE: this commit must return undefined — runtime.commit treats any
				// returned value as the task's NEXT STATE, so returning the child's id
				// here would overwrite the task's state with a bare number.
				await runtime.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
					if (existing) {
						childId = existing.id;
					} else {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
						// Copy of the parent's agent, minus the subagent tool (no recursion).
						await configure(tx, created.id, { extensions: { remove: [SubagentExtension] } });
						childId = created.id;
					}
				}, context);
				await runtime.commit((tx, current) => ({ status: "running", checkpoint: { ...current.state.checkpoint, childConversationId: childId } }), context);
			}

			// 2. Submit the task to the child. A stable requestId makes resubmission
			//    after a restart idempotent: it finds the same submission.
			const child = await runtime.conversation(childId, context);
			const submission = await child.submit(
				{ type: "input", content: task.state.checkpoint.prompt, requestId: `subagent:${task.id}` },
				context,
			);

			// 3. Wait for the child's answer. The settled receipt carries the answer
			//    entry's ID; the child's entries are not visible from the parent, so
			//    read the answer through the child's model context instead.
			const settled = await submission.wait(context);
			let answer = `(no answer: ${settled.status})`;
			if (settled.status === "done" && settled.type === "input") {
				const childView = await runtime.context(childId, context);
				const assistants = (childView?.messages ?? []).filter((m) => m.role === "assistant");
				const last = assistants[assistants.length - 1];
				answer = Array.isArray(last?.content)
					? last.content.filter((b) => b.type === "text").map((b) => b.text).join("")
					: typeof last?.content === "string"
						? last.content
						: "";
			}

			// 4. Report the answer back to the parent conversation as a follow-up
			//    input; the parent is idle by then and starts a new run with it.
			const parent = await runtime.conversation(task.state.checkpoint.parentConversationId, context);
			await parent.submit(
				{ type: "input", content: `Background subagent report: ${answer}`, requestId: `subagent-report:${task.id}` },
				context,
			);

			// 5. Terminal outcome.
			await runtime.commit(
				(tx, current) => ({
					status: "terminal",
					outcome: { status: "completed", result: { childConversationId: childId, answer } },
				}),
				context,
			);
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(
			(tx, current) => ({ status: "terminal", outcome: { status: "aborted", reason: "anchor task aborted" } }),
			context,
		);
	},
});

const spawnSubagent = defineTool({
	name: "subagent",
	description:
		"Delegate a self-contained task to a BACKGROUND subagent and return immediately. The subagent works in its own conversation; its answer is reported back to this conversation when it finishes.",
	parameters: Type.Object({ task: Type.String({ description: "the self-contained task for the subagent" }) }),
	replay: "safe",
	execute: async (args, api, context) => {
		// Durable memo keeps a crash between create and record from spawning two anchors.
		const existing = await api.memo("anchorTaskId", context);
		if (existing) {
			return { content: [{ type: "text", text: `Subagent already running (anchor task ${existing}).` }] };
		}
		const anchorId = await api.commit(
			(tx) =>
				tx.createTask(SubagentRun, { parentConversationId: api.conversationId, prompt: args.task }, {
					ownership: { kind: "conversation" },
					background: true, // the boundary: survives the parent's abort, keeps the parent idle
				}),
			context,
		);
		await api.memo("anchorTaskId", anchorId, context);
		await api.details({ anchorTaskId: anchorId }, context);
		return {
			content: [
				{ type: "text", text: `Subagent spawned in the background (anchor task ${anchorId}). You can keep working; its answer will be reported back when ready.` },
			],
		};
	},
});

export const SubagentExtension = defineExtension({
	name: "proof-subagent",
	tools: [spawnSubagent],
	tasks: [SubagentRun],
});
