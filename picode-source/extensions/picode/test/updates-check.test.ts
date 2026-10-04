/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The update check's rules, run on their own.
 *
 * What can be updated is a rule about versions — which of the installed things an npm registry
 * says are behind — and about the shapes the editor stores and shows: the snapshot that survives
 * a restart, the one sentence the notification carries, and the `pi update` run itself. The
 * network, the clock and the process all arrive from the test, so none of them is needed to
 * exercise the rules.
 */

import assert from 'assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const {
	compareVersions,
	describeTargets,
	fetchNpmLatest,
	npmLatestUrl,
	parseSnapshot,
	runPiUpdate,
	updatableTargets,
	UPDATE_TIMEOUT_MS,
} = await import('../src/updates-check.ts');

type FetchFn = NonNullable<Parameters<typeof fetchNpmLatest>[1]>['fetchFn'];
type UpdateContext = Parameters<typeof runPiUpdate>[0];
type SpawnFn = NonNullable<UpdateContext['spawn']>;
type SpawnOptions = Parameters<SpawnFn>[2];

/** One fetch that answers `body` once per URL and records what it was asked. */
function fetchAnswering(body: unknown, status = 200): FetchFn & { calls: string[] } {
	const fetchFn = ((url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
		fetchFn.calls.push(url);
		return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
	}) as FetchFn & { calls: string[] };
	fetchFn.calls = [];
	return fetchFn;
}

/** One spawn that records what it was handed and answers `outcome`. */
function spawnAnswering(outcome: { ok: boolean; stderr: string }): SpawnFn & { calls: { file: string; args: readonly string[]; options: SpawnOptions }[] } {
	const spawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
		spawn.calls.push({ file, args, options });
		return Promise.resolve(outcome);
	}) as SpawnFn & { calls: { file: string; args: readonly string[]; options: SpawnOptions }[] };
	spawn.calls = [];
	return spawn;
}

/* ------------------------------------------------------------------ *
 * The comparator
 * ------------------------------------------------------------------ */

test('equal versions compare as equal, with or without the leading v', () => {
	assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
	assert.strictEqual(compareVersions('v1.2.3', '1.2.3'), 0);
	assert.strictEqual(compareVersions('1.2.3', 'V1.2.3'), 0);
});

test('a higher patch, minor or major compares as greater', () => {
	assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
	assert.ok(compareVersions('1.3.0', '1.2.9') > 0);
	assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
	assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
	assert.ok(compareVersions('1.2.10', '1.2.9') > 0, 'numeric compare, not lexicographic');
});

test('a release is greater than any of its prereleases, and prereleases order among themselves', () => {
	assert.ok(compareVersions('1.0.0', '1.0.0-alpha') > 0);
	assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
	assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-beta') < 0);
	assert.ok(compareVersions('1.0.0-beta', '1.0.0-rc.1') < 0);
	assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
});

test('numeric prerelease identifiers compare numerically, never lexicographically', () => {
	assert.ok(compareVersions('1.0.0-2', '1.0.0-10') < 0);
	assert.ok(compareVersions('1.0.0-10', '1.0.0-2') > 0);
	assert.ok(compareVersions('1.0.0-9', '1.0.0-10') < 0);
});

test('junk versions never throw and equal junk compares as equal', () => {
	assert.strictEqual(compareVersions('not-a-version', 'not-a-version'), 0);
	assert.strictEqual(typeof compareVersions('junk', '1.0.0'), 'number');
	assert.strictEqual(typeof compareVersions('', '1.0.0'), 'number');
});

/* ------------------------------------------------------------------ *
 * The target assembly
 * ------------------------------------------------------------------ */

test('nothing is updatable when every installed version matches its latest', () => {
	const targets = updatableTargets([
		{ kind: 'runtime', name: 'pi', installed: '0.87.1', latest: '0.87.1' },
		{ kind: 'package', name: 'pi-pretty', installed: '0.1.0', latest: '0.1.0' },
	]);
	assert.deepStrictEqual(targets, []);
});

test('the updatables keep their order and their kind', () => {
	const targets = updatableTargets([
		{ kind: 'runtime', name: 'pi', installed: '0.87.1', latest: '0.88.0' },
		{ kind: 'package', name: 'pi-pretty', installed: '0.1.0', latest: '0.2.0' },
	]);
	assert.deepStrictEqual(targets, [
		{ kind: 'runtime', name: 'pi', installed: '0.87.1', latest: '0.88.0' },
		{ kind: 'package', name: 'pi-pretty', installed: '0.1.0', latest: '0.2.0' },
	]);
});

test('a prerelease upgrade counts as an update', () => {
	const targets = updatableTargets([
		{ kind: 'package', name: 'bleeding-edge', installed: '1.0.0', latest: '1.1.0-beta.1' },
	]);
	assert.deepStrictEqual(targets, [
		{ kind: 'package', name: 'bleeding-edge', installed: '1.0.0', latest: '1.1.0-beta.1' },
	]);
});

test('a downgrade is not an update', () => {
	const targets = updatableTargets([
		{ kind: 'package', name: 'pinned', installed: '2.0.0', latest: '1.9.0' },
	]);
	assert.deepStrictEqual(targets, []);
});

test('missing or junk versions are tolerated and never reported as updates', () => {
	const targets = updatableTargets([
		{ kind: 'runtime', name: 'pi', installed: undefined, latest: '0.88.0' },
		{ kind: 'package', name: 'pi-pretty', installed: '0.1.0', latest: undefined },
		{ kind: 'package', name: 'git-only', installed: undefined, latest: undefined },
		{ kind: 'package', name: 'local-build', installed: 'dev', latest: '1.0.0' },
	]);
	assert.deepStrictEqual(targets, []);
});

/* ------------------------------------------------------------------ *
 * The sentence
 * ------------------------------------------------------------------ */

test('the sentence names the runtime individually and packages by count and names', () => {
	const sentence = describeTargets([
		{ kind: 'runtime', name: 'pi', installed: '0.87.1', latest: '0.88.0' },
		{ kind: 'package', name: 'pi-pretty', installed: '0.1.0', latest: '0.2.0' },
		{ kind: 'package', name: 'pi-lint', installed: '1.0.0', latest: '1.1.0' },
	]);
	assert.strictEqual(sentence, 'pi: update to 0.88.0 available (now 0.87.1), 2 packages have updates available: pi-pretty, pi-lint');
});

test('one package reads as a singular package with its versions', () => {
	const sentence = describeTargets([
		{ kind: 'package', name: 'pi-pretty', installed: '0.1.0', latest: '0.2.0' },
	]);
	assert.strictEqual(sentence, '1 package: pi-pretty, update to 0.2.0 available (now 0.1.0)');
});

/* ------------------------------------------------------------------ *
 * The snapshot
 * ------------------------------------------------------------------ */

test('a snapshot survives a JSON round trip, the way globalState carries it', () => {
	const snapshot = {
		checkedAt: 1_700_000_000_000,
		targets: [
			{ kind: 'runtime', name: 'pi', installed: '0.87.1', latest: '0.88.0' },
			{ kind: 'package', name: 'pi-pretty', installed: '0.1.0', latest: '0.2.0' },
		],
	};
	const round = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
	assert.deepStrictEqual(round, snapshot);
});

test('a snapshot that says nothing this module understands is undefined', () => {
	assert.strictEqual(parseSnapshot(undefined), undefined);
	assert.strictEqual(parseSnapshot(null), undefined);
	assert.strictEqual(parseSnapshot(42), undefined);
	assert.strictEqual(parseSnapshot({}), undefined);
	assert.strictEqual(parseSnapshot({ checkedAt: 'yesterday', targets: [] }), undefined);
	assert.strictEqual(parseSnapshot({ checkedAt: 1, targets: 'all of them' }), undefined);
	assert.strictEqual(parseSnapshot({ checkedAt: 1, targets: [{ kind: 'mystery', name: 'x', installed: '1', latest: '2' }] }), undefined);
	assert.strictEqual(parseSnapshot({ checkedAt: 1, targets: [{ kind: 'package', name: 7, installed: '1', latest: '2' }] }), undefined);
});

/* ------------------------------------------------------------------ *
 * The npm latest lookup
 * ------------------------------------------------------------------ */

test('the latest lookup asks npm for the package, scoped names included', async () => {
	assert.strictEqual(npmLatestUrl('pi-pretty'), 'https://registry.npmjs.org/pi-pretty/latest');
	assert.strictEqual(npmLatestUrl('@earendil-works/pi-coding-agent'), 'https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/latest');
});

test('the latest version is read from npm answer', async () => {
	const fetchFn = fetchAnswering({ name: 'pi-pretty', version: '1.3.0' });
	assert.strictEqual(await fetchNpmLatest('pi-pretty', { fetchFn }), '1.3.0');
	assert.deepStrictEqual(fetchFn.calls, ['https://registry.npmjs.org/pi-pretty/latest']);
});

test('a failed or meaningless npm answer is no version, said out loud once', async () => {
	const lines: string[] = [];
	assert.strictEqual(await fetchNpmLatest('gone', { fetchFn: fetchAnswering({}, 404), log: line => lines.push(line) }), undefined);
	assert.strictEqual(await fetchNpmLatest('junk', { fetchFn: fetchAnswering({ version: 3 }), log: line => lines.push(line) }), undefined);
	assert.strictEqual(await fetchNpmLatest('down', { fetchFn: () => Promise.reject(new Error('socket hang up')), log: line => lines.push(line) }), undefined);
	assert.strictEqual(lines.length, 3);
});

/* ------------------------------------------------------------------ *
 * The update run
 * ------------------------------------------------------------------ */

test("the update reinstalls the runtime with npm, then updates the packages with pi", async () => {
	const spawn = spawnAnswering({ ok: true, stderr: '' });
	const result = await runPiUpdate({ cliEntry: '/runtime/cli.js', runtimeDir: '/runtime', profileDir: '/profile', spawn });

	assert.deepStrictEqual(result, { ok: true, message: 'PiCode updated.' });
	assert.strictEqual(spawn.calls.length, 2);

	// The runtime: npm, into the directory the build installed it into — pi itself refuses to
	// self-update a bundled install.
	const npm = spawn.calls[0];
	assert.strictEqual(npm.file, 'npm');
	assert.deepStrictEqual([...npm.args], [
		'install', '--prefix', '/runtime', '--no-audit', '--no-fund', '--save-exact',
		'@earendil-works/pi-coding-agent@latest',
	]);
	assert.strictEqual(npm.options.shell, true);
	assert.strictEqual(npm.options.windowsHide, true);
	assert.strictEqual(npm.options.timeoutMs, UPDATE_TIMEOUT_MS);

	// The packages: pi's own update, as Node through the editor's executable.
	const pi = spawn.calls[1];
	assert.strictEqual(pi.file, process.execPath);
	assert.deepStrictEqual([...pi.args], ['/runtime/cli.js', 'update', '--extensions']);
	assert.strictEqual(pi.options.env.PI_CODING_AGENT_DIR, '/profile');
	assert.strictEqual(pi.options.env.ELECTRON_RUN_AS_NODE, '1');
	assert.strictEqual(pi.options.timeoutMs, UPDATE_TIMEOUT_MS);
	assert.ok(UPDATE_TIMEOUT_MS >= 300_000, 'an update of the runtime and every package gets a generous leash');
});

test("a failed update carries the last meaningful line of the command's stderr", async () => {
	const spawn = spawnAnswering({ ok: false, stderr: 'npm warn deprecated\nnpm error code EACCES\n' });
	const result = await runPiUpdate({ cliEntry: '/cli.js', runtimeDir: '/runtime', profileDir: '/profile', spawn });
	assert.deepStrictEqual(result, { ok: false, message: 'PiCode could not update pi: npm error code EACCES' });
});

test('a spawn that throws is a failed update, not a rejection the window sees', async () => {
	const spawn: SpawnFn = () => Promise.reject(new Error('spawn ENOENT'));
	const result = await runPiUpdate({ cliEntry: '/cli.js', runtimeDir: '/runtime', profileDir: '/profile', spawn });
	assert.strictEqual(result.ok, false);
	assert.ok(result.message.includes('could not be updated'));
});
