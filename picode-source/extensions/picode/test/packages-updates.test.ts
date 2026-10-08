/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The package update check and the update run, run on their own.
 *
 * Everything here is a rule about versions, time and argv — what can be checked, whether a
 * package is behind, how long one registry answer is trusted, and what npm is handed — so every
 * rule is exercised without an editor, a network, or a process: the fetch, the clock and the
 * spawn all arrive from the test, and the cache is a private map.
 */

import assert from 'assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

/**
 * Why the imports below arrive through a hook and not a plain statement.
 *
 * Running a `.ts` file directly, Node strips types but resolves imports as ESM — and ESM has
 * no extensionless resolution, so the modules' `from './…'` (which the compiler requires
 * extensionless) cannot be found. The hook adds the extension the runtime needs for exactly
 * the relative specifiers that lack one, in this test process only; the compiled build is
 * untouched.
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
	checkPackageUpdates,
	packageUpdateArgs,
	updateCheckableSource,
	updatePackage,
	updateStatusFor,
	UPDATE_CHECK_TTL_MS,
} = await import('../src/packages-updates.ts');

type CheckDependencies = NonNullable<Parameters<typeof checkPackageUpdates>[1]>;
type FetchFn = NonNullable<CheckDependencies['fetchFn']>;
type UpdateContext = NonNullable<Parameters<typeof updatePackage>[1]>;
type SpawnFn = NonNullable<UpdateContext['spawn']>;
type SpawnOptions = Parameters<SpawnFn>[2];

/** One spawn the test recorded, which is what the argv assertions read. */
interface RecordedSpawn {
	readonly file: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

/** One fetch that answers npm's `/latest` shape for the names in `versions`, and counts its calls. */
function fetchAnswering(versions: Record<string, string>, status = 200): FetchFn & { calls: string[] } {
	const fetchFn = ((url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
		fetchFn.calls.push(url);
		const name = decodeURIComponent(/registry\.npmjs\.org\/(.+)\/latest/.exec(url)?.[1] ?? '');
		return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve({ version: versions[name] }) });
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

/** Private cache and flights, so one test's answers never leak into another's. */
function privateCache(): { cache: NonNullable<CheckDependencies['cache']>; flights: NonNullable<CheckDependencies['flights']> } {
	return { cache: new Map(), flights: new Map() };
}

/* ------------------------------------------------------------------ *
 * What can be checked
 * ------------------------------------------------------------------ */

test('an npm declaration is checkable, by name', () => {
	assert.deepStrictEqual(updateCheckableSource('npm:pi-lens'), { kind: 'npm', name: 'pi-lens' });
	assert.deepStrictEqual(updateCheckableSource('npm:@tintinweb/pi-subagents'), { kind: 'npm', name: '@tintinweb/pi-subagents' });
});

test('a pinned npm declaration is checkable, with its pin carried', () => {
	assert.deepStrictEqual(updateCheckableSource('npm:pi-lens@4.3.0'), { kind: 'npm', name: 'pi-lens', pin: '4.3.0' });
	assert.deepStrictEqual(updateCheckableSource('npm:pi-lens@^4.0.0'), { kind: 'npm', name: 'pi-lens', pin: '^4.0.0' });
	assert.deepStrictEqual(updateCheckableSource('npm:@scope/pkg@>=1,<3'), { kind: 'npm', name: '@scope/pkg', pin: '>=1,<3' });
});

test('a git declaration says npm cannot check it', () => {
	const classified = updateCheckableSource('git:github.com/HazAT/pi-interactive-subagents');
	assert.strictEqual(classified.kind, 'uncheckable');
	assert.match(classified.reason, /git/);
});

test('a local path and a missing declaration also say they cannot be checked', () => {
	assert.strictEqual(updateCheckableSource('./my-package').kind, 'uncheckable');
	assert.strictEqual(updateCheckableSource(undefined).kind, 'uncheckable');
	assert.strictEqual(updateCheckableSource('').kind, 'uncheckable');
});

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

test('a package behind says what it is behind to', () => {
	const npm = updateCheckableSource('npm:pi-lens');
	assert.deepStrictEqual(updateStatusFor('4.3.0', '4.4.0', npm), { state: 'behind', latest: '4.4.0' });
});

test('a current package says nothing at all', () => {
	const npm = updateCheckableSource('npm:pi-lens');
	assert.deepStrictEqual(updateStatusFor('4.4.0', '4.4.0', npm), { state: 'current' });
	assert.deepStrictEqual(updateStatusFor('4.5.0', '4.4.0', npm), { state: 'current' });
});

test('the comparison is semver-shaped, prereleases included', () => {
	const npm = updateCheckableSource('npm:pi-lens');
	// A release is newer than any of its own prereleases.
	assert.strictEqual(updateStatusFor('1.0.0-rc.1', '1.0.0', npm).state, 'behind');
	// Prerelease identifiers order numerically: `2` before `10`.
	assert.strictEqual(updateStatusFor('1.0.0-alpha.2', '1.0.0-alpha.10', npm).state, 'behind');
	// The core compares as numbers, not strings.
	assert.strictEqual(updateStatusFor('0.9.0', '0.10.0', npm).state, 'behind');
});

test('a version that cannot be compared is unknown, not current', () => {
	const npm = updateCheckableSource('npm:pi-lens');
	assert.strictEqual(updateStatusFor('dev', '1.0.0', npm).state, 'unknown');
	assert.strictEqual(updateStatusFor('1.0.0', 'not-a-version', npm).state, 'unknown');
	assert.strictEqual(updateStatusFor(undefined, '1.0.0', npm).state, 'unknown');
	assert.strictEqual(updateStatusFor('1.0.0', undefined, npm).state, 'unknown');
});

test('an uncheckable package carries its reason and never a version claim', () => {
	const git = updateCheckableSource('git:github.com/HazAT/pi-interactive-subagents');
	const status = updateStatusFor('1.0.0', '2.0.0', git);
	assert.deepStrictEqual(status, { state: 'uncheckable', reason: git.kind === 'uncheckable' ? git.reason : undefined });
});

/* ------------------------------------------------------------------ *
 * The check, cached
 * ------------------------------------------------------------------ */

test('the check asks npm once per checkable package and answers by path', async () => {
	const fetchFn = fetchAnswering({ 'pi-lens': '4.4.0', 'pi-btw': '0.7.1' });
	const { cache, flights } = privateCache();
	const rows = [
		{ path: 'C:\\p\\npm\\node_modules\\pi-lens', name: 'pi-lens', version: '4.3.0', source: 'npm:pi-lens' },
		{ path: 'C:\\p\\npm\\node_modules\\pi-btw', name: 'pi-btw', version: '0.7.1', source: 'npm:pi-btw' },
	];
	const statuses = await checkPackageUpdates(rows, { fetchFn, cache, flights });
	assert.deepStrictEqual(statuses, [
		{ path: 'C:\\p\\npm\\node_modules\\pi-lens', name: 'pi-lens', state: 'behind', latest: '4.4.0' },
		{ path: 'C:\\p\\npm\\node_modules\\pi-btw', name: 'pi-btw', state: 'current' },
	]);
	assert.strictEqual(fetchFn.calls.length, 2);
});

test('a row that cannot be checked costs no request and says so', async () => {
	const fetchFn = fetchAnswering({});
	const { cache, flights } = privateCache();
	const statuses = await checkPackageUpdates([
		{ path: 'C:\\p\\git\\github.com\\HazAT\\pi-interactive-subagents', name: 'pi-interactive-subagents', version: '1.0.0', source: 'git:github.com/HazAT/pi-interactive-subagents' },
		{ path: 'C:\\p\\npm\\node_modules\\pi-lens', name: 'pi-lens', version: '4.3.0', source: 'npm:pi-lens' },
	], { fetchFn, cache, flights });
	assert.strictEqual(fetchFn.calls.length, 1, 'only the npm row reaches the registry');
	assert.strictEqual(statuses[0].state, 'uncheckable');
	assert.match(statuses[0].reason ?? '', /git/);
});

test('a fresh cache answers without asking npm again', async () => {
	const fetchFn = fetchAnswering({ 'pi-lens': '4.4.0' });
	const { cache, flights } = privateCache();
	const row = [{ path: 'C:\\p\\npm\\node_modules\\pi-lens', name: 'pi-lens', version: '4.3.0', source: 'npm:pi-lens' }];
	const deps: CheckDependencies = { fetchFn, cache, flights, now: () => 1_000 };
	await checkPackageUpdates(row, deps);
	assert.strictEqual(fetchFn.calls.length, 1);
	await checkPackageUpdates(row, deps);
	assert.strictEqual(fetchFn.calls.length, 1, 'inside the lifetime the registry is not asked again');
});

test('a stale cache asks again', async () => {
	const fetchFn = fetchAnswering({ 'pi-lens': '4.4.0' });
	const { cache, flights } = privateCache();
	const row = [{ path: 'C:\\p\\npm\\node_modules\\pi-lens', name: 'pi-lens', version: '4.3.0', source: 'npm:pi-lens' }];
	let clock = 1_000;
	const deps: CheckDependencies = { fetchFn, cache, flights, now: () => clock };
	await checkPackageUpdates(row, deps);
	clock += UPDATE_CHECK_TTL_MS; // the boundary is exclusive: at exactly the TTL the answer is stale
	await checkPackageUpdates(row, deps);
	assert.strictEqual(fetchFn.calls.length, 2);
});

test('a failed lookup is not cached: the next check asks again', async () => {
	const fetchFn = fetchAnswering({ 'pi-lens': '4.4.0' }, 500);
	const { cache, flights } = privateCache();
	const row = [{ path: 'C:\\p\\npm\\node_modules\\pi-lens', name: 'pi-lens', version: '4.3.0', source: 'npm:pi-lens' }];
	const deps: CheckDependencies = { fetchFn, cache, flights, now: () => 1_000 };
	const first = await checkPackageUpdates(row, deps);
	assert.strictEqual(first[0].state, 'unknown');
	await checkPackageUpdates(row, deps);
	assert.strictEqual(fetchFn.calls.length, 2, 'npm being down must not be remembered as an answer');
});

test('overlapping checks for one package share one flight', async () => {
	const fetchFn = fetchAnswering({ 'pi-lens': '4.4.0' });
	const { cache, flights } = privateCache();
	const row = [{ path: 'C:\\p\\npm\\node_modules\\pi-lens', name: 'pi-lens', version: '4.3.0', source: 'npm:pi-lens' }];
	const deps: CheckDependencies = { fetchFn, cache, flights, now: () => 1_000 };
	await Promise.all([checkPackageUpdates(row, deps), checkPackageUpdates(row, deps), checkPackageUpdates(row, deps)]);
	assert.strictEqual(fetchFn.calls.length, 1);
});

/* ------------------------------------------------------------------ *
 * The update run
 * ------------------------------------------------------------------ */

test('the update runs npm through the shell-free planner, as one install of the npm project', async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await updatePackage('npm:pi-lens', {
		npmProject: 'D:\\profile\\npm',
		npmCli: 'D:\\node\\node_modules\\npm\\bin\\npm-cli.js',
		spawn,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(spawn.calls.length, 1);
	const { file, args, options } = spawn.calls[0];
	assert.strictEqual(file, process.execPath);
	assert.deepStrictEqual(args, [
		'D:\\node\\node_modules\\npm\\bin\\npm-cli.js',
		...packageUpdateArgs('pi-lens'),
	]);
	assert.strictEqual(options.shell, false);
	assert.strictEqual(options.cwd, 'D:\\profile\\npm');
	assert.strictEqual(options.env['ELECTRON_RUN_AS_NODE'], '1');
	assert.deepStrictEqual(packageUpdateArgs('pi-lens'), ['install', '--save', '--no-audit', '--no-fund', 'pi-lens@latest']);
});

test('the update survives a path with a space: no shell, one argument', async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const npmProject = 'D:\\PiCode-win32-x64 - experimental2\\data\\pi-agent\\npm';
	await updatePackage('npm:pi-lens', {
		npmProject,
		npmCli: 'D:\\node - copy\\node_modules\\npm\\bin\\npm-cli.js',
		spawn,
	});
	const { args, options } = spawn.calls[0];
	assert.strictEqual(options.shell, false, 'the primary plan never shells');
	assert.strictEqual(args.filter(arg => arg.includes(' ')).length, 1, 'the spaced CLI path stays one element — nothing split it');
	assert.strictEqual(options.cwd, npmProject, 'the spaced npm project arrives as the cwd, never through a shell');
});

test('without a located CLI the fallback goes through a shell with every argument quoted', async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await updatePackage('npm:pi-lens', { npmProject: 'D:\\spaced dir\\npm', spawn });
	assert.strictEqual(result.ok, true);
	const { file, args, options } = spawn.calls[0];
	assert.strictEqual(file, 'npm');
	assert.strictEqual(options.shell, true);
	assert.ok(args.every(arg => !arg.includes(' ') || (arg.startsWith('"') && arg.endsWith('"'))), 'every argument a shell could act on arrives quoted');
	assert.strictEqual(options.cwd, 'D:\\spaced dir\\npm');
});

test('a pinned declaration is refused before anything is spawned', async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await updatePackage('npm:pi-lens@4.3.0', { npmProject: 'D:\\profile\\npm', npmCli: 'cli.js', spawn });
	assert.strictEqual(result.ok, false);
	assert.match(result.message, /pinned/);
	assert.strictEqual(spawn.calls.length, 0);
});

test('a package that cannot be checked is refused with its reason', async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await updatePackage('git:github.com/HazAT/pi-interactive-subagents', { npmProject: 'D:\\profile\\npm', npmCli: 'cli.js', spawn });
	assert.strictEqual(result.ok, false);
	assert.match(result.message, /git/);
	assert.strictEqual(spawn.calls.length, 0);
});

test('an unsafe npm name never reaches the process', async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await updatePackage('npm:pkg;rm-rf', { npmProject: 'D:\\profile\\npm', npmCli: 'cli.js', spawn });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(spawn.calls.length, 0);
});

test('a failed npm run answers with the reason npm gave', async () => {
	const spawn = spawnAnswering({ ok: false, stderr: 'npm error code E404\nnpm error 404 Not Found' });
	const result = await updatePackage('npm:pi-lens', { npmProject: 'D:\\profile\\npm', npmCli: 'cli.js', spawn });
	assert.strictEqual(result.ok, false);
	assert.match(result.message, /404 Not Found/);
});
