/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What tells the Sessions panel to look again, run on its own.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coarseMinute, transcriptDigest, type DigestFs } from '../src/sessions-digest.ts';

const tree = (entries: Record<string, readonly string[]>): DigestFs => ({
	readdir: dir => {
		const key = dir.replace(/\\/g, '/').replace(/^.*\/sessions\/?/, '');
		return entries[key] ?? [];
	},
});

test('the digest changes when a transcript is added or removed', () => {
	const one = transcriptDigest('/p/sessions', tree({ '': ['a'], a: ['1.jsonl'] }));
	const two = transcriptDigest('/p/sessions', tree({ '': ['a'], a: ['1.jsonl', '2.jsonl'] }));
	const gone = transcriptDigest('/p/sessions', tree({ '': ['a'], a: [] }));
	assert.notEqual(one, two);
	assert.notEqual(one, gone);
});

test('the digest does not change when a transcript only grows: only names count', () => {
	const entries = { '': ['a'], a: ['1.jsonl'] };
	assert.equal(transcriptDigest('/p/sessions', tree(entries)), transcriptDigest('/p/sessions', tree(entries)));
});

test('only transcripts count, in any project, in a fixed order', () => {
	const digest = transcriptDigest('/p/sessions', tree({ '': ['b', 'a'], a: ['2.jsonl', 'notes.txt'], b: ['1.jsonl'] }));
	assert.equal(digest, 'a/2.jsonl\nb/1.jsonl');
});

test('a folder that cannot be read is an empty digest, not a failure', () => {
	assert.equal(transcriptDigest('/p/sessions', tree({})), '');
});

test('a moment is rounded down to its minute', () => {
	assert.equal(coarseMinute(0), 0);
	assert.equal(coarseMinute(59_999), 0);
	assert.equal(coarseMinute(60_000), 60_000);
	assert.equal(coarseMinute(125_000), 120_000);
	assert.equal(coarseMinute(1_792_942_333_377), 1_792_942_320_000);
});
