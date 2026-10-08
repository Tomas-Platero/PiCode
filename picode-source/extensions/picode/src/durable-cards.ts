/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable delegation, as a chat card.
 *
 * The bridge extension (`experimental/pi-durable-bridge/extension.ts`) registers pi tools that
 * hand work to the durable daemon; `durable_send` is the delegation tool among them. When the
 * chat's model calls it, the turn shows a subagent card for that work — the same shape the
 * chat's renderer already knows how to draw (`vscode.ChatSubagentToolInvocationData`), but the
 * identity on it is **durable's own**: the conversation id and run status the tool's result
 * details carry, never an invented one.
 *
 * No `vscode` import, and every mapping is a pure function of the pi tool event — the same
 * rule `durable-tasks.ts` keeps, so `node --test` can run this file directly.
 */

/** The bridge's delegation tool: the only one that becomes a card. */
export const DURABLE_SEND_TOOL = 'durable_send';

/** Whether pi is delegating to the durable daemon. */
export function isDurableDelegationTool(toolName: unknown): boolean {
	return toolName === DURABLE_SEND_TOOL;
}

/** The longest a delegated prompt gets in a card: it is a pointer, not a transcript. */
export const CARD_PROMPT_CHARS = 200;

/** The longest a delegated result gets in a card: the answer, not the whole transcript. */
export const CARD_RESULT_CHARS = 2000;

/** A string capped for a card, with an ellipsis where it was cut. */
function cardText(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/**
 * The delegated prompt, as the tool's arguments carry it.
 *
 * The bridge's parameter is `prompt`; any other shape falls back to the arguments as JSON,
 * because a card without its question is not worth drawing.
 */
export function durablePromptOf(args: unknown): string | undefined {
	const prompt = recordOf(args)?.['prompt'];
	if (typeof prompt === 'string' && prompt.length > 0) {
		return cardText(prompt, CARD_PROMPT_CHARS);
	}
	if (args === undefined || args === null) {
		return undefined;
	}
	try {
		return cardText(JSON.stringify(args), CARD_PROMPT_CHARS);
	} catch {
		return undefined;
	}
}

/** The text a finished tool returned, as the card wants it. */
export function durableResultOf(result: unknown): string | undefined {
	const content = recordOf(result)?.['content'];
	if (!Array.isArray(content)) {
		return undefined;
	}
	const text = content
		.map(part => {
			const record = recordOf(part);
			return record?.['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : '';
		})
		.filter(part => part.length > 0)
		.join('\n');
	return text.length === 0 ? undefined : cardText(text, CARD_RESULT_CHARS);
}

/** The durable correlation a finished `durable_send` reports, from the result's details. */
export function durableDetailsOf(result: unknown): { conversationId?: number; status?: string } | undefined {
	const details = recordOf(recordOf(result)?.['details']);
	if (details === undefined) {
		return undefined;
	}
	const conversationId = details['conversationId'];
	const status = details['status'];
	return {
		...(typeof conversationId === 'number' && Number.isFinite(conversationId) ? { conversationId } : {}),
		...(typeof status === 'string' && status.length > 0 ? { status } : {}),
	};
}

/**
 * What a durable card carries at each stage.
 *
 * At `tool_execution_start` the card names the daemon and its prompt; at `tool_execution_end`
 * it gains the durable conversation the work became, the run status and the answer. The
 * renderer updates the same card in place because every push carries the same `toolCallId`
 * and `enablePartialUpdate`.
 */
export interface DurableCardData {
	readonly agentName: string;
	readonly description?: string;
	readonly prompt?: string;
	readonly result?: string;
	readonly complete?: boolean;
	readonly isError?: boolean;
}

/** The description a start card carries: what the card is a window onto. */
const START_DESCRIPTION = 'Runs in the durable daemon — the work survives even if this session is closed.';

/**
 * The card for one `durable_send` call, or `undefined` for any other tool.
 *
 * `result === undefined` is the start of the call; anything else is its end, shaped as pi
 * delivers a tool result (`content` parts, `details` carrying the bridge's correlation).
 * When the daemon is down the tool fails, and the card says that — the error text pi put
 * in the result — instead of a card that pretends nothing was asked.
 */
export function durableCard(toolName: unknown, args: unknown, result: unknown, isError: boolean): DurableCardData | undefined {
	if (!isDurableDelegationTool(toolName)) {
		return undefined;
	}
	const prompt = durablePromptOf(args);
	if (result === undefined) {
		return {
			agentName: 'durable agent',
			description: START_DESCRIPTION,
			...(prompt === undefined ? {} : { prompt }),
		};
	}
	const details = durableDetailsOf(result);
	const text = durableResultOf(result);
	// The identity is durable's own: which conversation the work became, and how its run
	// ended. A run status is said where it is known and left out where it is not.
	const agentName = details?.conversationId === undefined
		? 'durable agent'
		: `durable conversation ${details.conversationId}`;
	const description = isError
		? 'The durable daemon could not run it.'
		: details?.status === undefined
			? START_DESCRIPTION
			: `Run ${details.status} in the durable daemon.`;
	return {
		agentName,
		description,
		...(prompt === undefined ? {} : { prompt }),
		...(text === undefined ? {} : { result: text }),
		complete: true,
		...(isError ? { isError } : {}),
	};
}
