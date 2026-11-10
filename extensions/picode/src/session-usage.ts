/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The session's usage totals, worked out from pi's own entries.
 *
 * Two kinds of entry carry spend. Assistant messages carry the turn's tokens and cost. Since pi
 * 1.5.1, `usage` entries carry what pi spent between turns to keep the prompt cache warm
 * ("Cache warmed: $X" in its terminal); they have no message, so a walk over messages alone
 * would leave the total low. Their cost is added; their tokens are not, because they are not part
 * of the conversation and must not move the context occupancy.
 */

/** The live session's usage totals and current selection, as the status view shows them. */
export interface SessionUsage {
	readonly ctxTokens?: number;
	readonly cost?: number;
	readonly costEstimated?: boolean;
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly model?: string;
	readonly thinkingLevel?: string;
}

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** A finite number from an unknown value, or `undefined` when it is not one. */
function numberOf(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Totals for a session's entries; empty when no entry carries usage. */
export function summariseSessionUsage(entries: ReadonlyArray<Record<string, unknown>>): SessionUsage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let costEstimated = false;
	let hasUsage = false;
	let ctxTokens: number | undefined;
	let model: string | undefined;
	let thinkingLevel: string | undefined;
	for (const entry of entries) {
		if (entry['type'] === 'message') {
			// Usage lives nested under `message`, and only assistant messages carry it.
			const message = recordOf(entry['message']);
			if (message?.['role'] !== 'assistant') {
				continue;
			}
			const usage = recordOf(message['usage']);
			if (usage === undefined) {
				continue;
			}
			hasUsage = true;
			const turnInput = numberOf(usage['input']) ?? 0;
			const turnCacheRead = numberOf(usage['cacheRead']) ?? 0;
			const turnCacheWrite = numberOf(usage['cacheWrite']) ?? 0;
			input += turnInput;
			output += numberOf(usage['output']) ?? 0;
			cacheRead += turnCacheRead;
			cacheWrite += turnCacheWrite;
			// Occupancy is what the last prompt actually cost: fresh input plus everything
			// read from or written to the cache. The last answer's output is not in yet.
			ctxTokens = turnInput + turnCacheRead + turnCacheWrite;
			const turnCost = recordOf(usage['cost']);
			const turnTotal = numberOf(turnCost?.['total']) ?? 0;
			cost += turnTotal;
			// pi 1.5 marks the cost the provider itself billed; a priced turn without that mark
			// was worked out from the model catalogue, so the total is an estimate.
			if (turnTotal > 0 && numberOf(turnCost?.['totalFromProvider']) === undefined) {
				costEstimated = true;
			}
			continue;
		}
		if (entry['type'] === 'usage') {
			// Spend between turns (cache warming): cost only, never tokens or occupancy.
			const warmCost = recordOf(recordOf(entry['usage'])?.['cost']);
			const warmTotal = numberOf(warmCost?.['total']) ?? 0;
			if (warmTotal > 0) {
				hasUsage = true;
				cost += warmTotal;
				if (numberOf(warmCost?.['totalFromProvider']) === undefined) {
					costEstimated = true;
				}
			}
			continue;
		}
		if (entry['type'] === 'model_change') {
			const providerId = entry['provider'];
			const modelId = entry['modelId'];
			if (typeof providerId === 'string' && typeof modelId === 'string') {
				model = `${providerId}/${modelId}`;
			}
			continue;
		}
		if (entry['type'] === 'thinking_level_change') {
			const level = entry['thinkingLevel'];
			if (typeof level === 'string') {
				thinkingLevel = level;
			}
		}
	}
	return {
		...(model === undefined ? {} : { model }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		...(hasUsage ? { ctxTokens, input, output, cacheRead, cacheWrite, cost, costEstimated } : {}),
	};
}
