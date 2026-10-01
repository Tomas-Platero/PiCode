/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Packages catalog and installer, run on their own.
 *
 * Everything here is a rule about data and time — what npm's search payload becomes, how long
 * one answer is trusted, and how an install target is spelled for pi — so every rule is
 * exercised without an editor, a network, or a process: the fetch, the clock and the spawn
 * all arrive from the test.
 */

import assert from 'assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

/**
 * Why the imports below arrive through a hook and not a plain statement.
 *
 * Running a `.ts` file directly, Node strips types but resolves imports as ESM — and ESM has
 * no extensionless resolution, so `packages-registry.ts`'s `from './models-cache'` (which the
 * compiler requires extensionless) cannot be found. The hook adds the extension the runtime
 * needs for exactly the relative specifiers that lack one, in this test process only; the
 * compiled build is untouched.
 */
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const {
	catalogSearchUrl,
	installPackage,
	installTargetSpec,
	npmInstallSpec,
	searchPackages,
} = await import('../src/packages-registry.ts');

type FetchFn = NonNullable<Parameters<typeof searchPackages>[1]>['fetchFn'];
type InstallContext = NonNullable<Parameters<typeof installPackage>[1]>;
type SpawnFn = NonNullable<InstallContext['spawn']>;
type SpawnOptions = Parameters<SpawnFn>[2];

/** One call the fake spawn recorded, which is what the assertions read. */
interface RecordedSpawn {
	readonly file: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

/** One fetch that answers `body` and counts how often it was asked. */
function fetchAnswering(body: unknown, status = 200): FetchFn & { calls: string[] } {
	const fetchFn = ((url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
		fetchFn.calls.push(url);
		return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
	}) as FetchFn & { calls: string[] };
	fetchFn.calls = [];
	return fetchFn;
}

/** One spawn that records what it was handed and answers `outcome`. */
function spawnAnswering(outcome: { ok: boolean; stderr: string }): SpawnFn & { calls: RecordedSpawn[] } {
	const spawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
		spawn.calls.push({ file, args, options });
		return Promise.resolve(outcome);
	}) as SpawnFn & { calls: RecordedSpawn[] };
	spawn.calls = [];
	return spawn;
}

/** npm's own search payload, as the real endpoint shapes it. An entry without `name` has no `package.name` at all. */
function catalogPayload(...objects: ReadonlyArray<{ name?: string; downloads: number; description?: string; publisher?: string; version?: string }>): unknown {
	return {
		objects: objects.map(object => ({
			downloads: { monthly: object.downloads },
			package: {
				name: object.name,
				description: object.description,
				version: object.version,
				publisher: object.publisher === undefined ? undefined : { username: object.publisher },
			},
		})),
	};
}

/* ------------------------------------------------------------------ *
 * The URL
 * ------------------------------------------------------------------ */

test('an empty query searches the keyword alone, fully encoded', () => {
	assert.strictEqual(catalogSearchUrl(''), 'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=50');
	// Whitespace is not a query: the keyword alone is what both answer.
	assert.strictEqual(catalogSearchUrl('   '), catalogSearchUrl(''));
});

test("the owner's query is appended after the keyword and encoded once", () => {
	assert.strictEqual(
		catalogSearchUrl('react hooks'),
		'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package%20react%20hooks&size=50',
	);
	// Characters npm would otherwise read as syntax travel encoded inside `text`.
	assert.strictEqual(
		catalogSearchUrl('a&b=c'),
		'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package%20a%26b%3Dc&size=50',
	);
});

/* ------------------------------------------------------------------ *
 * The parse
 * ------------------------------------------------------------------ */

test('the catalog payload becomes rows sorted by downloads, nameless entries skipped', async () => {
	const fetchFn = fetchAnswering(catalogPayload(
		{ name: 'little-used', downloads: 12, version: '0.1.0' },
		{ downloads: 999999 },
		{ name: 'gentle-pi', downloads: 5000, description: 'Gentle AI for pi', publisher: 'quintin', version: '1.2.3' },
	));

	const rows = await searchPackages('sort-probe', { fetchFn, now: () => 0 });

	// The entry without a name cannot be shown or installed: it is not a row.
	assert.deepStrictEqual(rows, [
		{ name: 'gentle-pi', description: 'Gentle AI for pi', publisher: 'quintin', version: '1.2.3' },
		{ name: 'little-used', version: '0.1.0' },
	]);
});

test('a payload that says nothing this module understands is an empty list', async () => {
	assert.deepStrictEqual(await searchPackages('junk-probe', { fetchFn: fetchAnswering({}), now: () => 0 }), []);
	assert.deepStrictEqual(await searchPackages('junk-probe', { fetchFn: fetchAnswering([1, 2]), now: () => 0 }), []);
});

/* ------------------------------------------------------------------ *
 * The failures
 * ------------------------------------------------------------------ */

test('a non-OK catalog answer is an empty list, said out loud and not cached', async () => {
	const lines: string[] = [];
	const failing: FetchFn = fetchAnswering({}, 503);
	assert.deepStrictEqual(await searchPackages('failing-probe', { fetchFn: failing, now: () => 0, log: line => lines.push(line) }), []);
	assert.strictEqual(lines.length, 1);
	assert.ok(lines[0].includes('503'));

	// A failure is not an answer: the next ask goes back to the network.
	const good = fetchAnswering(catalogPayload({ name: 'recovered', downloads: 1 }));
	assert.deepStrictEqual(await searchPackages('failing-probe', { fetchFn: good, now: () => 0 }), [{ name: 'recovered' }]);
	assert.strictEqual(good.calls.length, 1);
});

test('a network error is an empty list, said out loud and not cached', async () => {
	const lines: string[] = [];
	const down: FetchFn = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
	assert.deepStrictEqual(await searchPackages('down-probe', { fetchFn: down, now: () => 0, log: line => lines.push(line) }), []);
	assert.strictEqual(lines.length, 1);
	assert.ok(lines[0].includes('ENOTFOUND'));

	const good = fetchAnswering(catalogPayload({ name: 'back', downloads: 1 }));
	assert.deepStrictEqual(await searchPackages('down-probe', { fetchFn: good, now: () => 0 }), [{ name: 'back' }]);
	assert.strictEqual(good.calls.length, 1);
});

/* ------------------------------------------------------------------ *
 * The cache
 * ------------------------------------------------------------------ */

test("one query's answer is served for five minutes and refetched after", async () => {
	const fetchFn = fetchAnswering(catalogPayload({ name: 'cached', downloads: 1 }));
	let now = 0;

	await searchPackages('ttl-probe', { fetchFn, now: () => now });
	assert.strictEqual(fetchFn.calls.length, 1);

	// At 59 and 61 seconds the answer is still inside its five-minute lifetime: served, not
	// asked again. (The lifetime is five minutes, so the minute boundary moves nothing.)
	now = 59_000;
	await searchPackages('ttl-probe', { fetchFn, now: () => now });
	assert.strictEqual(fetchFn.calls.length, 1);
	now = 61_000;
	await searchPackages('ttl-probe', { fetchFn, now: () => now });
	assert.strictEqual(fetchFn.calls.length, 1);

	// The boundary is exclusive: past the lifetime npm is asked again.
	now = 301_000;
	await searchPackages('ttl-probe', { fetchFn, now: () => now });
	assert.strictEqual(fetchFn.calls.length, 2);
});

test('two queries are two cache entries, never one answer masquerading as the other', async () => {
	const fetchFn = fetchAnswering(catalogPayload({ name: 'shared', downloads: 1 }));
	await searchPackages('query-a', { fetchFn, now: () => 0 });
	await searchPackages('query-b', { fetchFn, now: () => 0 });
	assert.strictEqual(fetchFn.calls.length, 2);
	assert.notStrictEqual(fetchFn.calls[0], fetchFn.calls[1]);
});

/* ------------------------------------------------------------------ *
 * The install spellings
 * ------------------------------------------------------------------ */

test('an npm name is prefixed with npm:, scoped or not', () => {
	assert.strictEqual(installTargetSpec('gentle-pi'), 'npm:gentle-pi');
	assert.strictEqual(installTargetSpec('@scope/pkg'), 'npm:@scope/pkg');
	assert.strictEqual(installTargetSpec('@scope/pkg@1.2.3'), 'npm:@scope/pkg@1.2.3');
	// Already pi's spelling stays as it is.
	assert.strictEqual(installTargetSpec('npm:gentle-pi'), 'npm:gentle-pi');
});

test('a git URL passes through untouched', () => {
	assert.strictEqual(installTargetSpec('https://github.com/example/pi-tools.git'), 'https://github.com/example/pi-tools.git');
	assert.strictEqual(installTargetSpec('http://github.com/example/pi-tools'), 'http://github.com/example/pi-tools');
	assert.strictEqual(installTargetSpec('git@github.com:example/pi-tools.git'), 'git@github.com:example/pi-tools.git');
	// The suffix alone is enough: a bare name ending in .git is a repository reference.
	assert.strictEqual(installTargetSpec('pi-tools.git'), 'pi-tools.git');
});

test('an owner/repo shorthand passes through as-is and lets pi decide', () => {
	// Deliberately ambiguous: pi's manager reads it as GitHub shorthand, so pi decides.
	assert.strictEqual(installTargetSpec('example/pi-tools'), 'example/pi-tools');
	// A scoped name is not a shorthand: the `@` guard is what keeps it an npm name.
	assert.strictEqual(installTargetSpec('@scope/pkg'), 'npm:@scope/pkg');
	// Two segments but a ref attached is not the bare shorthand either.
	assert.strictEqual(installTargetSpec('example/pi-tools@v1'), 'npm:example/pi-tools@v1');
});

/* ------------------------------------------------------------------ *
 * The install run
 * ------------------------------------------------------------------ */

test('an empty target is refused before anything is spawned', async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await installPackage('   ', { cliEntry: '/cli.js', profileDir: '/profile', spawn });
	assert.deepStrictEqual(result, { ok: false, message: 'No package name or URL was given.' });
	assert.strictEqual(spawn.calls.length, 0);
});

test("an install runs pi's CLI as Node, into the profile in force, with the npm: spelling", async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await installPackage('gentle-pi', { cliEntry: '/runtime/cli.js', profileDir: '/profile', spawn });

	assert.deepStrictEqual(result, { ok: true, message: 'Package gentle-pi installed with pi.' });
	assert.strictEqual(spawn.calls.length, 1);
	const { file, args, options } = spawn.calls[0];
	// The editor's executable, the CLI entry, and the target as **one argv element** — no shell.
	assert.ok(file.endsWith('node') || file === process.execPath);
	assert.deepStrictEqual([...args], ['/runtime/cli.js', 'install', 'npm:gentle-pi']);
	assert.strictEqual(options.env.PI_CODING_AGENT_DIR, '/profile');
	assert.strictEqual(options.env.ELECTRON_RUN_AS_NODE, '1');
	assert.strictEqual(options.windowsHide, true);
	assert.strictEqual(options.timeoutMs, 180_000);
});

test("a failed install carries the last meaningful line of pi's stderr", async () => {
	const spawn = spawnAnswering({ ok: false, stderr: 'npm warn cleanup\nnpm error 404 Not Found - GET https://registry.npmjs.org/gone\n' });
	const result = await installPackage('gone', { cliEntry: '/cli.js', profileDir: '/profile', spawn });
	assert.deepStrictEqual(result, { ok: false, message: 'Package gone could not be installed: npm error 404 Not Found - GET https://registry.npmjs.org/gone' });
});

test('a stderr line longer than 200 characters is truncated', async () => {
	const long = `npm error ${'x'.repeat(400)}`;
	const spawn = spawnAnswering({ ok: false, stderr: `${long}\n` });
	const result = await installPackage('big', { cliEntry: '/cli.js', profileDir: '/profile', spawn });
	assert.strictEqual(result.ok, false);
	assert.ok(result.message.length < 250);
	assert.ok(result.message.startsWith('Package big could not be installed: npm error '));
});

test('installs queue one at a time and each caller gets its own package and result', async () => {
	const releases: Array<() => void> = [];
	const spawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
		spawn.calls.push({ file, args, options });
		return new Promise(resolve => {
			releases.push(() => resolve({ ok: true, stderr: '' }));
		});
	}) as SpawnFn & { calls: RecordedSpawn[] };
	(spawn as unknown as { calls: RecordedSpawn[] }).calls = [];

	const first = installPackage('first', { cliEntry: '/cli.js', profileDir: '/profile', spawn });
	const second = installPackage('second', { cliEntry: '/cli.js', profileDir: '/profile', spawn });

	// Sequential, never interleaved: only the first install runs at first (the queue runs on
	// microtasks, so let one settle before counting).
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.strictEqual(spawn.calls.length, 1);
	assert.strictEqual(spawn.calls[0].args[2], 'npm:first');
	releases[0]?.();
	await first;
	await new Promise(resolve => setTimeout(resolve, 0));

	// The queued install runs after, with its OWN target.
	assert.strictEqual(spawn.calls.length, 2);
	assert.strictEqual(spawn.calls[1].args[2], 'npm:second');
	releases[1]?.();

	const results = await Promise.all([first, second]);
	assert.deepStrictEqual(results, [
		{ ok: true, message: 'Package first installed with pi.' },
		{ ok: true, message: 'Package second installed with pi.' },
	]);
});

test('a failed install does not fail the ones queued after it', async () => {
	let calls = 0;
	const spawn: SpawnFn = () => {
		calls += 1;
		return calls === 1 ? Promise.resolve({ ok: false, stderr: 'npm error boom' }) : Promise.resolve({ ok: true, stderr: '' });
	};
	const first = installPackage('broken', { cliEntry: '/cli.js', profileDir: '/profile', spawn });
	const second = installPackage('works', { cliEntry: '/cli.js', profileDir: '/profile', spawn });
	const results = await Promise.all([first, second]);
	assert.strictEqual(results[0].ok, false);
	assert.strictEqual(results[1].ok, true);
	assert.strictEqual(results[1].message, 'Package works installed with pi.');
});

test('npmInstallSpec turns pi package sources into npm specs', () => {
	// npm: sources keep the name, without the prefix npm does not understand.
	assert.strictEqual(npmInstallSpec('npm:pi-lens'), 'pi-lens');
	assert.strictEqual(npmInstallSpec('npm:@scope/pkg'), '@scope/pkg');
	// git sources become git+https, the form npm installs without a helper.
	assert.strictEqual(npmInstallSpec('git:github.com/user/repo'), 'git+https://github.com/user/repo');
	assert.strictEqual(npmInstallSpec('https://github.com/user/repo'), 'git+https://github.com/user/repo');
	// Local paths cannot come across: the other machine's disk is not this one's.
	assert.strictEqual(npmInstallSpec('./local/path'), undefined);
});
