/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The subscription-usage reader, run on its own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `usage-data.ts` carries no local imports and no `vscode`: the parsing, the meter selection
 * and the cache lifetime are the parts worth exercising, and none of them needs an editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	fetchNanUsage,
	getCachedNanUsage,
	isNanProvider,
	matchedNanProvider,
	nanModelUsage,
	nanUsageSummary,
	parseNanQuota,
	resolveNanApiKey,
	NAN_QUOTA_URL,
	type NanFetch,
	type NanUsage,
} from '../src/usage-data.ts';

/** A fixed instant, so reset math never depends on the day the test runs. */
const NOW = 1_800_000_000_000;

/** The payload the dashboard answers with, reduced to the fields this reader uses. */
function quotaPayload(models: ReadonlyArray<Record<string, unknown>>, periodEnd?: string): Record<string, unknown> {
	return { ...(periodEnd === undefined ? {} : { periodEnd }), models };
}

test('parseNanQuota reads the period allowance and the rolling window', () => {
	const payload = quotaPayload(
		[{
			model: 'glm5.3-flash',
			cap: 600,
			fullCap: 600,
			tokensUsed: 120,
			windowTokensUsed: 132_000_000,
			fullWindowTokens: 400_000_000,
			windowHours: 4,
		}],
		new Date(NOW + 25 * 3_600_000).toISOString(),
	);

	const usage = parseNanQuota(payload, NOW);

	assert.strictEqual(usage.limits.length, 1);
	const [limit] = usage.limits;
	assert.strictEqual(limit.name, 'glm5.3-flash');
	assert.strictEqual(limit.limitReached, false);
	assert.strictEqual(limit.windows.length, 2);

	const [period, rolling] = limit.windows;
	// 120 of 600 is 20%, and the period carries the raw numbers so a surface can aggregate.
	assert.strictEqual(period.usedPercent, 20);
	assert.strictEqual(period.used, 120);
	assert.strictEqual(period.budget, 600);
	assert.strictEqual(period.label, '');
	assert.strictEqual(period.windowSeconds, 25 * 3_600);

	// 132M of 400M is 33%, named by its own length.
	assert.strictEqual(rolling.label, '4h');
	assert.strictEqual(rolling.usedPercent, 33);
	assert.strictEqual(rolling.windowSeconds, 4 * 3_600);
	assert.strictEqual(rolling.resetAt, null);

	assert.strictEqual(nanUsageSummary(usage, 'glm5.3-flash'), 'glm5.3-flash: 33% of the 4-hour window · 20% of the billing period');
});

test('parseNanQuota fails the whole read when a metered model reports no usage', () => {
	const usage = parseNanQuota(quotaPayload([{ model: 'glm5.3-flash', fullCap: 600 }]), NOW);

	// Not a skipped model: a metered allowance whose usage cannot be read would understate
	// every number that follows it, so nothing is returned at all.
	assert.deepStrictEqual(usage.limits, []);
});

test('parseNanQuota skips a model that reports no allowance at all', () => {
	const usage = parseNanQuota(quotaPayload([{ model: 'glm5.3-flash', tokensUsed: 120 }]), NOW);

	assert.deepStrictEqual(usage.limits, []);
});

test('parseNanQuota uses the published rolling defaults when the payload names none', () => {
	const payload = quotaPayload([{ model: 'glm5.3-flash', fullCap: 600, tokensUsed: 120, windowTokensUsed: 132_000_000 }]);

	const usage = parseNanQuota(payload, NOW);
	const rolling = usage.limits[0].windows[1];

	// 400M of budget and 4h of window: the defaults the dashboard itself falls back to.
	assert.strictEqual(rolling.label, '4h');
	assert.strictEqual(rolling.windowSeconds, 4 * 3_600);
	assert.strictEqual(rolling.usedPercent, 33);
});

test('parseNanQuota refuses a payload that carries no models at all', () => {
	assert.deepStrictEqual(parseNanQuota(undefined, NOW).limits, []);
	assert.deepStrictEqual(parseNanQuota({ models: 'not a list' }, NOW).limits, []);
});

test('nanModelUsage picks by model id, by the single meter, or not at all', () => {
	const one = parseNanQuota(quotaPayload([{ model: 'glm5.3-flash', fullCap: 600, tokensUsed: 120 }]), NOW);
	const two = parseNanQuota(quotaPayload([
		{ model: 'glm5.3-flash', fullCap: 600, tokensUsed: 120 },
		{ model: 'glm5.2', fullCap: 600, tokensUsed: 300 },
	]), NOW);

	assert.strictEqual(nanModelUsage(two, 'glm5.2')?.name, 'glm5.2');
	// A payload naming one meter is that meter even when the session's id differs.
	assert.strictEqual(nanModelUsage(one, 'renamed-by-the-provider')?.name, 'glm5.3-flash');
	// Several meters, none of them this model: no honest answer.
	assert.strictEqual(nanModelUsage(two, 'gpt-5'), undefined);
	// No model id at all still resolves a single-meter payload.
	assert.strictEqual(nanModelUsage(one, undefined)?.name, 'glm5.3-flash');
	assert.strictEqual(nanModelUsage(two, undefined), undefined);
});

test('nanUsageSummary prints tightest window first, and nothing without a meter', () => {
	const usage = parseNanQuota(quotaPayload([{
		model: 'glm5.3-flash',
		fullCap: 600,
		tokensUsed: 72,
		windowTokensUsed: 200_000_000,
		fullWindowTokens: 400_000_000,
	}]), NOW);

	assert.strictEqual(nanUsageSummary(usage, 'glm5.3-flash'), 'glm5.3-flash: 50% of the 4-hour window · 12% of the billing period');

	// The fail-whole payload carries no meter, so the row has nothing to say.
	assert.strictEqual(nanUsageSummary(parseNanQuota(quotaPayload([{ model: 'glm5.3-flash', fullCap: 600 }]), NOW), 'glm5.3-flash'), undefined);
});

test('isNanProvider recognizes NaN by id or by address', () => {
	assert.strictEqual(isNanProvider({ id: 'nan', baseUrl: 'https://anything.example/v1' }), true);
	assert.strictEqual(isNanProvider({ id: 'my-nan', baseUrl: 'https://api.nan.builders/v1' }), true);
	assert.strictEqual(isNanProvider({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }), false);
});

test('matchedNanProvider requires the session provider and the declaration to agree', () => {
	const refs = [
		{ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', key: 'sk-openrouter' },
		{ id: 'my-nan', baseUrl: 'https://api.nan.builders/v1', key: 'sk-nan' },
		{ id: 'nan', baseUrl: 'https://openrouter.ai/api/v1', key: 'sk-by-id' },
	];

	// Endpoint says NaN, and the session's provider id is the one declared for it.
	assert.strictEqual(matchedNanProvider(refs, 'my-nan')?.key, 'sk-nan');
	// Id says NaN even though the address does not.
	assert.strictEqual(matchedNanProvider(refs, 'nan')?.key, 'sk-by-id');
	// A NaN entry exists, but the session is on somebody else: no meter of ours to draw.
	assert.strictEqual(matchedNanProvider(refs, 'openrouter'), undefined);
	assert.strictEqual(matchedNanProvider(refs, 'unconfigured'), undefined);
	assert.strictEqual(matchedNanProvider(refs, undefined), undefined);
	assert.strictEqual(matchedNanProvider(refs, ''), undefined);
});

test('resolveNanApiKey prefers a literal, then the environment, then auth.json', () => {
	// A literal in the settings entry wins outright.
	assert.strictEqual(resolveNanApiKey({ declared: 'sk-literal', environment: { NAN_KEY: 'sk-env' }, stored: 'sk-stored' }), 'sk-literal');

	// `$NAME` and `$env:NAME` (any case) read the environment.
	assert.strictEqual(resolveNanApiKey({ declared: '$NAN_KEY', environment: { NAN_KEY: 'sk-env' }, stored: 'sk-stored' }), 'sk-env');
	assert.strictEqual(resolveNanApiKey({ declared: '$env:NAN_KEY', environment: { NAN_KEY: 'sk-env' }, stored: 'sk-stored' }), 'sk-env');
	assert.strictEqual(resolveNanApiKey({ declared: '$ENV:nan_key', environment: { nan_key: 'sk-env' }, stored: 'sk-stored' }), 'sk-env');

	// An unset variable is not a key: the stored credential still gets its turn.
	assert.strictEqual(resolveNanApiKey({ declared: '$NAN_KEY', environment: {}, stored: 'sk-stored' }), 'sk-stored');
	assert.strictEqual(resolveNanApiKey({ declared: '$NAN_KEY', environment: { NAN_KEY: '   ' }, stored: 'sk-stored' }), 'sk-stored');

	// A `!command` key is never the credential, and never something to run.
	assert.strictEqual(resolveNanApiKey({ declared: '!op read secret/nan', environment: { NAN_KEY: 'sk-env' }, stored: 'sk-stored' }), 'sk-stored');
	assert.strictEqual(resolveNanApiKey({ declared: '!op read secret/nan' }), undefined);

	// Nothing declared: the stored credential, or nothing at all.
	assert.strictEqual(resolveNanApiKey({ stored: 'sk-stored' }), 'sk-stored');
	assert.strictEqual(resolveNanApiKey({}), undefined);
	assert.strictEqual(resolveNanApiKey({ declared: '  ', stored: '  ' }), undefined);
});

test('fetchNanUsage sends the key, refuses redirects and reads nothing from the store', async () => {
	let seen: { url: string; init: Parameters<NanFetch>[1] } | undefined;
	const fetchFn: NanFetch = async (url, init) => {
		seen = { url, init };
		return { ok: true, json: async () => quotaPayload([{ model: 'glm5.3-flash', fullCap: 600, tokensUsed: 120 }]) };
	};

	const usage = await fetchNanUsage('secret-key', fetchFn, NOW);

	assert.strictEqual(seen?.url, NAN_QUOTA_URL);
	assert.strictEqual(seen?.init.headers['Authorization'], 'Bearer secret-key');
	assert.strictEqual(seen?.init.redirect, 'error');
	assert.strictEqual(seen?.init.cache, 'no-store');
	assert.strictEqual(usage?.limits[0].name, 'glm5.3-flash');
});

test('fetchNanUsage answers undefined for every failure, and never throws', async () => {
	const notOk: NanFetch = async () => ({ ok: false, json: async () => ({}) });
	const throws: NanFetch = async () => { throw new Error('offline'); };
	const empty: NanFetch = async () => ({ ok: true, json: async () => quotaPayload([{ model: 'glm5.3-flash', fullCap: 600 }]) });

	assert.strictEqual(await fetchNanUsage('k', notOk, NOW), undefined);
	assert.strictEqual(await fetchNanUsage('k', throws, NOW), undefined);
	// A payload with no readable meter is a broken snapshot, not a snapshot of zero.
	assert.strictEqual(await fetchNanUsage('k', empty, NOW), undefined);
	assert.strictEqual(await fetchNanUsage('', notOk, NOW), undefined);
});

test('the cache reuses a good snapshot for 60s and refetches after it', async () => {
	let calls = 0;
	const fetchFn: NanFetch = async () => {
		calls += 1;
		return { ok: true, json: async () => quotaPayload([{ model: `glm5.3-flash`, fullCap: 600, tokensUsed: 120 }]) };
	};

	const first = await getCachedNanUsage('ttl-key', NOW, fetchFn);
	assert.strictEqual(calls, 1);
	assert.strictEqual(first.fresh, true);
	assert.strictEqual(first.value?.limits.length, 1);

	// Still inside the lifetime: the endpoint is not asked again.
	const second = await getCachedNanUsage('ttl-key', NOW + 59_000, fetchFn);
	assert.strictEqual(calls, 1);
	assert.strictEqual(second.fresh, true);
	assert.strictEqual(second.value, first.value);

	// Past the lifetime: one more read.
	await getCachedNanUsage('ttl-key', NOW + 60_001, fetchFn);
	assert.strictEqual(calls, 2);
});

test('a failed refresh keeps the last good snapshot and says it is stale', async () => {
	let calls = 0;
	let failedCalls = 0;
	const good: NanFetch = async () => {
		calls += 1;
		return { ok: true, json: async () => quotaPayload([{ model: 'glm5.3-flash', fullCap: 600, tokensUsed: 120 }]) };
	};
	const bad: NanFetch = async () => {
		failedCalls += 1;
		throw new Error('offline');
	};

	const fresh = await getCachedNanUsage('stale-key', NOW, good);
	assert.strictEqual(calls, 1);

	const stale = await getCachedNanUsage('stale-key', NOW + 60_001, bad);
	assert.strictEqual(stale.fresh, false);
	assert.deepStrictEqual(stale.value, fresh.value);

	// The failed attempt is itself rate-limited: the next five-second refresh does not
	// hammer an endpoint that is down.
	const again = await getCachedNanUsage('stale-key', NOW + 65_000, bad);
	assert.strictEqual(failedCalls, 1);
	assert.strictEqual(again.fresh, false);
});

test('the cache keeps providers apart by their key', async () => {
	const fetchFn: NanFetch = async () => ({ ok: true, json: async () => quotaPayload([{ model: 'glm5.3-flash', fullCap: 600, tokensUsed: 120 }]) });

	const one = await getCachedNanUsage('provider-one', NOW, fetchFn);
	const other = await getCachedNanUsage('provider-two', NOW, fetchFn);

	assert.notStrictEqual(one.value, other.value);
});

test('a fetch that outlives its budget resolves without a value', async () => {
	const hanging: NanFetch = () => new Promise(() => { /* never answers */ });

	const cached: NanUsage | undefined = (await getCachedNanUsage('timeout-key', NOW, hanging)).value;
	assert.strictEqual(cached, undefined);
});
