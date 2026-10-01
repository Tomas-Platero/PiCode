/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Subscription usage: the provider's own quota, read live.
 *
 * The `usage 20%` bar the TUI draws is not session data at all: it is the provider's own
 * rate-limit window, fetched from the provider while the session runs. Gentle Shell is what
 * draws it (`gentle-pi/lib/shell-usage.ts`), and this module mirrors exactly one of its routes
 * — NaN's — so the Status view can show the same number the TUI shows without inventing one.
 *
 * The other two routes are deliberately absent: Codex and Claude Pro/Max report their windows
 * in **SSE response headers** of the chat request itself, and this connector never sees those
 * headers (the request is made by pi, not by the editor). A follow-up, not a guess: a window
 * this module cannot read is a row it does not print.
 *
 * ## Why nothing here is trusted
 *
 * `https://cloud-api.nan.builders/api/usage/quota` is the dashboard's own backend, not part of
 * NaN's published OpenAPI, so the payload lives outside any contract and every field is
 * optional. Each one is checked and anything unreadable is dropped rather than coerced: a
 * percentage printed from a half-read payload would be a number the owner cannot act on.
 *
 * The key travels in the header only. The request refuses redirects, so it cannot be replayed
 * to another origin, and asks for no stored copy. Nothing here logs, renders or persists the
 * key, and the cache is keyed by its **hash**, never by the key itself.
 *
 * ## Why this module has no `vscode` import — and no relative imports at all
 *
 * Everything that decides what a payload means, and everything that decides whether a cached
 * snapshot may still be shown, is here. Keeping it free of the editor — and of every local
 * import, so the file can be run on its own — is what lets the parsing, the selection and the
 * cache lifetime be exercised by running them, without an editor in the way.
 */

import { createHash } from 'node:crypto';

/** The dashboard's own quota endpoint, read with the same API key pi holds. */
export const NAN_QUOTA_URL = 'https://cloud-api.nan.builders/api/usage/quota';

/** The provider id NaN is declared under in `picode.providers`. */
export const NAN_PROVIDER_ID = 'nan';

/** A declared endpoint carrying this marker is NaN's, whatever id it was given. */
export const NAN_ENDPOINT_MARKER = 'nan.builders';

/**
 * How long a successful read is reused.
 *
 * The Status view refreshes every five seconds and the window is minutes wide, so a read per
 * refresh would be sixty requests a minute for a number that barely moves. One per minute is
 * the whole point of this constant.
 */
export const NAN_CACHE_TTL_MS = 60_000;

/**
 * How long a read may take before the Status row gives up on it.
 *
 * The refresh interval is five seconds: a read that outlives the tick that asked for it would
 * pile up behind the next one. Past this the row renders what the cache holds and the next
 * tick tries again.
 */
const NAN_FETCH_TIMEOUT_MS = 4_000;

/** The dashboard's own published fallbacks for a model that reports rolling numbers only. */
const NAN_DEFAULT_WINDOW_TOKENS = 400_000_000;
const NAN_DEFAULT_WINDOW_HOURS = 4;

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 604_800;

/** One window a model's allowance is measured over. */
export interface NanUsageWindow {
	/** `4h`, `1d`… and empty for the model's own billing-period allowance. */
	readonly label: string;
	readonly usedPercent: number;
	readonly windowSeconds: number;
	readonly resetAt: number | null;
	/** The raw allowance numbers, kept only so a surface can aggregate without averaging. */
	readonly used?: number;
	readonly budget?: number;
}

/** One metered model: the period allowance, plus the rolling window on top of it. */
export interface NanUsageLimit {
	/** The model id the payload reported, which is what names the meter. */
	readonly name: string;
	readonly windows: NanUsageWindow[];
	readonly limitReached: boolean;
}

/** A read of NaN's quota: the meters it reported, and when they were read. */
export interface NanUsage {
	readonly limits: NanUsageLimit[];
	readonly fetchedAt: number;
}

/** What this module needs from a declared provider to recognize NaN. */
export interface NanProviderRef {
	readonly id: string;
	readonly baseUrl: string;
}

/**
 * Where a credential may be written down, in the order the wiring tries them.
 *
 * `declared` is the `key` field of the matching `picode.providers` entry exactly as the owner
typed it, `environment` is what `$NAME`/`$env:NAME` forms are looked up in, and `stored` is
what pi's own `auth.json` holds for the provider.
 */
export interface NanKeySources {
	readonly declared?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly stored?: string;
}

/** The cached snapshot, and whether it is still inside its lifetime. */
export interface CachedNanUsage {
	readonly value: NanUsage | undefined;
	readonly fresh: boolean;
}

/**
 * The one thing this module asks of the network.
 *
 * Typed narrow on purpose: the caller passes `globalThis.fetch`, and a test passes a function
 * that answers two fields, so the shape is the part that matters, not the whole DOM surface.
 */
export type NanFetch = (
	url: string,
	init: { headers: Record<string, string>; redirect: 'error'; cache: 'no-store' },
) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;

/** A JSON object from an unknown value, or `undefined` when it is not one. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number from an unknown value, or `undefined` when it is not one. */
function numberOf(value: unknown, positive: boolean): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return positive ? (value > 0 ? value : undefined) : value >= 0 ? value : undefined;
}

/** A reset instant in milliseconds: Unix seconds in the payload, or an ISO date. */
function timestamp(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value * 1000;
	}
	if (typeof value !== 'string') {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/** How a window is named, from its length: `4h`, `1d`, `week`, `30m`. */
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

/**
 * The allowance the dashboard divides by: the full-period cap when it is reported, `cap`
 * otherwise — `cap` is the period in progress and comes back prorated on a first period.
 *
 * A model that reports neither reports no allowance at all, which is a state the surfaces
 * already know how to draw nothing for.
 */
function effectiveAllowance(raw: Record<string, unknown>): number | undefined {
	return numberOf(raw['fullCap'], true) ?? numberOf(raw['cap'], true);
}

/** The rolling window a model applies on top of its period allowance, when it reports one. */
function rollingWindow(raw: Record<string, unknown>): NanUsageWindow | undefined {
	const used = numberOf(raw['windowTokensUsed'], false);
	if (used === undefined) {
		return undefined;
	}
	const budget = numberOf(raw['fullWindowTokens'], true) ?? numberOf(raw['windowTokens'], true) ?? NAN_DEFAULT_WINDOW_TOKENS;
	const hours = numberOf(raw['windowHours'], true) ?? NAN_DEFAULT_WINDOW_HOURS;
	return {
		label: windowLabel(hours * HOUR),
		usedPercent: (used / budget) * 100,
		windowSeconds: hours * HOUR,
		resetAt: timestamp(raw['windowResetsAt']),
	};
}

/**
 * The billing-period window: tokens used over the period allowance.
 *
 * Its length is whatever is left of the period, which is why it carries no label of its own —
 * the model id names the meter, and the reset says what the window is.
 */
function periodWindow(tokensUsed: number, allowance: number, resetAt: number | null, now: number): NanUsageWindow {
	return {
		label: '',
		usedPercent: (tokensUsed / allowance) * 100,
		windowSeconds: resetAt === null ? 0 : Math.max(0, Math.round((resetAt - now) / 1000)),
		resetAt,
		used: tokensUsed,
		budget: allowance,
	};
}

/**
 * NaN's quota payload, read defensively.
 *
 * Every field is optional, because this payload lives outside NaN's published contract, and
 * the two refusals the provider makes are kept exactly as Gentle Shell makes them:
 *
 * - A model reporting **no allowance** is skipped — the dashboard draws nothing for it either,
 *   and the live payload carries such entries.
 * - A **metered** model whose usage cannot be read fails the read **whole**: a partial snapshot
 *   would understate every aggregate it feeds, so an empty result is returned and the last
 *   valid snapshot survives instead.
 */
export function parseNanQuota(payload: unknown, now: number): NanUsage {
	const raw = isRecord(payload) ? payload : {};
	const fallbackResetAt = timestamp(raw['periodEnd']);
	const limits: NanUsageLimit[] = [];
	const models = raw['models'];
	if (Array.isArray(models)) {
		for (const entry of models) {
			if (!isRecord(entry)) {
				continue;
			}
			const model = entry['model'];
			if (typeof model !== 'string' || model.length === 0) {
				continue;
			}
			const allowance = effectiveAllowance(entry);
			if (allowance === undefined) {
				continue;
			}
			const tokensUsed = numberOf(entry['tokensUsed'], false);
			if (tokensUsed === undefined) {
				return { limits: [], fetchedAt: now };
			}
			const resetAt = timestamp(entry['periodEnd']) ?? fallbackResetAt;
			const windows: NanUsageWindow[] = [periodWindow(tokensUsed, allowance, resetAt, now)];
			const rolling = rollingWindow(entry);
			if (rolling !== undefined) {
				windows.push(rolling);
			}
			limits.push({ name: model, windows, limitReached: tokensUsed >= allowance });
		}
	}
	return { limits, fetchedAt: now };
}

/**
 * One read of NaN's quota.
 *
 * A failure is `undefined` and never thrown at the caller: an endpoint that does not answer is
 * a fact to tell the owner about, not a reason to stop drawing the status. An answer whose
 * meters are **empty** is also `undefined` — the same whole-read refusal a metered model
 * without usage makes — so a broken snapshot never replaces a good one.
 */
export async function fetchNanUsage(apiKey: string, fetchFn: NanFetch = globalThis.fetch, now: number = Date.now()): Promise<NanUsage | undefined> {
	if (apiKey.length === 0) {
		return undefined;
	}
	try {
		const response = await fetchFn(NAN_QUOTA_URL, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
			redirect: 'error',
			cache: 'no-store',
		});
		if (!response.ok) {
			return undefined;
		}
		const parsed = parseNanQuota(await response.json(), now);
		return parsed.limits.length > 0 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The meter that belongs to the session's model.
 *
 * The payload names one meter per model and the server decides their order, so the meter is
 * picked by **meaning**: the entry whose model id is the one in use. A payload that names a
 * single meter is that meter even when the id differs — a renaming at the provider is not a
 * reason to print nothing. A payload naming several, none of them this model, has no honest
 * answer and returns `undefined`.
 */
export function nanModelUsage(usage: NanUsage, modelId: string | undefined): NanUsageLimit | undefined {
	if (modelId !== undefined && modelId.length > 0) {
		const exact = usage.limits.find(limit => limit.name === modelId);
		if (exact !== undefined) {
			return exact;
		}
	}
	return usage.limits.length === 1 ? usage.limits[0] : undefined;
}

/** Whether a declared provider is NaN's: by id, or by the address it points at. */
export function isNanProvider(ref: NanProviderRef): boolean {
	return ref.id === NAN_PROVIDER_ID || ref.baseUrl.includes(NAN_ENDPOINT_MARKER);
}

/**
 * The declared provider a session is actually on, when that provider is NaN's.
 *
 * Two facts have to agree, and both are needed. The **declaration** has to be NaN's (by id or
 * by address), and it has to be the entry the session's own provider id names: a NaN entry
 * sitting in the settings while the session runs somebody else's model says nothing about the
 * model in use, and another provider's quota is not this provider's quota. A mismatch is
 * `undefined` — no row — rather than the nearest meter.
 *
 * Generic in the entry type so the caller keeps the fields of its own declaration (the `key`,
 * for instance) instead of only the id and address this module needs.
 */
export function matchedNanProvider<T extends NanProviderRef>(refs: readonly T[], providerId: string | undefined): T | undefined {
	if (providerId === undefined || providerId.length === 0) {
		return undefined;
	}
	return refs.find(ref => ref.id === providerId && isNanProvider(ref));
}

/** The variable name a `$NAME` or `$env:NAME` key names, or `undefined` when it names none. */
function environmentVariable(key: string): string | undefined {
	if (key.slice(0, 5).toLowerCase() === '$env:') {
		const name = key.slice(5).trim();
		return name.length === 0 ? undefined : name;
	}
	if (key.startsWith('$')) {
		const name = key.slice(1).trim();
		return name.length === 0 ? undefined : name;
	}
	return undefined;
}

/**
 * The credential to read NaN's quota with, from the first source that has one.
 *
 * A status refresh is a read of the owner's own settings, so the credential is resolved the
 * way pi resolves it and no further:
 *
 * 1. a **literal** in the settings entry's `key` field;
 * 2. a `$NAME` / `$env:NAME` interpolation, read from the environment — an unset variable is
 *    not a key, and the next source still gets its turn;
 * 3. whatever pi's own `auth.json` holds for the provider.
 *
 * A `!command` key is **never run**. Executing an arbitrary command because a status view was
 * refreshed would be a side effect nobody asked for, so that source is treated as
 * unresolvable and resolution continues with `auth.json`, which is where a credential meant to
 * come from a command usually ends up anyway.
 */
export function resolveNanApiKey(sources: NanKeySources): string | undefined {
	const declared = sources.declared?.trim() ?? '';
	if (declared.length > 0 && !declared.startsWith('!')) {
		const variable = environmentVariable(declared);
		if (variable === undefined) {
			return declared;
		}
		const value = sources.environment?.[variable]?.trim();
		if (value !== undefined && value.length > 0) {
			return value;
		}
	}
	const stored = sources.stored?.trim() ?? '';
	return stored.length > 0 ? stored : undefined;
}

/**
 * The one-line summary the Status row prints, or `undefined` when there is no meter to name.
 *
 * Tightest window first — the rolling `4h` before the billing period — because that is the one
 * that runs out first. Every part speaks: the model the meter belongs to, what share of the
 * rolling window is used, and what share of the billing period. A window without a label of
 * its own is the model's billing-period allowance.
 */
export function nanUsageSummary(usage: NanUsage, modelId: string | undefined): string | undefined {
	const limit = nanModelUsage(usage, modelId);
	if (limit === undefined || limit.windows.length === 0) {
		return undefined;
	}
	const labelled = limit.windows.filter(window => window.label.length > 0).sort((left, right) => left.windowSeconds - right.windowSeconds);
	const unlabelled = limit.windows.filter(window => window.label.length === 0);
	const parts = [...labelled, ...unlabelled].map(window =>
		window.label.length > 0
			? `${Math.round(window.usedPercent)}% of the ${spokenWindowLabel(window.label)} window`
			: `${Math.round(window.usedPercent)}% of the billing period`);
	return `${limit.name}: ${parts.join(' · ')}`;
}

/** A window label spoken as a length, so a part reads as time: `4h` becomes `4-hour`. */
function spokenWindowLabel(label: string): string {
	// The week-long window is the one label that is not a count of hours, days or minutes.
	if (label === 'week') {
		return 'weekly';
	}
	const length = /^(?:(\d+)h|(\d+)d|(\d+)m)$/.exec(label);
	if (length?.[1] !== undefined) {
		return `${length[1]}-hour`;
	}
	if (length?.[2] !== undefined) {
		return `${length[2]}-day`;
	}
	if (length?.[3] !== undefined) {
		return `${length[3]}-minute`;
	}
	// A label this does not know is passed through instead of guessed at: the sentence would then
	// read oddly, which is better than reading wrongly. Every label `windowLabel` writes is above.
	return label;
}

/** The cache key: a digest of the key, so the key itself is never held past the request. */
function cacheKey(apiKey: string): string {
	return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * The last read per key: the snapshot that survived it, when the endpoint was last asked, and
 * whether that attempt answered.
 *
 * The timestamp is set on **every** attempt, not only on a successful one, so an endpoint that
 * is down is not hammered once per five-second refresh: the network is touched at most once
 * per lifetime either way. `ok` is what tells a snapshot read just now from one that outlived
 * its endpoint, and it is the cache's `fresh` answer.
 */
const cache = new Map<string, { value: NanUsage | undefined; at: number; ok: boolean }>();

/** Reads in flight, so two refreshes overlapping the same tick share one request. */
const inFlight = new Map<string, Promise<NanUsage | undefined>>();

/** One read, bounded so a slow endpoint cannot outlive the refresh that asked for it. */
async function readBounded(apiKey: string, fetchFn: NanFetch, now: number): Promise<NanUsage | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			fetchNanUsage(apiKey, fetchFn, now),
			new Promise<undefined>(resolve => {
				timer = setTimeout(() => resolve(undefined), NAN_FETCH_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/**
 * NaN's quota, from the cache when it is still good and from the endpoint when it is not.
 *
 * The Status view calls this on every refresh; the network is touched at most once per
 * `NAN_CACHE_TTL_MS`, and a read that fails leaves the last good snapshot in place. `fresh`
 * says whether that snapshot came from a **successful** read: a value that outlived its
 * endpoint is still returned, with `fresh: false`, so the caller can say how old it is
 * instead of printing nothing. Every read is keyed by a digest of the API key, so two
 * providers with their own keys never share a snapshot.
 */
export async function getCachedNanUsage(apiKey: string, now: number, fetchFn: NanFetch = globalThis.fetch): Promise<CachedNanUsage> {
	const key = cacheKey(apiKey);
	const cached = cache.get(key);
	if (cached !== undefined && now - cached.at < NAN_CACHE_TTL_MS) {
		return { value: cached.value, fresh: cached.ok };
	}
	let pending = inFlight.get(key);
	if (pending === undefined) {
		pending = readBounded(apiKey, fetchFn, now);
		inFlight.set(key, pending);
		const settled = () => {
			inFlight.delete(key);
		};
		pending.then(settled, settled);
	}
	const read = await pending;
	// Stale-on-error: a read that did not answer leaves the last good snapshot in place.
	const value = read ?? cached?.value;
	cache.set(key, { value, at: now, ok: read !== undefined });
	return { value, fresh: read !== undefined };
}
