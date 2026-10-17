/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * One streamed event of a provider endpoint, reduced to what the chat shows.
 *
 * The editor's model provider (`sendToEndpoint`) speaks two dialects of server-sent events,
 * and BOTH carry more than the answer's text: OpenAI-compatible endpoints stream the model's
 * reasoning as its own field (`reasoning_content`, GLM/DeepSeek style; `reasoning`, the
 * OpenRouter spelling), and the responses dialect streams reasoning summaries as their own
 * event type. A parser that only reads the answer text is why the model thought on record and
 * the chat showed nothing.
 *
 * Pure, so `node --test` pins the dialect table without a vscode import.
 */

/** The two dialects the editor's providers speak. */
export type ProviderApi = 'openai-completions' | 'openai-responses';

/** What one `data:` payload carried: the answer's text, the model's thinking, or both. */
export interface ProviderStreamParts {
	readonly text?: string;
	readonly thinking?: string;
}

/** One JSON object from an unknown string, or `undefined` when it is not one. */
function recordOf(payload: string): Record<string, unknown> | undefined {
	if (payload.length === 0) {
		return undefined;
	}
	try {
		// SAFETY: the payload is a streamed JSON event whose shape the dialect table below
		// knows; parsing hands it over as an untyped record and the table narrows it.
		const value: unknown = JSON.parse(payload);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

/** The choices array of a completions event, as far as it reads as one. */
function firstChoiceDelta(event: Record<string, unknown>): Record<string, unknown> | undefined {
	const choices = event['choices'] as unknown;
	if (!Array.isArray(choices) || choices.length === 0) {
		return undefined;
	}
	const delta = (choices[0] as { delta?: unknown })['delta'];
	return typeof delta === 'object' && delta !== null && !Array.isArray(delta)
		? delta as Record<string, unknown>
		: undefined;
}

/** A string field of a record, said as a string or not at all. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' ? value : undefined;
}

/**
 * The `data:` payload of one streamed event, parsed per dialect.
 *
 * Anything the dialect table does not name — keep-alives, usage events, the answer's own
 * `[DONE]` — comes back as no parts at all, which is how the caller knows to skip it.
 */
export function parseProviderStreamEvent(payload: string, api: ProviderApi): ProviderStreamParts | undefined {
	const event = recordOf(payload);
	if (event === undefined) {
		return undefined;
	}
	if (api === 'openai-responses') {
		const type = stringField(event, 'type');
		if (type === 'response.output_text.delta') {
			const text = stringField(event, 'delta');
			return text !== undefined ? { text } : undefined;
		}
		// The responses dialect streams the model's reasoning as its own event type, not as
		// a field of the answer's deltas — two spellings exist in the wild.
		if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
			const thinking = stringField(event, 'delta');
			return thinking !== undefined ? { thinking } : undefined;
		}
		return undefined;
	}
	const delta = firstChoiceDelta(event);
	if (delta === undefined) {
		return undefined;
	}
	// `reasoning_content` is what GLM, DeepSeek and pi's own compatible endpoints stream;
	// `reasoning` is the OpenRouter spelling of the same thing. Either, when present, is
	// the model thinking — never the answer.
	const thinking = stringField(delta, 'reasoning_content') ?? stringField(delta, 'reasoning');
	const text = stringField(delta, 'content');
	if (thinking === undefined && text === undefined) {
		return undefined;
	}
	return {
		...(text === undefined ? {} : { text }),
		...(thinking === undefined ? {} : { thinking }),
	};
}
