/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The model caches' lifetime rules, run on their own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `models-cache.ts` carries no local imports and no `vscode`: the TTL boundary, the
 * change detection and the single-flight dedupe are the parts worth exercising, and
 * none of them needs an editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { cacheKey, cachedModels, deserialiseCache, sameIds, serialiseCache, singleFlight, storeModels, type CacheEntry } from '../src/models-cache.ts';

/** A fixed instant, so the TTL math never depends on when the test runs. */
const NOW = 1_800_000_000_000;

interface Row {
	readonly id: string;
}

const row = (id: string): Row => ({ id });

test('cacheKey joins parts and accepts undefined ones deterministically', () => {
	assert.strictEqual(cacheKey('a', 'b'), cacheKey('a', 'b'));
	assert.notStrictEqual(cacheKey('a', 'b'), cacheKey('a'));
	assert.notStrictEqual(cacheKey('a'), cacheKey('a', 'b'));
	// `undefined` is a value of its own: a missing key must not read as an empty one.
	assert.notStrictEqual(cacheKey('a', undefined), cacheKey('a', ''));
});

test('cachedModels answers undefined on a miss', () => {
	const cache = new Map<string, CacheEntry<Row[]>>();
	assert.deepStrictEqual(cachedModels(cache, 'k', 60_000, NOW), { value: undefined, fresh: false });
});

test('cachedModels is fresh inside the TTL and stale from the TTL onward', () => {
	const cache = new Map<string, CacheEntry<Row[]>>();
	storeModels(cache, 'k', [row('a')], NOW);

	const inside = cachedModels(cache, 'k', 60_000, NOW + 60_000 - 1);
	assert.deepStrictEqual(inside, { value: [row('a')], fresh: true });

	// Past the lifetime the value survives but is marked stale, so the caller can serve
	// it immediately and refresh in the background.
	const past = cachedModels(cache, 'k', 60_000, NOW + 60_000);
	assert.deepStrictEqual(past, { value: [row('a')], fresh: false });
});

test('storeModels overwrites the entry for its key and leaves other keys alone', () => {
	const cache = new Map<string, CacheEntry<Row[]>>();
	storeModels(cache, 'k1', [row('a')], NOW);
	storeModels(cache, 'k2', [row('b')], NOW);
	storeModels(cache, 'k1', [row('c')], NOW + 1);

	assert.deepStrictEqual(cachedModels(cache, 'k1', 60_000, NOW + 1).value, [row('c')]);
	assert.deepStrictEqual(cachedModels(cache, 'k2', 60_000, NOW + 1).value, [row('b')]);
});

test('sameIds compares the ids and not their order', () => {
	assert.strictEqual(sameIds([row('a'), row('b')], [row('b'), row('a')]), true);
	assert.strictEqual(sameIds([], []), true);
	assert.strictEqual(sameIds([row('a')], [row('a'), row('b')]), false);
	assert.strictEqual(sameIds([row('a')], [row('b')]), false);
	// A duplicate is a different list, not one the order can hide.
	assert.strictEqual(sameIds([row('a'), row('a')], [row('a')]), false);
	// Extra fields are not part of the comparison. Held in a variable on purpose: the point is a
	// row wider than the type it is compared through, and a literal in the call would not build.
	const wider = { id: 'a', name: 'x' };
	assert.strictEqual(sameIds([wider], [row('a')]), true);
});

test('singleFlight runs one task per key while one is in flight', async () => {
	const flights = new Map<string, Promise<string>>();
	let runs = 0;
	const task = async (): Promise<string> => {
		runs += 1;
		await new Promise(resolve => setTimeout(resolve, 10));
		return 'value';
	};

	const [first, second] = await Promise.all([
		singleFlight(flights, 'k', task),
		singleFlight(flights, 'k', task),
	]);

	assert.strictEqual(runs, 1);
	assert.strictEqual(first, 'value');
	assert.strictEqual(second, 'value');
	// Once settled the slot is free: the next call runs the task again.
	await singleFlight(flights, 'k', task);
	assert.strictEqual(runs, 2);
	assert.strictEqual(flights.size, 0);
});

test('singleFlight keeps distinct keys apart', async () => {
	const flights = new Map<string, Promise<string>>();
	const [a, b] = await Promise.all([
		singleFlight(flights, 'a', async () => 'A'),
		singleFlight(flights, 'b', async () => 'B'),
	]);
	assert.strictEqual(a, 'A');
	assert.strictEqual(b, 'B');
});

test('a failing task does not poison the single-flight map', async () => {
	const flights = new Map<string, Promise<string>>();
	let runs = 0;
	const failing = async (): Promise<string> => {
		runs += 1;
		throw new Error('endpoint down');
	};

	await assert.rejects(singleFlight(flights, 'k', failing), /endpoint down/);
	assert.strictEqual(flights.size, 0, 'the failed slot must be released');

	const recovered = await singleFlight(flights, 'k', async () => 'ok');
	assert.strictEqual(recovered, 'ok');
	assert.strictEqual(runs, 1, 'the failed task must not be retried by the map');
});

test('a cache survives being written down and read back', () => {
	const cache = new Map<string, CacheEntry<Row[]>>();
	storeModels(cache, 'agent-dir', [row('a'), row('b')], NOW);

	const read = deserialiseCache<Row[]>(serialiseCache(cache));
	assert.strictEqual(read.size, 1);
	const entry = read.get('agent-dir');
	assert.ok(entry);
	assert.deepStrictEqual(entry.value, [row('a'), row('b')]);
	assert.strictEqual(entry.at, NOW);
	assert.strictEqual(entry.key, 'agent-dir');
});

test('a cache that was never written down reads back empty', () => {
	assert.strictEqual(deserialiseCache('').size, 0);
	assert.strictEqual(deserialiseCache('not json at all').size, 0);
	assert.strictEqual(deserialiseCache('{"value":[]}').size, 0, 'an object is not the shape that gets written');
});

test('a written cache drops what is not the list it writes', () => {
	// The rows go straight back to the editor, so a half-read entry is a broken picker: anything
	// that is not `{ value: [{ id }], at, key }` is left out rather than guessed at.
	const text = JSON.stringify([
		{ key: 'good', at: NOW, value: [row('a')] },
		{ key: 'no-rows', at: NOW, value: 'x' },
		{ key: 'no-stamp', at: 'later', value: [row('a')] },
		{ at: NOW, value: [row('a')] },
		{ key: 'row-without-id', at: NOW, value: [{ name: 'x' }] },
		{ key: 'one-bad-row', at: NOW, value: [row('a'), { name: 'x' }] },
		null,
	]);
	assert.deepStrictEqual([...deserialiseCache<Row[]>(text).keys()], ['good']);
});

test('a read-back cache stays stale, so the refresh behind it still runs', () => {
	const cache = new Map<string, CacheEntry<Row[]>>();
	storeModels(cache, 'k', [row('a')], NOW);

	const later = cachedModels(deserialiseCache<Row[]>(serialiseCache(cache)), 'k', 60_000, NOW + 60_000);
	assert.ok(later.value, 'the list is served, which is the whole point of writing it down');
	assert.strictEqual(later.fresh, false, 'and the caller is told to refresh behind it');
});
