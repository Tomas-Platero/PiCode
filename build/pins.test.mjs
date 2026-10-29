/*
 * Tests for build/pins.mjs: the rules that decide whether a pin may move on its own.
 *
 *   node --test build/pins.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { extensionEntryPoints, isBreakingStep, satisfies, tarFiles } from './pins.mjs';

test('a major, or the minor of a 0.x, is a step that may break', () => {
	assert.equal(isBreakingStep('4.5.0', '4.5.1'), false);
	assert.equal(isBreakingStep('4.5.0', '4.6.0'), false);
	assert.equal(isBreakingStep('4.5.0', '5.0.0'), true);
	assert.equal(isBreakingStep('0.18.1', '0.18.2'), false);
	assert.equal(isBreakingStep('0.18.1', '0.19.0'), true);
});

test('peer ranges are read the way npm reads them', () => {
	assert.equal(satisfies('1.4.0', '*'), true);
	assert.equal(satisfies('1.4.0', '>=1.2.0'), true);
	assert.equal(satisfies('1.4.0', '>=1.5.0'), false);
	assert.equal(satisfies('1.4.0', '^1.2.0'), true);
	assert.equal(satisfies('1.4.0', '^2.0.0'), false);
	assert.equal(satisfies('0.4.0', '^0.3.0'), false);
	assert.equal(satisfies('1.4.0', '~1.4.0'), true);
	assert.equal(satisfies('1.5.0', '~1.4.0'), false);
	assert.equal(satisfies('1.4.0', '1.x'), true);
	assert.equal(satisfies('1.4.0', '>=1.0.0 <1.4.0'), false);
	assert.equal(satisfies('1.4.0', '^0.9.0 || ^1.0.0'), true);
	assert.equal(satisfies('1.4.0', 'workspace:*'), undefined);
});

test('pi loads each declared file and each top-level entry of a declared folder', () => {
	const files = ['index.ts', 'extensions/a.ts', 'extensions/history/index.ts', 'extensions/history/store.ts', 'lib/x.ts'];
	assert.deepEqual(extensionEntryPoints({ pi: { extensions: ['./extensions'] } }, files), ['extensions/a.ts', 'extensions/history/']);
	assert.deepEqual(extensionEntryPoints({ pi: { extensions: ['./index.ts'] } }, files), ['index.ts']);
	assert.deepEqual(extensionEntryPoints({}, files), []);
});

test('the tarball lister reads plain, prefixed and long names', () => {
	const block = (name, size, type = '0', prefix = '') => {
		const header = Buffer.alloc(512);
		header.write(name, 0);
		header.write(size.toString(8).padStart(11, '0'), 124);
		header.write(type, 156);
		header.write(prefix, 345);
		return header;
	};
	const pad = body => Buffer.concat([body, Buffer.alloc((512 - body.length % 512) % 512)]);
	const longPath = `package/${'deep/'.repeat(30)}file.ts`;
	const pax = Buffer.from(`${String(`path=${longPath}\n`.length + 4)} path=${longPath}\n`);
	const tar = Buffer.concat([
		block('package/package.json', 2), pad(Buffer.from('{}')),
		block('extensions/a.ts', 0, '0', 'package'),
		block('PaxHeader', pax.length, 'x'), pad(pax),
		block('truncated', 0),
		block('package/dir', 0, '5'),
		Buffer.alloc(1024),
	]);
	assert.deepEqual(tarFiles(gzipSync(tar)), ['package.json', 'extensions/a.ts', `${'deep/'.repeat(30)}file.ts`]);
});
