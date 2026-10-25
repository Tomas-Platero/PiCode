/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The packages an import leaves behind, and the settings copy that drops their
 * declarations, run on their own.
 *
 * Everything here is a rule about names and bytes — which `packages` entries are refused,
 * in both spellings pi allows, and what exactly survives in the copied `settings.json` —
 * so every rule is exercised without a profile, an editor, or a process.
 */

import assert from 'assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

/**
 * Why the imports below arrive through a hook and not a plain statement.
 *
 * Running a `.ts` file directly, Node strips types but resolves imports as ESM — and ESM has
 * no extensionless resolution, so a relative import without an extension (which the compiler
 * requires) cannot be found. The hook adds the extension the runtime needs for exactly those
 * specifiers, in this test process only; the compiled build is untouched.
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
	LEFT_BEHIND_PACKAGE_NAMES,
	isLeftBehindPackage,
	leftBehindReference,
	packageNameOf,
	splitLeftBehindPackages,
} = await import('../src/left-behind-packages.ts');
const { filteredSettingsText } = await import('../src/profile-import.ts');

// The mechanism is exercised with a list of its own: the product's list is empty today, because
// gentle-pi and gentle-engram are pinned packages of the product (ADR-030).
const NAMES = ['gentle-pi', 'gentle-engram'];

test('the product carries gentle-pi and gentle-engram, and leaves the durable agent\'s package behind', () => {
	assert.deepStrictEqual([...LEFT_BEHIND_PACKAGE_NAMES], ['@earendil-works/pi-durable', '@tintinweb/pi-subagents', 'github.com/HazAT/pi-interactive-subagents', 'pi-memory']);
	assert.strictEqual(isLeftBehindPackage('npm:@tintinweb/pi-subagents'), true);
	assert.strictEqual(isLeftBehindPackage('git:github.com/HazAT/pi-interactive-subagents'), true);
	assert.strictEqual(isLeftBehindPackage('npm:pi-memory'), true);
	assert.strictEqual(isLeftBehindPackage('npm:@earendil-works/pi-durable'), true);
	assert.strictEqual(isLeftBehindPackage({ source: 'npm:@earendil-works/pi-durable@1.4.0' }), true);
	assert.strictEqual(isLeftBehindPackage('npm:gentle-pi'), false);
	assert.strictEqual(isLeftBehindPackage({ source: 'npm:gentle-engram@0.4.2' }), false);
	const source = JSON.stringify({ packages: ['npm:gentle-pi', 'npm:gentle-engram@0.4.2'] });
	assert.deepStrictEqual(filteredSettingsText(source), { text: source, leftBehind: [] });
});

test('a bare name is read as it is written', () => {
	assert.strictEqual(packageNameOf('gentle-pi'), 'gentle-pi');
	assert.strictEqual(packageNameOf('  gentle-engram  '), 'gentle-engram');
});

test('the npm: and git: prefixes come off', () => {
	assert.strictEqual(packageNameOf('npm:gentle-pi'), 'gentle-pi');
	assert.strictEqual(packageNameOf('NPM:gentle-engram'), 'gentle-engram');
	assert.strictEqual(packageNameOf('git:gentle-pi'), 'gentle-pi');
});

test('an @version suffix comes off, including a pinned one', () => {
	assert.strictEqual(packageNameOf('npm:gentle-engram@0.1.15'), 'gentle-engram');
	assert.strictEqual(packageNameOf('gentle-pi@2.0.0-beta.1'), 'gentle-pi');
});

test('a scoped name keeps its leading @ and loses only the version', () => {
	assert.strictEqual(packageNameOf('@scope/pkg'), '@scope/pkg');
	assert.strictEqual(packageNameOf('npm:@scope/pkg@1.2.3'), '@scope/pkg');
});

test('a name that merely contains a left-behind name is not refused', () => {
	assert.strictEqual(packageNameOf('gentle-pi-extras'), 'gentle-pi-extras');
	assert.strictEqual(isLeftBehindPackage('npm:gentle-pi-extras', NAMES), false);
	assert.strictEqual(isLeftBehindPackage('my-gentle-engram', NAMES), false);
});

test('the string spellings the real profile uses are all refused', () => {
	assert.strictEqual(isLeftBehindPackage('npm:gentle-pi', NAMES), true);
	assert.strictEqual(isLeftBehindPackage('npm:gentle-engram', NAMES), true);
	assert.strictEqual(isLeftBehindPackage('npm:gentle-engram@0.1.15', NAMES), true);
});

test('the object form is refused through its source', () => {
	assert.strictEqual(isLeftBehindPackage({ extensions: ['-extensions\\quiet-tools.ts'], source: 'npm:gentle-pi' }, NAMES), true);
	assert.strictEqual(isLeftBehindPackage({ source: 'npm:gentle-engram@0.1.15' }, NAMES), true);
});

test('an entry that names no package is not refused', () => {
	assert.strictEqual(isLeftBehindPackage('npm:some-other-package'), false);
	assert.strictEqual(isLeftBehindPackage('git:github.com/some/one'), false);
	assert.strictEqual(isLeftBehindPackage({ source: 'npm:some-other-package' }), false);
	assert.strictEqual(isLeftBehindPackage({ extensions: ['x.ts'] }), false);
	assert.strictEqual(isLeftBehindPackage(42), false);
	assert.strictEqual(isLeftBehindPackage(null), false);
	assert.strictEqual(isLeftBehindPackage(undefined), false);
});

test('the reference a log quotes is what the profile declared, verbatim', () => {
	assert.strictEqual(leftBehindReference('npm:gentle-engram@0.1.15', NAMES), 'npm:gentle-engram@0.1.15');
	assert.strictEqual(leftBehindReference({ extensions: ['-extensions\\quiet-tools.ts'], source: 'npm:gentle-pi' }, NAMES), 'npm:gentle-pi');
	assert.strictEqual(leftBehindReference('npm:some-other-package', NAMES), undefined);
});

test('splitting keeps the survivors in order and quotes the ones refused', () => {
	const { kept, leftBehind } = splitLeftBehindPackages([
		'npm:some-other-package',
		'npm:gentle-engram',
		{ extensions: ['-extensions\\quiet-tools.ts'], source: 'npm:gentle-pi' },
		'npm:gentle-engram@0.1.15',
	], NAMES);
	assert.deepStrictEqual(kept, ['npm:some-other-package']);
	assert.deepStrictEqual(leftBehind, ['npm:gentle-engram', 'npm:gentle-pi', 'npm:gentle-engram@0.1.15']);
});

test('splitting a list that is not a list keeps nothing and refuses nothing', () => {
	assert.deepStrictEqual(splitLeftBehindPackages(undefined), { kept: [], leftBehind: [] });
	assert.deepStrictEqual(splitLeftBehindPackages('npm:gentle-pi', NAMES), { kept: [], leftBehind: [] });
});

test('the settings copy removes only the left-behind entries', () => {
	const source = JSON.stringify({
		theme: 'Abyss',
		packages: ['npm:some-other-package', 'npm:gentle-engram@0.1.15', { source: 'npm:gentle-pi', extensions: ['-extensions\\quiet-tools.ts'] }],
		'mcp.servers': { local: { url: 'http://127.0.0.1:3939' } },
	});
	const { text, leftBehind } = filteredSettingsText(source, NAMES);
	assert.deepStrictEqual(leftBehind, ['npm:gentle-engram@0.1.15', 'npm:gentle-pi']);
	const copied: { theme?: string; packages?: unknown[]; 'mcp.servers'?: unknown } = JSON.parse(text);
	assert.strictEqual(copied['theme'], 'Abyss');
	assert.strictEqual(copied['mcp.servers'] !== undefined, true);
	assert.deepStrictEqual(copied['packages'], ['npm:some-other-package']);
});

test('the settings copy leaves a file with nothing to remove byte for byte alone', () => {
	const source = JSON.stringify({ theme: 'Abyss', packages: ['npm:some-other-package', '@scope/tool@2.1.0'] });
	const { text, leftBehind } = filteredSettingsText(source);
	assert.deepStrictEqual(leftBehind, []);
	assert.strictEqual(text, source);
});

test('the settings copy leaves a file it cannot parse exactly as it is', () => {
	const { text, leftBehind } = filteredSettingsText('{ not json ');
	assert.deepStrictEqual(leftBehind, []);
	assert.strictEqual(text, '{ not json ');
});

test('the settings copy leaves a file whose packages is not a list alone', () => {
	const source = JSON.stringify({ packages: 'npm:gentle-pi' });
	const { text, leftBehind } = filteredSettingsText(source, NAMES);
	assert.deepStrictEqual(leftBehind, []);
	assert.strictEqual(text, source);
});

test('the settings copy keeps every other key, in order, when it must rewrite', () => {
	const source = JSON.stringify({ theme: 'Abyss', packages: ['npm:gentle-pi'], keepLast: true });
	const { text } = filteredSettingsText(source, NAMES);
	assert.deepStrictEqual(Object.keys(JSON.parse(text)), ['theme', 'packages', 'keepLast']);
});
