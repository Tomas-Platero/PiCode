/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's own package installer, run on its own.
 *
 * The fixtures mirror the situation the installer exists for: a profile whose settings declare
 * packages the disk does not hold. pi's own loader would install each missing one with its own
 * npm process — and on Windows every one of those flashes a console window — so the editor
 * installs the whole missing set first, in one hidden run, and the loader finds nothing to do.
 */

import assert from 'assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

/**
 * Why the imports below arrive through a hook and not a plain statement.
 *
 * Running a `.ts` file directly, Node strips types but resolves imports as ESM — and ESM has
 * no extensionless resolution, so the sources' `from './packages-registry'` (which the
 * compiler requires extensionless) cannot be found. The hook adds the extension the runtime
 * needs for exactly the relative specifiers that lack one, in this test process only; the
 * compiled build is untouched. The same hook every other test here registers — and it must be
 * registered before the sources are imported, which is why they arrive dynamically below.
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
	ensureProfilePackages,
	isSafeNpmInstallSpec,
	scanDeclaredPackages,
} = await import('../src/packages-install.ts');
const { parseSettings } = await import('../src/packages-data.ts');

/* ------------------------------------------------------------------ *
 * The spec whitelist: what may reach npm's shell
 * ------------------------------------------------------------------ */

test('a plain, scoped and pinned npm spec passes the whitelist', () => {
	assert.equal(isSafeNpmInstallSpec('pi-memory'), true);
	assert.equal(isSafeNpmInstallSpec('@tintinweb/pi-subagents'), true);
	assert.equal(isSafeNpmInstallSpec('pi-web-access@1.2.3'), true);
	assert.equal(isSafeNpmInstallSpec('@scope/pkg@^1.0.0'), true);
	assert.equal(isSafeNpmInstallSpec('pkg@>=1.0.0'), true);
});

test('a git+https source passes the whitelist', () => {
	assert.equal(isSafeNpmInstallSpec('git+https://github.com/HazAT/pi-interactive-subagents'), true);
});

test('shell metacharacters are rejected, with the reason the refusal names', () => {
	for (const hostile of [
		'pkg; rm -rf /',
		'pkg && calc',
		'pkg`whoami`',
		'pkg$(calc)',
		'pkg|calc',
		'pkg&calc',
		"pkg' ; calc",
		'pkg" ; calc',
		'pkg\ncalc',
		'--legacy-peer-deps',
		'-h',
		'pkg ../../elsewhere',
	]) {
		assert.equal(isSafeNpmInstallSpec(hostile), false, `expected rejection: ${hostile}`);
	}
});

/* ------------------------------------------------------------------ *
 * The scan: what the settings declare against what the disk holds
 * ------------------------------------------------------------------ */

function scanIoFixture(directories: Set<string>, versions: Map<string, string>) {
	return {
		directoryExists: (dir: string): boolean => directories.has(dir),
		manifestVersion: (dir: string): string | undefined => versions.get(dir),
	};
}

const NPM_ROOT = 'C:\\profile\\npm\\node_modules';
const GIT_ROOT = 'C:\\profile\\git';
const join = (parts: string[]): string => parts.join('\\');

test('a missing declared npm package becomes one spec; installed and left-behind ones do not', () => {
	const settings = parseSettings(JSON.stringify({
		packages: [
			'npm:pi-memory',
			'npm:pi-lens',
			'npm:gentle-pi',
			'npm:specpi@2.0.0',
			'local:tools/skill',
		],
	}));
	const scan = scanDeclaredPackages(
		settings,
		NPM_ROOT,
		GIT_ROOT,
		scanIoFixture(
			new Set([
				join([NPM_ROOT, 'pi-memory']),
				join([NPM_ROOT, 'specpi']),
			]),
			new Map([[join([NPM_ROOT, 'specpi']), '2.0.0']]),
		),
	);
	assert.deepEqual(scan.specs, ['pi-lens']);
	assert.deepEqual(scan.gitClones, []);
	assert.equal(scan.present, 2); // pi-memory, specpi at its pinned version
	assert.equal(scan.skipped, 2); // gentle-pi is left behind; the local path is not installable
});

test('a stale exact pin is reinstalled, so pi never reinstalls it with its own window', () => {
	const settings = parseSettings(JSON.stringify({ packages: ['npm:specpi@2.0.0'] }));
	const scan = scanDeclaredPackages(
		settings,
		NPM_ROOT,
		GIT_ROOT,
		scanIoFixture(
			new Set([join([NPM_ROOT, 'specpi'])]),
			new Map([[join([NPM_ROOT, 'specpi']), '1.0.0']]),
		),
	);
	assert.deepEqual(scan.specs, ['specpi@2.0.0']);
	assert.equal(scan.present, 0);
});

test('a missing git declaration becomes one clone into the profile git root', () => {
	const settings = parseSettings(JSON.stringify({ packages: ['git:github.com/HazAT/pi-interactive-subagents'] }));
	const scan = scanDeclaredPackages(
		settings,
		NPM_ROOT,
		GIT_ROOT,
		scanIoFixture(new Set(), new Map()),
	);
	assert.deepEqual(scan.gitClones, [{
		url: 'https://github.com/HazAT/pi-interactive-subagents',
		target: join([GIT_ROOT, 'github.com', 'HazAT', 'pi-interactive-subagents']),
	}]);
	assert.deepEqual(scan.specs, []);
});

test('a declaration no parser and no whitelist accepts is refused, not installed', () => {
	const settings = parseSettings(JSON.stringify({ packages: ['npm:pkg;calc'] }));
	const scan = scanDeclaredPackages(
		settings,
		NPM_ROOT,
		GIT_ROOT,
		scanIoFixture(new Set(), new Map()),
	);
	assert.deepEqual(scan.specs, []);
	assert.equal(scan.failedBeforeSpawn, 1);
	assert.equal(scan.rejected.length, 1);
	assert.match(scan.rejected[0]!, /pkg;calc/);
});

/* ------------------------------------------------------------------ *
 * The ensure: one hidden process for the whole missing set
 * ------------------------------------------------------------------ */

interface RecordedCall {
	readonly file: string;
	readonly args: readonly string[];
	readonly options: { readonly cwd: string; readonly windowsHide: boolean };
}

function fakeSpawn(ok = true): { spawn: (file: string, args: readonly string[], options: { cwd: string; windowsHide: boolean }) => Promise<{ ok: boolean; stderr: string }>; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const spawn = (file: string, args: readonly string[], options: { cwd: string; windowsHide: boolean }) => {
		calls.push({ file, args: [...args], options });
		return Promise.resolve({ ok, stderr: ok ? '' : 'npm error 404 not found' });
	};
	return { spawn, calls };
}

function optionsFor(profile: string, spawn: (file: string, args: readonly string[], options: { cwd: string; windowsHide: boolean }) => Promise<{ ok: boolean; stderr: string }>) {
	return {
		profileDir: profile,
		spawn,
		io: {
			readSettingsText: (_file: string): string | undefined =>
				JSON.stringify({ packages: ['npm:alpha', 'npm:beta', 'npm:gamma'] }),
			directoryExists: (_dir: string): boolean => false,
			manifestVersion: (_dir: string): string | undefined => undefined,
		},
	};
}

test('three missing packages are installed by exactly one npm process, hidden', async () => {
	const { spawn, calls } = fakeSpawn();
	const profile = 'C:\\profiles\\throwaway';
	const outcome = await ensureProfilePackages(optionsFor(profile, spawn));
	assert.equal(calls.length, 1, 'one process, not one per package');
	assert.equal(calls[0]!.file, 'npm');
	assert.deepEqual(calls[0]!.args.slice(0, 4), ['install', '--save', '--no-audit', '--no-fund']);
	assert.deepEqual(calls[0]!.args.slice(4).sort(), ['alpha', 'beta', 'gamma']);
	assert.equal(calls[0]!.options.windowsHide, true);
	assert.equal(outcome.installed, 3);
	assert.equal(outcome.failed, 0);
	assert.ok(outcome.lines.some(line => /Installed 3 packages/.test(line)), outcome.lines.join('\n'));
});

test('a profile that is already whole spawns nothing and says nothing', async () => {
	const { spawn, calls } = fakeSpawn();
	const profile = 'C:\\profiles\\whole';
	const options = optionsFor(profile, spawn);
	const whole = scanIoFixture(
		new Set([
			join([profile, 'npm', 'node_modules', 'alpha']),
			join([profile, 'npm', 'node_modules', 'beta']),
			join([profile, 'npm', 'node_modules', 'gamma']),
		]),
		new Map(),
	);
	options.io.directoryExists = whole.directoryExists;
	const outcome = await ensureProfilePackages(options);
	assert.equal(calls.length, 0);
	assert.equal(outcome.installed, 0);
	assert.equal(outcome.present, 3);
	assert.deepEqual(outcome.lines, []);
});

test('a failed batch is retried one spec at a time, still hidden, and the failure is a sentence', async () => {
	const { spawn, calls } = fakeSpawn(false);
	const outcome = await ensureProfilePackages(optionsFor('C:\\profiles\\failing', spawn));
	// One batch attempt, then one per spec: four processes for three packages, every one hidden.
	assert.equal(calls.length, 4);
	assert.ok(calls.every(call => call.options.windowsHide === true));
	assert.equal(outcome.installed, 0);
	assert.equal(outcome.failed, 3);
	assert.ok(outcome.lines.some(line => /could not be installed/.test(line)), outcome.lines.join('\n'));
});

test('a refused spec never reaches the shell', async () => {
	const { spawn, calls } = fakeSpawn();
	const options = optionsFor('C:\\profiles\\hostile', spawn);
	options.io.readSettingsText = () => JSON.stringify({ packages: ['npm:pkg;calc', 'npm:alpha'] });
	const outcome = await ensureProfilePackages(options);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.args.slice(4), ['alpha']);
	assert.equal(outcome.rejected.length, 1);
});

test("with npm's CLI script the install runs as node over it: no shell, nothing to split on a space", async () => {
	const { spawn, calls } = fakeSpawn();
	const options = { ...optionsFor('C:\\profiles with spaces\\throwaway', spawn), npmCli: 'C:\\node\\npm-cli.js' };
	await ensureProfilePackages(options);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.file, process.execPath, 'the CLI script runs under the editor binary, as Node');
	assert.deepEqual(calls[0]!.args, ['C:\\node\\npm-cli.js', 'install', '--save', '--no-audit', '--no-fund', 'alpha', 'beta', 'gamma']);
});
