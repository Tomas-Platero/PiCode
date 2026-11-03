/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `+N −M` under Changes: git's numstat summed, binary files skipped, and new files counted
 * line by line the way git would.
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

const { countLines, parseNumstat } = await import('../src/diff-stat');

test('numstat lines add up', () => {
	assert.deepStrictEqual(parseNumstat('10\t2\tsrc/a.ts\n3\t0\tdocs/b.md\n'), { added: 13, removed: 2 });
});

test('binary files and blank lines carry no counts', () => {
	assert.deepStrictEqual(parseNumstat('-\t-\timage.png\n\n4\t1\ta.ts\n'), { added: 4, removed: 1 });
});

test('no changes is zero', () => {
	assert.deepStrictEqual(parseNumstat(''), { added: 0, removed: 0 });
});

test('a new file counts its last line even without a newline', () => {
	assert.strictEqual(countLines('a\nb\n'), 2);
	assert.strictEqual(countLines('a\nb'), 2);
	assert.strictEqual(countLines(''), 0);
});

test('a binary new file counts nothing', () => {
	assert.strictEqual(countLines('PNG\0\0data'), 0);
});
