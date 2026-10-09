// lib/render.js — turning agent events and transcript entries into CLI output.
// Shared by the in-process run (run/resume/fork) and the daemon clients
// (`send` renders a run; `attach` renders a conversation's entries), so all
// three print the same shapes. Text answers go to stdout, everything else to
// stderr — the README's "answer on stdout, activity on stderr" split.
import { entryText, textOf } from "./common.js";

export { entryText, textOf };

export function messageText(message) {
	return textOf(message);
}

/** One line per transcript entry, as `attach` has always printed them. */
export function describeEntry(entry) {
	switch (entry.kind) {
		case "pi.user":
			return `[user] ${entryText(entry)}`;
		case "pi.assistant": {
			const calls = (entry.model?.[0]?.content ?? []).filter((b) => b?.type === "toolCall").map((b) => `${b.name}(${JSON.stringify(b.arguments).slice(0, 120)})`);
			const text = entryText(entry);
			return `[assistant]${calls.length ? ` tool calls: ${calls.join("; ")} —` : ""} ${text}`;
		}
		case "pi.tool-result": {
			const result = entryText(entry);
			return `[tool result] ${result ? result.slice(0, 300) : "(no output)"}`;
		}
		case "pi.system":
			return `[system] prompt sections changed`; // the model-context diff; bodies live in the entry
		case "pi.reset":
			return `[reset] new context starts here`;
		case "pi.compaction":
			return `[compaction] older entries summarized`;
		default:
			return `[${entry.kind}]`;
	}
}

/**
 * Renderer for a run (in-process or through the daemon): text deltas → stdout;
 * tools, guard blocks, retries, settle → stderr. Counts guard blocks and
 * remembers whether any answer text was written, like runPrompt always did.
 */
export function makeRunRenderer({ writeText = (s) => process.stdout.write(s), writeLine = (l) => process.stderr.write(`${l}\n`) } = {}) {
	let sawDelta = false;
	let wroteText = false;
	let guardBlocks = 0;
	return {
		get wroteText() {
			return wroteText;
		},
		get guardBlocks() {
			return guardBlocks;
		},
		onEvent(event) {
			switch (event.type) {
				case "message_start":
					sawDelta = false;
					break;
				case "message_update":
					for (const change of event.changes ?? []) {
						if (change.type === "text_delta") {
							writeText(change.delta);
							wroteText = true;
							sawDelta = true;
						}
					}
					break;
				case "message_end": {
					// message_end carries the entry; its model messages hold the assistant text.
					const message = event.message ?? event.entry?.model?.find((m) => m.role === "assistant");
					const text = messageText(message).trim();
					if (!sawDelta && text && message?.role === "assistant") {
						writeText(text);
						wroteText = true;
					}
					break;
				}
				case "tool_execution_start":
					writeLine(`\n[tool] ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
					break;
				case "tool_execution_end": {
					const result = entryText(event.entry);
					if (result) writeLine(`[tool result] ${result.slice(0, 500)}`);
					if (result.startsWith("Blocked by the deterministic guard")) guardBlocks++;
					break;
				}
				case "auto_retry_start":
					writeLine(`[retry ${event.attempt}] ${event.errorMessage?.slice(0, 200)}`);
					break;
				case "run_end":
					writeLine(`\n[run settled]`);
					break;
			}
		},
	};
}

/**
 * Renderer for `attach`: one line per transcript entry (snapshot replay, then
 * live appended entries), deduplicated by entry id because the same entry can
 * arrive through snapshot, entry_appended and message_end.
 */
export function makeAttachRenderer({ writeLine = (l) => process.stderr.write(`${l}\n`) } = {}) {
	const seen = new Set();
	const show = (entry) => {
		if (!entry || seen.has(entry.id)) return;
		seen.add(entry.id);
		if (entry.kind === "pi.system") return; // keep the stream readable, as before
		writeLine(describeEntry(entry));
	};
	return {
		onEvent(event) {
			switch (event.type) {
				case "snapshot":
					for (const entry of event.entries ?? []) show(entry);
					break;
				case "entry_appended":
					show(event.entry);
					break;
				case "message_end":
					show(event.entry);
					break;
				case "run_end":
					writeLine(`[run settled]`);
					break;
			}
		},
	};
}
