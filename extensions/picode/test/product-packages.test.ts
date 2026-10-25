/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The packages the product pins in the profile, and the environment it fixes, run on their own.
 *
 * Both modules are rules about names, versions and bytes, so every rule is exercised without a
 * profile, an editor or a process.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRODUCT_ENV, applyProductEnv, withProductEnv } from '../src/product-env.ts';
import { GENTLE_PI_TERMINAL_EXTENSIONS, PRODUCT_PACKAGES, productEntry, withProductPackages } from '../src/product-packages.ts';

const GENTLE_PI = { source: 'npm:gentle-pi@4.3.0', extensions: [...GENTLE_PI_TERMINAL_EXTENSIONS], themes: [] };

test('the product pins gentle-pi and gentle-engram at exact versions', () => {
	assert.deepEqual(PRODUCT_PACKAGES.map(pkg => `${pkg.name}@${pkg.version}`), ['gentle-pi@4.3.0', 'gentle-engram@0.4.2']);
	for (const pkg of PRODUCT_PACKAGES) {
		assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `${pkg.name} is pinned exactly, never a range`);
	}
});

test('gentle-pi loses its terminal experience and keeps the rest; gentle-engram is whole', () => {
	assert.deepEqual(productEntry(PRODUCT_PACKAGES[0]!), GENTLE_PI);
	assert.equal(productEntry(PRODUCT_PACKAGES[1]!), 'npm:gentle-engram@0.4.2');
	for (const name of ['startup-banner', 'gentle-notifications', 'pi-pretty', 'gentle-herdr-activity', 'gentle-stats', 'gentle-shell', 'runtime-metrics']) {
		assert.ok(GENTLE_PI_TERMINAL_EXTENSIONS.includes(`!extensions/${name}.ts`), `${name} is excluded`);
	}
	assert.ok(GENTLE_PI_TERMINAL_EXTENSIONS.includes('!extensions/history/**'));
	// Only exclusions: pi reads that as "everything except these".
	assert.ok(GENTLE_PI_TERMINAL_EXTENSIONS.every(pattern => pattern.startsWith('!')));
});

test('a profile with no settings gets both packages declared', () => {
	const result = withProductPackages(undefined);
	assert.equal(result.changed, true);
	assert.deepEqual(JSON.parse(result.text!), { packages: [GENTLE_PI, 'npm:gentle-engram@0.4.2'] });
});

test('other entries and other keys stay exactly where they were', () => {
	const source = JSON.stringify({ theme: 'Abyss', packages: ['npm:pi-lens', { source: 'npm:other', extensions: ['x.ts'] }], keepLast: true });
	const result = withProductPackages(source);
	const parsed = JSON.parse(result.text!);
	assert.deepEqual(Object.keys(parsed), ['theme', 'packages', 'keepLast']);
	assert.deepEqual(parsed.packages, ['npm:pi-lens', { source: 'npm:other', extensions: ['x.ts'] }, GENTLE_PI, 'npm:gentle-engram@0.4.2']);
});

test('a ranged, unpinned or differently filtered declaration is put back as the product pins it, in place', () => {
	const source = JSON.stringify({ packages: ['npm:gentle-pi', 'npm:pi-lens', { source: 'npm:gentle-engram@^0.1.0', extensions: [] }] });
	const result = withProductPackages(source);
	assert.equal(result.changed, true);
	assert.deepEqual(JSON.parse(result.text!).packages, [GENTLE_PI, 'npm:pi-lens', 'npm:gentle-engram@0.4.2']);
});

test('a duplicate declaration is dropped', () => {
	const source = JSON.stringify({ packages: ['npm:gentle-engram@0.1.15', 'npm:gentle-engram', 'npm:gentle-pi@4.2.0'] });
	const parsed = JSON.parse(withProductPackages(source).text!);
	assert.deepEqual(parsed.packages, ['npm:gentle-engram@0.4.2', GENTLE_PI]);
});

test('a profile that already declares them as pinned is left byte for byte alone', () => {
	const source = `${JSON.stringify({ packages: [GENTLE_PI, 'npm:gentle-engram@0.4.2'] }, undefined, '\t')}\n`;
	const result = withProductPackages(source);
	assert.equal(result.changed, false);
	assert.equal(result.text, source);
});

test('a name that merely contains a product name is not the product package', () => {
	const source = JSON.stringify({ packages: ['npm:gentle-pi-extras', 'git:github.com/someone/gentle-pi'] });
	const parsed = JSON.parse(withProductPackages(source).text!);
	assert.deepEqual(parsed.packages, ['npm:gentle-pi-extras', 'git:github.com/someone/gentle-pi', GENTLE_PI, 'npm:gentle-engram@0.4.2']);
});

test('a settings file that is not a JSON object is never replaced by a guess', () => {
	for (const text of ['{ not json ', '[]', '"npm:gentle-pi"']) {
		const result = withProductPackages(text);
		assert.equal(result.changed, false);
		assert.equal(result.text, text);
	}
});

test('an empty list of products changes nothing', () => {
	assert.deepEqual(withProductPackages('{}', []), { text: '{}', changed: false });
});

test('the product fixes the install and the telemetry switches, and its values win', () => {
	assert.deepEqual({ ...PRODUCT_ENV }, { GENTLE_PI_SKIP_GENTLE_AI_INSTALL: '1', DO_NOT_TRACK: '1', GENTLE_AI_TELEMETRY: '0' });
	assert.deepEqual(withProductEnv({ A: '1', DO_NOT_TRACK: '0' }), { A: '1', ...PRODUCT_ENV });
});

test('applying the product environment sets it on the target and nothing else', () => {
	const target: NodeJS.ProcessEnv = { KEEP: 'yes' };
	applyProductEnv(target);
	assert.deepEqual(target, { KEEP: 'yes', ...PRODUCT_ENV });
});
