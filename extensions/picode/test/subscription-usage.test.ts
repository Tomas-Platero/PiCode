/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChatGPT's and Claude's subscription windows, run on its own: the header and payload parsing,
 * the sign-in rule, the cache and the merge of the two routes.
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	accountIdFromToken,
	clearUsageFromResponses,
	codexSignIn,
	CODEX_USAGE_URL,
	getCachedCodexUsage,
	newestUsage,
	parseCodexUsage,
	parseUsageHeaders,
	recordUsageHeaders,
	usageFromResponses,
	type UsageFetch,
} from '../src/subscription-usage.ts';

/** A fixed instant, so reset math never depends on the day the test runs. */
const NOW = 1_800_000_000_000;

/** A token whose claims carry a ChatGPT account id, as Codex sign-ins do. */
function tokenFor(accountId: string): string {
	const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
	return `header.${claims}.signature`;
}

function codexPayload(): Record<string, unknown> {
	return {
		plan_type: 'plus',
		rate_limit: {
			limit_reached: false,
			primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 600 },
			secondary_window: { used_percent: 10, limit_window_seconds: 604_800, reset_at: 1_800_100_000 },
		},
		additional_rate_limits: [{ limit_name: 'gpt-5-codex-mini', rate_limit: { limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18_000 } } }],
	};
}

test('parseCodexUsage reads the account windows and the extra allowances', () => {
	const usage = parseCodexUsage(codexPayload(), NOW);
	assert.strictEqual(usage.plan, 'Plus');
	assert.strictEqual(usage.limits.length, 2);
	const [main, extra] = usage.limits;
	assert.strictEqual(main.name, 'ChatGPT Plus');
	assert.deepStrictEqual(main.windows.map(window => window.label), ['5h', 'week']);
	assert.strictEqual(main.windows[0].resetAt, NOW + 600_000);
	assert.strictEqual(main.windows[1].resetAt, 1_800_100_000_000);
	assert.strictEqual(extra.name, 'ChatGPT Plus · gpt-5-codex-mini');
	assert.strictEqual(extra.limitReached, true);
});

test('parseCodexUsage drops what it cannot read instead of coercing it', () => {
	const usage = parseCodexUsage({ rate_limit: { primary_window: { used_percent: '42', limit_window_seconds: 18_000 } }, additional_rate_limits: 'nope' }, NOW);
	assert.deepStrictEqual(usage.limits, []);
	assert.deepStrictEqual(parseCodexUsage(null, NOW).limits, []);
});

test('parseUsageHeaders reads Codex response headers', () => {
	const usage = parseUsageHeaders({
		'x-codex-primary-used-percent': '55.5',
		'x-codex-primary-window-minutes': '300',
		'x-codex-primary-reset-at': '1800003600',
		'x-codex-secondary-used-percent': '12',
		'x-codex-secondary-window-minutes': '10080',
	}, NOW);
	assert.ok(usage !== undefined);
	assert.strictEqual(usage.provider, 'openai-codex');
	assert.deepStrictEqual(usage.limits[0].windows.map(window => [window.label, window.usedPercent]), [['5h', 55.5], ['week', 12]]);
	assert.strictEqual(usage.limits[0].windows[0].resetAt, 1_800_003_600_000);
	assert.strictEqual(usage.limits[0].limitReached, false);
});

test('parseUsageHeaders reads Claude response headers as percentages', () => {
	const usage = parseUsageHeaders({
		'Anthropic-Ratelimit-Unified-5h-Utilization': '0.25',
		'anthropic-ratelimit-unified-5h-reset': '1800001000',
		'anthropic-ratelimit-unified-7d-utilization': '0.9',
		'anthropic-ratelimit-unified-status': 'rejected',
	}, NOW);
	assert.ok(usage !== undefined);
	assert.strictEqual(usage.provider, 'anthropic');
	assert.strictEqual(usage.limits[0].name, 'Claude');
	assert.deepStrictEqual(usage.limits[0].windows.map(window => [window.label, window.usedPercent]), [['5h', 25], ['week', 90]]);
	assert.strictEqual(usage.limits[0].windows[1].resetAt, null);
	assert.strictEqual(usage.limits[0].limitReached, true);
});

test('a window without a length is not a window', () => {
	assert.strictEqual(parseUsageHeaders({ 'x-codex-primary-used-percent': '10' }, NOW), undefined);
	assert.strictEqual(parseUsageHeaders({ 'content-type': 'text/event-stream' }, NOW), undefined);
});

test('recordUsageHeaders keeps the newest snapshot per provider and ignores the rest', () => {
	clearUsageFromResponses();
	recordUsageHeaders({ 'content-type': 'text/event-stream' }, NOW);
	assert.strictEqual(usageFromResponses('anthropic'), undefined);
	recordUsageHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.1' }, NOW);
	recordUsageHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.3' }, NOW + 1);
	assert.strictEqual(usageFromResponses('anthropic')?.limits[0].windows[0].usedPercent, 30);
	clearUsageFromResponses();
});

test('accountIdFromToken reads the claim and refuses anything else', () => {
	assert.strictEqual(accountIdFromToken(tokenFor('acct-1')), 'acct-1');
	assert.strictEqual(accountIdFromToken('not-a-jwt'), undefined);
	assert.strictEqual(accountIdFromToken('a.%%%.c'), undefined);
});

test('codexSignIn uses a sign-in still in date and never an expired or keyed one', () => {
	assert.deepStrictEqual(codexSignIn({ type: 'oauth', access: tokenFor('acct-1'), expires: NOW + 1000 }, NOW), { token: tokenFor('acct-1'), accountId: 'acct-1' });
	assert.deepStrictEqual(codexSignIn({ type: 'oauth', access: 'opaque', accountId: 'acct-2' }, NOW), { token: 'opaque', accountId: 'acct-2' });
	assert.strictEqual(codexSignIn({ type: 'oauth', access: tokenFor('acct-1'), expires: NOW }, NOW), undefined);
	assert.strictEqual(codexSignIn({ type: 'api_key', key: 'sk' }, NOW), undefined);
	assert.strictEqual(codexSignIn({ type: 'oauth', access: 'opaque' }, NOW), undefined);
	assert.strictEqual(codexSignIn(undefined, NOW), undefined);
});

test('getCachedCodexUsage asks once a minute and keeps the last good read on failure', async () => {
	const signIn = { token: tokenFor('acct-cache'), accountId: 'acct-cache' };
	const calls: { url: string; headers: Record<string, string> }[] = [];
	let answer = true;
	const fetchFn: UsageFetch = async (url, init) => {
		calls.push({ url, headers: init.headers });
		return { ok: answer, json: async () => codexPayload() };
	};
	const first = await getCachedCodexUsage(signIn, NOW, fetchFn);
	assert.strictEqual(first.fresh, true);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].url, CODEX_USAGE_URL);
	assert.strictEqual(calls[0].headers['chatgpt-account-id'], 'acct-cache');
	await getCachedCodexUsage(signIn, NOW + 30_000, fetchFn);
	assert.strictEqual(calls.length, 1);
	answer = false;
	const stale = await getCachedCodexUsage(signIn, NOW + 61_000, fetchFn);
	assert.strictEqual(calls.length, 2);
	assert.strictEqual(stale.fresh, false);
	assert.strictEqual(stale.value?.limits[0].name, 'ChatGPT Plus');
});

test('newestUsage keeps the endpoint extras when a response is newer', () => {
	const endpoint = parseCodexUsage(codexPayload(), NOW);
	const response = parseUsageHeaders({ 'x-codex-primary-used-percent': '80', 'x-codex-primary-window-minutes': '300' }, NOW + 5_000);
	const merged = newestUsage(endpoint, response);
	assert.ok(merged !== undefined);
	assert.strictEqual(merged.limits.length, 2);
	assert.strictEqual(merged.limits[0].name, 'ChatGPT Plus');
	assert.strictEqual(merged.limits[0].windows[0].usedPercent, 80);
	assert.strictEqual(merged.limits[1].name, 'ChatGPT Plus · gpt-5-codex-mini');
	assert.strictEqual(newestUsage(endpoint, parseUsageHeaders({ 'x-codex-primary-used-percent': '1', 'x-codex-primary-window-minutes': '300' }, NOW - 1)), endpoint);
	assert.strictEqual(newestUsage(undefined, response), response);
	assert.strictEqual(newestUsage(undefined, undefined), undefined);
});
