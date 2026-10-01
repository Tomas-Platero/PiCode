/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The lifetime rules of the model caches, and nothing else.
 *
 * The model picker is the surface that pays for a slow listing, so the connector serves its
 * last answer immediately and refreshes it in the background. What that needs — a value that
 * is fresh or stale but never missing twice, a comparison that says whether the list the
 * owner sees actually changed, and one flight per key so two overlapping listings share one
 * fetch — lives here, with the caches themselves and the editor's types left to the caller.
 *
 * ## Why this module has no `vscode` import — and no relative imports at all
 *
 * Every rule here is a rule about **time** and **identity**, not about the editor: whether a
 * value is past its lifetime, whether two model lists are the same list, whether a second
 * caller joins an existing flight. Keeping the module free of the editor — and of every local
 * import, so the file can be run on its own — is what lets those rules be exercised by
 * running them, without an editor in the way. The shape it follows is `usage-data.ts`, which
 * makes the same split for the usage read.
 */

/** One snapshot in a cache: the value, when it was read, and under which key. */
export interface CacheEntry<T> {
	readonly value: T;
	readonly at: number;
	readonly key: string;
}

/** What a cache answers with: the value it holds, and whether that value is still inside its lifetime. */
export interface CacheRead<T> {
	readonly value: T | undefined;
	readonly fresh: boolean;
}

/**
 * A cache key from parts that may be missing.
 *
 * The separator is a character no path, URL or id carries, so the parts cannot blur into one
 * another; a missing part is a value of its own rather than an empty string, because a key
 * without a credential and a key with an empty one are different questions.
 */
export function cacheKey(...parts: (string | undefined)[]): string {
	return parts.map(part => (part === undefined ? 'undefined' : part)).join('\u0000');
}

/**
 * What the cache holds for `key`, judged against `now`.
 *
 * Inside the lifetime the value is **fresh**: the caller can serve it and ask for nothing.
 * Past the lifetime the value survives but is **stale** — `fresh: false` is the caller's
 * signal to serve it immediately and refresh in the background, which is the whole point of
 * the cache: a slow source must not hold the picker hostage, and an empty answer must not
 * replace one the endpoint already gave.
 *
 * A miss is `undefined` and stale at once: there is nothing to serve, and the caller should
 * refresh. The boundary is exclusive on purpose — at exactly `ttlMs` the value is stale, so
 * the lifetime the caller reads is the lifetime it gets.
 */
export function cachedModels<T>(cache: Map<string, CacheEntry<T>>, key: string, ttlMs: number, now: number): CacheRead<T> {
	const entry = cache.get(key);
	if (entry === undefined) {
		return { value: undefined, fresh: false };
	}
	return { value: entry.value, fresh: now - entry.at < ttlMs };
}

/** Puts one snapshot in the cache, stamping it with `now`. */
export function storeModels<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, now: number): void {
	cache.set(key, { value, at: now, key });
}

/**
 * Whether two model lists are the same list to the owner.
 *
 * Order-insensitive on purpose: the sources this compares — an endpoint's catalogue, pi's
 * runtime — may answer the same catalogue in a different order, and repainting the picker
 * because the order moved is noise the owner did not ask for. A duplicate is a different
 * list: one row and two identical rows do not render the same, so the counts are compared,
 * not the sets.
 */
export function sameIds(a: ReadonlyArray<{ id: string }>, b: ReadonlyArray<{ id: string }>): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const counts = new Map<string, number>();
	for (const { id } of a) {
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	for (const { id } of b) {
		const seen = counts.get(id);
		if (seen === undefined || seen === 0) {
			return false;
		}
		counts.set(id, seen - 1);
	}
	return true;
}

/**
 * One flight per key: a second caller with the same key joins the flight that is running.
 *
 * Model listings overlap — the editor asks again the moment `onDidChangeLanguageModelChatInformation`
 * fires, and the background refresh of one listing runs while the next listing starts — so
 * without this, one slow source is asked once per overlapping listing. The map is the
 * caller's, so several flights can live side by side.
 *
 * A task that fails releases its slot **and** reports its failure to every caller that joined
 * it — the caller owns what a failure means — but leaves nothing behind: the next call runs
 * the task again instead of re-reading a rejection, so one downed endpoint cannot poison the
 * cache for the rest of the session.
 */
export function singleFlight<T>(map: Map<string, Promise<T>>, key: string, task: () => Promise<T>): Promise<T> {
	let pending = map.get(key);
	if (pending === undefined) {
		pending = task();
		map.set(key, pending);
		const settled = () => {
			map.delete(key);
		};
		pending.then(settled, settled);
	}
	return pending;
}
