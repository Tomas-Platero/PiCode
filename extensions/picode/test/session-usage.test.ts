/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the Status cost card adds up.
 *
 * Since pi 1.5.1 the cache is kept warm between turns, and that spend is stored as `usage`
 * entries with no message. The total has to include it, but the context occupancy must not move.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summariseSessionUsage } from '../src/session-usage.ts';

function answer(cost: number, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'message',
		message: {
			role: 'assistant',
			usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, cost: { total: cost, totalFromProvider: cost }, ...over },
		},
	};
}

function warm(cost: number, billed = true): Record<string, unknown> {
	return {
		type: 'usage',
		kind: 'cache_warm',
		usage: { input: 1, output: 1, cacheRead: 9000, cacheWrite: 0, cost: billed ? { total: cost, totalFromProvider: cost } : { total: cost } },
	};
}

test('the cost adds the turns and the cache warms between them', () => {
	const usage = summariseSessionUsage([answer(0.5), warm(0.02), warm(0.03), answer(0.25)]);
	assert.ok(Math.abs((usage.cost ?? 0) - 0.8) < 1e-9);
});

test('cache warms do not move the tokens or the context occupancy', () => {
	const withWarm = summariseSessionUsage([answer(0.5), warm(0.02)]);
	const without = summariseSessionUsage([answer(0.5)]);
	assert.equal(withWarm.ctxTokens, without.ctxTokens);
	assert.equal(withWarm.input, without.input);
	assert.equal(withWarm.cacheRead, without.cacheRead);
});

test('a session with only cache warms still shows its cost', () => {
	const usage = summariseSessionUsage([warm(0.04)]);
	assert.equal(usage.cost, 0.04);
});

test('a warm without the provider mark makes the total an estimate', () => {
	assert.equal(summariseSessionUsage([answer(0.5), warm(0.02, true)]).costEstimated, false);
	assert.equal(summariseSessionUsage([answer(0.5), warm(0.02, false)]).costEstimated, true);
});

test('entries without a priced usage change nothing', () => {
	const usage = summariseSessionUsage([{ type: 'usage', kind: 'cache_warm' }, { type: 'usage', usage: { cost: { total: 0 } } }]);
	assert.deepEqual(usage, {});
});

test('the model and thinking level still come from their entries', () => {
	const usage = summariseSessionUsage([
		{ type: 'model_change', provider: 'omni', modelId: 'deepseek' },
		{ type: 'thinking_level_change', thinkingLevel: 'high' },
		answer(0.1),
	]);
	assert.equal(usage.model, 'omni/deepseek');
	assert.equal(usage.thinkingLevel, 'high');
});
