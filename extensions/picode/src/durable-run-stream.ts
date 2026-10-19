/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable run's live event stream, mapped for the chat.
 *
 * A `subscribe` on the daemon's pipe delivers the same events the agent's own CLI renders
 * (`picode-source/durable/lib/render.js`'s `makeRunRenderer`): partial generation messages
 * with text deltas, tool executions, and the run's end. This module is that renderer's text
 * and progress rules, as a state machine a chat `requestHandler` can drive — the mapping
 * must move with `render.js` if its shapes ever do.
 *
 * The rule the renderer keeps, kept here too: a streamed answer is never written twice. The
 * partial deltas ARE the message; a `message_end` that carries an answer whose deltas were
 * already streamed adds nothing. Only an answer that arrives whole — a generation the stream
 * never showed partially — is emitted at its end.
 *
 * No `vscode` import: `node --test` runs the rules directly.
 */

/** What one event contributes to the chat: markdown to write, or a progress line to show. */
export interface DurableStreamOutput {
	readonly markdown?: string;
	readonly progress?: string;
	readonly warning?: string;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** The event's `type`, as the daemon's `translate` shapes it (`pi-durable`'s events.js). */
function eventType(event: unknown): string | undefined {
	const type = recordOf(event)?.['type'];
	return typeof type === 'string' ? type : undefined;
}

/** Concatenated text of a pi-ai message (copied from `durable/lib/common.js`'s `textOf`). */
function textOf(message: unknown): string {
	const content = recordOf(message)?.['content'];
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map(block => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
		.join('');
}

/** The transcript entry's own text — `durable/lib/common.js`'s `entryText` (assistant-only here). */
function assistantTextOfEntry(entry: unknown): string {
	const model = recordOf(entry)?.['model'];
	const message = Array.isArray(model)
		? (model as readonly unknown[]).find(candidate => recordOf(candidate)?.['role'] === 'assistant')
		: undefined;
	return textOf(message).trim();
}

/**
 * The run's text and progress, event by event.
 *
 * One mapper per `requestHandler` invocation: a run's whole event stream goes in, the chat's
 * markdown and progress lines come out, in order. Anything the mapper does not recognize is
 * dropped, not guessed at — the daemon's vocabulary grows without breaking this side.
 */
export class DurableRunStreamMapper {
	/** Whether the current generation has been partially streamed — its end must then add nothing. */
	private sawDelta = false;

	consume(event: unknown): DurableStreamOutput {
		switch (eventType(event)) {
			case 'message_start':
				this.sawDelta = false;
				return {};
			case 'message_update': {
				const changes = recordOf(event)?.['changes'];
				if (!Array.isArray(changes)) {
					return {};
				}
				let text = '';
				for (const change of changes) {
					if (recordOf(change)?.['type'] === 'text_delta' && typeof recordOf(change)?.['delta'] === 'string') {
						text += recordOf(change)?.['delta'] as string;
					}
				}
				if (text.length === 0) {
					return {};
				}
				this.sawDelta = true;
				return { markdown: text };
			}
			case 'message_end': {
				// The renderer's rule: an assistant message the deltas already streamed is done;
				// one that arrives whole (no partials ever shown) is written here, and only here.
				if (this.sawDelta) {
					return {};
				}
				const text = assistantTextOfEntry(recordOf(event)?.['entry']);
				return text.length > 0 ? { markdown: text } : {};
			}
			case 'tool_execution_start': {
				const toolName = recordOf(event)?.['toolName'];
				return typeof toolName === 'string' && toolName.length > 0 ? { progress: toolName } : {};
			}
			case 'task_failed': {
				const message = recordOf(event)?.['message'];
				return typeof message === 'string' && message.length > 0 ? { warning: message } : {};
			}
			default:
				// entry_appended, run_end, retries, compactions, submissions: the run's plumbing.
				return {};
		}
	}
}
