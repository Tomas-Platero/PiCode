/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Subscription usage for the two sign-in providers: ChatGPT (Codex) and Claude Pro/Max.
 *
 * `usage-data.ts` reads NaN's quota; this is the other half of what gentle-pi's usage panel shows
 * in the terminal, ported to the Status view's Usage limits card. Two routes, the same two the
 * terminal uses:
 *
 * - **Response headers.** Both providers report their rate-limit windows on every chat response.
 *   pi hands those headers to its extensions (`after_provider_response`); the chat's own inline
 *   extension (`agent.ts`) passes them here, and the last snapshot per provider is kept in memory.
 * - **Codex's usage endpoint**, the one the Codex CLI reads, with the sign-in pi already holds. It
 *   answers before the first turn and between turns. Claude has no such endpoint, so its card
 *   appears with the first Claude response.
 *
 * Nothing about the account is kept beyond the plan name: the token travels in a header only, the
 * request refuses redirects, and the cache is keyed by a digest of the token.
 *
 * Like `usage-data.ts`, this file has no `vscode` import and no relative imports, so its parsing
 * and its cache can be exercised by running them.
 */

import { createHash } from 'node:crypto';

export const CODEX_PROVIDER = 'openai-codex';
export const ANTHROPIC_PROVIDER = 'anthropic';

/** What the Codex CLI itself reads; the sign-in's account id rides along. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** How long a Codex read is reused: the Status view refreshes every five seconds. */
export const CODEX_CACHE_TTL_MS = 60_000;

/** A read slower than this gives up; the next tick tries again. */
const CODEX_FETCH_TIMEOUT_MS = 4_000;

const CODEX_ACCOUNT_CLAIM = 'https://api.openai.com/auth';
const CODEX_HEADER_PREFIX = 'x-codex-';
const ANTHROPIC_HEADER_PREFIX = 'anthropic-ratelimit-unified-';
const ANTHROPIC_WINDOWS: ReadonlyArray<readonly [key: string, seconds: number]> = [
	['5h', 18_000],
	['7d', 604_800],
];

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 604_800;

/** One window an allowance is measured over; the same shape `usage-data.ts` uses for NaN. */
export interface UsageWindow {
	readonly label: string;
	readonly usedPercent: number;
	readonly windowSeconds: number;
	readonly resetAt: number | null;
}

/** One allowance: its name as the card prints it, and its windows. */
export interface UsageLimit {
	readonly name: string;
	readonly windows: UsageWindow[];
	readonly limitReached: boolean;
}

/** One provider's snapshot. */
export interface ProviderUsage {
	readonly provider: string;
	readonly plan: string | undefined;
	readonly limits: UsageLimit[];
	readonly fetchedAt: number;
}

/** The one thing this module asks of the network; a test passes a function answering two fields. */
export type UsageFetch = (
	url: string,
	init: { headers: Record<string, string>; redirect: 'error'; cache: 'no-store' },
) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** How a window is named, from its length: `5h`, `7d`, `week`, `30m`. */
function windowLabel(seconds: number): string {
	if (seconds === WEEK) {
		return 'week';
	}
	if (seconds >= DAY && seconds % DAY === 0) {
		return `${seconds / DAY}d`;
	}
	if (seconds >= HOUR && seconds % HOUR === 0) {
		return `${seconds / HOUR}h`;
	}
	return `${Math.round(seconds / MINUTE)}m`;
}

/** How a plan reads: `plus` becomes `Plus`. */
function planName(plan: string | undefined): string | undefined {
	return plan === undefined || plan.length === 0 ? undefined : plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** The card's name for a Codex allowance: the main one is the account, an extra one says its own name. */
function codexLimitName(limit: string | undefined, plan: string | undefined): string {
	const account = plan === undefined ? 'ChatGPT' : `ChatGPT ${plan}`;
	return limit === undefined ? account : `${account} · ${limit}`;
}

function parseCodexWindow(raw: unknown, now: number): UsageWindow | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const used = raw['used_percent'];
	const seconds = raw['limit_window_seconds'];
	if (!isFiniteNumber(used) || !isFiniteNumber(seconds) || seconds <= 0) {
		return undefined;
	}
	const resetAt = isFiniteNumber(raw['reset_at'])
		? raw['reset_at'] * 1000
		: isFiniteNumber(raw['reset_after_seconds']) ? now + raw['reset_after_seconds'] * 1000 : null;
	return { label: windowLabel(seconds), usedPercent: used, windowSeconds: seconds, resetAt };
}

function parseCodexRateLimit(name: string, raw: unknown, now: number): UsageLimit | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const windows = [parseCodexWindow(raw['primary_window'], now), parseCodexWindow(raw['secondary_window'], now)]
		.filter((window): window is UsageWindow => window !== undefined);
	return windows.length === 0 ? undefined : { name, windows, limitReached: raw['limit_reached'] === true };
}

/** Codex's usage payload, read defensively: anything unreadable is dropped, never coerced. */
export function parseCodexUsage(payload: unknown, now: number): ProviderUsage {
	const raw = isRecord(payload) ? payload : {};
	const plan = planName(typeof raw['plan_type'] === 'string' ? raw['plan_type'] : undefined);
	const limits: UsageLimit[] = [];
	const main = parseCodexRateLimit(codexLimitName(undefined, plan), raw['rate_limit'], now);
	if (main !== undefined) {
		limits.push(main);
	}
	const extras = raw['additional_rate_limits'];
	if (Array.isArray(extras)) {
		for (const extra of extras) {
			if (!isRecord(extra)) {
				continue;
			}
			const name = typeof extra['limit_name'] === 'string' && extra['limit_name'].length > 0 ? extra['limit_name'] : 'limit';
			const limit = parseCodexRateLimit(codexLimitName(name, plan), extra['rate_limit'], now);
			if (limit !== undefined) {
				limits.push(limit);
			}
		}
	}
	return { provider: CODEX_PROVIDER, plan, limits, fetchedAt: now };
}

function codexHeaderWindow(headers: Record<string, string>, kind: 'primary' | 'secondary'): UsageWindow | undefined {
	const used = Number.parseFloat(headers[`${CODEX_HEADER_PREFIX}${kind}-used-percent`] ?? '');
	if (!Number.isFinite(used)) {
		return undefined;
	}
	// A missing duration is not a zero-minute window, nor an assumed one.
	const seconds = Number(headers[`${CODEX_HEADER_PREFIX}${kind}-window-minutes`]) * MINUTE;
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return undefined;
	}
	const resetAt = Number.parseInt(headers[`${CODEX_HEADER_PREFIX}${kind}-reset-at`] ?? '', 10);
	return { label: windowLabel(seconds), usedPercent: used, windowSeconds: seconds, resetAt: Number.isFinite(resetAt) ? resetAt * 1000 : null };
}

function parseCodexHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows = [codexHeaderWindow(headers, 'primary'), codexHeaderWindow(headers, 'secondary')]
		.filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) {
		return undefined;
	}
	const reached = headers[`${CODEX_HEADER_PREFIX}rate-limit-reached-type`];
	return { provider: CODEX_PROVIDER, plan: undefined, limits: [{ name: codexLimitName(undefined, undefined), windows, limitReached: Boolean(reached) }], fetchedAt: now };
}

/** Claude Pro/Max: utilization as a 0..1 fraction per window, resets in Unix seconds. */
function parseAnthropicHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows: UsageWindow[] = [];
	for (const [key, seconds] of ANTHROPIC_WINDOWS) {
		const fraction = Number.parseFloat(headers[`${ANTHROPIC_HEADER_PREFIX}${key}-utilization`] ?? '');
		if (!Number.isFinite(fraction)) {
			continue;
		}
		const reset = Number.parseInt(headers[`${ANTHROPIC_HEADER_PREFIX}${key}-reset`] ?? '', 10);
		windows.push({ label: windowLabel(seconds), usedPercent: fraction * 100, windowSeconds: seconds, resetAt: Number.isFinite(reset) ? reset * 1000 : null });
	}
	if (windows.length === 0) {
		return undefined;
	}
	const rejected = headers[`${ANTHROPIC_HEADER_PREFIX}status`] === 'rejected';
	return { provider: ANTHROPIC_PROVIDER, plan: undefined, limits: [{ name: 'Claude', windows, limitReached: rejected }], fetchedAt: now };
}

/** A chat response's headers as a snapshot, when they carry rate-limit windows at all. */
export function parseUsageHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	// pi passes header names lower-cased already; a provider that did not is read the same way.
	const lower: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === 'string') {
			lower[name.toLowerCase()] = value;
		}
	}
	return parseCodexHeaders(lower, now) ?? parseAnthropicHeaders(lower, now);
}

/** The newest snapshot each provider's responses carried, for the life of the window. */
const fromResponses = new Map<string, ProviderUsage>();

/** Keeps what a chat response said about its provider's windows; anything else is ignored. */
export function recordUsageHeaders(headers: Record<string, string>, now: number = Date.now()): void {
	const parsed = parseUsageHeaders(headers, now);
	if (parsed !== undefined) {
		fromResponses.set(parsed.provider, parsed);
	}
}

/** The last snapshot a provider's responses carried, if any arrived. */
export function usageFromResponses(provider: string): ProviderUsage | undefined {
	return fromResponses.get(provider);
}

/** Forgets every response snapshot; tests use it to start clean. */
export function clearUsageFromResponses(): void {
	fromResponses.clear();
}

/** The ChatGPT account id a Codex sign-in token carries, or `undefined` when it carries none. */
export function accountIdFromToken(token: string): string | undefined {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		const auth = isRecord(claims) ? claims[CODEX_ACCOUNT_CLAIM] : undefined;
		const id = isRecord(auth) ? auth['chatgpt_account_id'] : undefined;
		return typeof id === 'string' && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** What a stored Codex sign-in gives this module: a token still in date, and its account. */
export interface CodexSignIn {
	readonly token: string;
	readonly accountId: string;
}

/**
 * The Codex sign-in pi holds, from its `auth.json` entry, when it can be used as it is.
 *
 * pi refreshes the token itself when the chat needs it; this module never does, because a refresh
 * rewrites the credential file and a status refresh has no business writing anything. An expired
 * token is therefore no sign-in here, and the card keeps whatever the last response said.
 */
export function codexSignIn(entry: unknown, now: number): CodexSignIn | undefined {
	if (!isRecord(entry) || entry['type'] !== 'oauth') {
		return undefined;
	}
	const token = entry['access'];
	if (typeof token !== 'string' || token.length === 0) {
		return undefined;
	}
	const expires = entry['expires'];
	if (isFiniteNumber(expires) && expires <= now) {
		return undefined;
	}
	const stored = entry['accountId'];
	const accountId = typeof stored === 'string' && stored.length > 0 ? stored : accountIdFromToken(token);
	return accountId === undefined ? undefined : { token, accountId };
}

/** One read of Codex's usage endpoint; a failure is `undefined`, never thrown. */
export async function fetchCodexUsage(signIn: CodexSignIn, fetchFn: UsageFetch = globalThis.fetch, now: number = Date.now()): Promise<ProviderUsage | undefined> {
	try {
		const response = await fetchFn(CODEX_USAGE_URL, {
			headers: { Authorization: `Bearer ${signIn.token}`, 'chatgpt-account-id': signIn.accountId, Accept: 'application/json' },
			redirect: 'error',
			cache: 'no-store',
		});
		if (!response.ok) {
			return undefined;
		}
		const parsed = parseCodexUsage(await response.json(), now);
		return parsed.limits.length > 0 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The last read per token digest, and whether it answered; set on every attempt so a dead endpoint is asked once a minute. */
const codexCache = new Map<string, { value: ProviderUsage | undefined; at: number; ok: boolean }>();
const codexInFlight = new Map<string, Promise<ProviderUsage | undefined>>();

async function readCodexBounded(signIn: CodexSignIn, fetchFn: UsageFetch, now: number): Promise<ProviderUsage | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			fetchCodexUsage(signIn, fetchFn, now),
			new Promise<undefined>(resolve => {
				timer = setTimeout(() => resolve(undefined), CODEX_FETCH_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** Codex's usage, from the cache while it is good and from the endpoint when it is not; a failed read keeps the last good one. */
export async function getCachedCodexUsage(signIn: CodexSignIn, now: number, fetchFn: UsageFetch = globalThis.fetch): Promise<{ readonly value: ProviderUsage | undefined; readonly fresh: boolean }> {
	const key = createHash('sha256').update(signIn.token).digest('hex');
	const cached = codexCache.get(key);
	if (cached !== undefined && now - cached.at < CODEX_CACHE_TTL_MS) {
		return { value: cached.value, fresh: cached.ok };
	}
	let pending = codexInFlight.get(key);
	if (pending === undefined) {
		pending = readCodexBounded(signIn, fetchFn, now);
		codexInFlight.set(key, pending);
		const settled = () => {
			codexInFlight.delete(key);
		};
		pending.then(settled, settled);
	}
	const read = await pending;
	const value = read ?? cached?.value;
	codexCache.set(key, { value, at: now, ok: read !== undefined });
	return { value, fresh: read !== undefined };
}

/**
 * The snapshot to show for a provider: the newer of the endpoint's and the last response's.
 *
 * A response snapshot names only the main allowance, so when the endpoint's read is the older one
 * its extra allowances are kept and only the main one is replaced.
 */
export function newestUsage(endpoint: ProviderUsage | undefined, response: ProviderUsage | undefined): ProviderUsage | undefined {
	if (endpoint === undefined || response === undefined) {
		return endpoint ?? response;
	}
	if (endpoint.fetchedAt >= response.fetchedAt) {
		return endpoint;
	}
	const [main, ...extras] = endpoint.limits;
	const fromResponse = response.limits[0];
	if (main === undefined || fromResponse === undefined) {
		return response;
	}
	return { ...endpoint, fetchedAt: response.fetchedAt, limits: [{ ...fromResponse, name: main.name }, ...extras] };
}
