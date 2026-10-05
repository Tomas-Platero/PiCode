/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The npm run planner's rules, run on their own.
 *
 * The bug behind this module: a shell concatenates its arguments, so the update's
 * `--prefix <runtimeDir>` split on a side-by-side build's `" - experimental2"` suffix and
 * npm read a prefix that does not exist plus two junk arguments. The plan's answer is node
 * over npm's own CLI script — a real arguments array, no shell — and, for the shim fallback
 * that still shells, quoting first. The tests pin the exact argv each shape issues, spaced
 * paths included.
 */

import assert from 'assert';
import * as path from 'node:path';
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

const { locateNpmCli, planNpmRun, npmRunEnv, shellSafeArgument } = await import('../src/npm-run.ts');

/* ------------------------------------------------------------------ *
 * Finding npm's CLI script
 * ------------------------------------------------------------------ */

test('the Windows layout: the CLI sits beside the npm.cmd shim, under node_modules', () => {
	const seen: string[] = [];
	const cli = locateNpmCli({
		platform: 'win32',
		resolve: name => (name === 'npm' ? 'C:\\Program Files\\nodejs\\npm.cmd' : undefined),
		exists: file => {
			seen.push(file);
			return true;
		},
	});
	assert.strictEqual(cli, 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
	assert.ok(seen.every(file => !file.includes('npm.cmd')), 'the CLI script is probed, never the shim');
});

test('the Unix layout: the CLI is one prefix up from the shim, under lib', () => {
	const cli = locateNpmCli({
		platform: 'linux',
		resolve: name => (name === 'npm' ? '/usr/bin/npm' : undefined),
		exists: () => true,
	});
	// On a POSIX host the join spells `/usr/lib/…`; the expectation is spelled through the
	// same path semantics so this test also reads on Windows.
	assert.strictEqual(cli, path.join('/usr/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
});

test('no npm on PATH, or no CLI behind the shim, is undefined — the caller falls back, never guesses', () => {
	assert.strictEqual(locateNpmCli({ platform: 'win32', resolve: () => undefined, exists: () => true }), undefined);
	assert.strictEqual(locateNpmCli({ platform: 'win32', resolve: () => 'C:\\node\\npm.cmd', exists: () => false }), undefined);
});

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

test('with the CLI known, npm runs as node over npm-cli.js: an args array, no shell', () => {
	const plan = planNpmRun(
		['install', '--prefix', 'D:\\PiCode-win32-x64 - experimental2\\resources\\pi-runtime', '--save-exact', '@earendil-works/pi-coding-agent@latest'],
		{ npmCli: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', execPath: 'C:\\app\\PiCode.exe' },
	);
	assert.strictEqual(plan.file, 'C:\\app\\PiCode.exe');
	assert.deepStrictEqual([...plan.args], [
		'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
		'install',
		'--prefix', 'D:\\PiCode-win32-x64 - experimental2\\resources\\pi-runtime',
		'--save-exact', '@earendil-works/pi-coding-agent@latest',
	], 'the spaced prefix is one argument, exactly as npm must read it');
	assert.strictEqual(plan.shell, false);
	assert.strictEqual(plan.runAsNode, true);
});

test('without the CLI, the plan falls back to the npm shim through a shell, every argument quoted', () => {
	const plan = planNpmRun(
		['install', '--prefix', 'D:\\PiCode-win32-x64 - experimental2\\resources\\pi-runtime', 'pkg@1.0.0'],
		{ platform: 'win32' },
	);
	assert.strictEqual(plan.file, 'npm');
	assert.deepStrictEqual([...plan.args], [
		'install',
		'--prefix', '"D:\\PiCode-win32-x64 - experimental2\\resources\\pi-runtime"',
		'pkg@1.0.0',
	], 'the spaced prefix is quoted, so the shell cannot split it; the bare spec is untouched');
	assert.strictEqual(plan.shell, true);
	assert.strictEqual(plan.runAsNode, false);
});

test('quoting is for the shell metacharacters, and nothing that needs none is touched', () => {
	assert.strictEqual(shellSafeArgument('plain-spec'), 'plain-spec');
	assert.strictEqual(shellSafeArgument('a b'), '"a b"');
	assert.strictEqual(shellSafeArgument('a&b'), '"a&b"');
	assert.strictEqual(shellSafeArgument('C:\\path'), 'C:\\path');
});

test('the environment carries ELECTRON_RUN_AS_NODE only when the editor binary runs npm-cli.js', () => {
	const node = planNpmRun(['--version'], { npmCli: 'cli.js' });
	assert.deepStrictEqual(npmRunEnv(node, { A: '1' }), { A: '1', ELECTRON_RUN_AS_NODE: '1' });
	const shim = planNpmRun(['--version'], {});
	assert.deepStrictEqual(npmRunEnv(shim, { A: '1' }), { A: '1' });
});
