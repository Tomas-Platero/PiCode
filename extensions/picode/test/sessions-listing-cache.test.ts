/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Listing sessions without reading whole transcripts: a long transcript answers from its two ends
 * and says the same as a full read, and a restart starts from what the last window worked out.
 */

import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { listSessionFiles, restoreListingCache, serializeListingCache, takeListingCacheChange, type SessionsFs } from '../src/sessions-provider.ts';

const line = (role: string, text: string) => JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } });
const header = JSON.stringify({ type: 'session', cwd: 'C:/work', parentSession: 'parent.jsonl' });

function fakeFs(transcripts: Record<string, string>, ends?: SessionsFs['readEnds']) {
	const reads: string[] = [];
	const fs: SessionsFs = {
		read: file => {
			reads.push(file);
			return transcripts[file] ?? '';
		},
		list: () => Object.keys(transcripts),
		mtime: () => 1000,
		...(ends === undefined ? {} : { readEnds: ends }),
	};
	return { fs, reads };
}

test('a long transcript is described from its two ends, without a full read', () => {
	const file = path.join('ends-only', 'a.jsonl');
	const { fs, reads } = fakeFs({ [file]: 'unused' }, () => ({ head: `${header}\n${line('user', 'first words')}\n{"type":"mess`, tail: `sage"}\n${line('assistant', 'last words')}\n` }));
	const [row] = listSessionFiles('ends-only', fs);
	assert.strictEqual(row.label, 'first words');
	assert.strictEqual(row.lastRole, 'assistant');
	assert.strictEqual(row.parent, 'parent.jsonl');
	assert.deepStrictEqual(reads, []);
});

test('when an end cuts the answer in two, the whole transcript is read', () => {
	const file = path.join('cut', 'a.jsonl');
	const whole = `${header}\n${line('user', 'an opening cut by the head')}\n${line('assistant', 'done')}\n`;
	const { fs, reads } = fakeFs({ [file]: whole }, () => ({ head: `${header}\n{"type":"message","mess`, tail: `${line('assistant', 'done')}\n` }));
	const [row] = listSessionFiles('cut', fs);
	assert.strictEqual(row.label, 'an opening cut by the head');
	assert.strictEqual(row.lastRole, 'assistant');
	assert.deepStrictEqual(reads, [file]);
});

test('a real long transcript reads the same from its ends as a short one does whole', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'picode-sessions-'));
	try {
		const filler = Array.from({ length: 4000 }, (_, index) => line(index % 2 ? 'assistant' : 'user', `filler ${index} ${'x'.repeat(100)}`)).join('\n');
		writeFileSync(path.join(dir, 'long.jsonl'), `${header}\n${line('user', 'ñandú opening')}\n${filler}\n${line('toolResult', 'closing')}\n`);
		writeFileSync(path.join(dir, 'short.jsonl'), `${header}\n${line('user', 'ñandú opening')}\n${line('toolResult', 'closing')}\n`);
		const rows = listSessionFiles(dir);
		assert.strictEqual(rows.length, 2);
		for (const row of rows) {
			assert.strictEqual(row.label, 'ñandú opening');
			assert.strictEqual(row.lastRole, 'toolResult');
			assert.strictEqual(row.parent, 'parent.jsonl');
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a restart lists from the saved cache without reading anything', () => {
	const file = path.join('restart', 'a.jsonl');
	const first = fakeFs({ [file]: `${header}\n${line('user', 'kept label')}\n` });
	listSessionFiles('restart', first.fs);
	assert.strictEqual(takeListingCacheChange(), true);
	assert.strictEqual(takeListingCacheChange(), false);
	const saved = serializeListingCache();

	listSessionFiles('elsewhere', fakeFs({}).fs); // forgets it, as a new window starts empty
	takeListingCacheChange();
	restoreListingCache(saved);
	const second = fakeFs({ [file]: 'not read' });
	const [row] = listSessionFiles('restart', second.fs);
	assert.strictEqual(row.label, 'kept label');
	assert.deepStrictEqual(second.reads, []);
});

test('a transcript that moved since it was saved is read again', () => {
	const file = path.join('moved', 'a.jsonl');
	const first = fakeFs({ [file]: `${line('user', 'old')}\n` });
	listSessionFiles('moved', first.fs);
	const saved = serializeListingCache();
	listSessionFiles('elsewhere', fakeFs({}).fs);
	restoreListingCache(saved);
	const moved = fakeFs({ [file]: `${line('user', 'new')}\n` });
	moved.fs.mtime = () => 2000;
	assert.strictEqual(listSessionFiles('moved', moved.fs)[0].label, 'new');
});

test('a damaged or foreign cache is ignored, not trusted', () => {
	const file = path.join('damaged', 'a.jsonl');
	for (const text of ['not json', '{"version":999,"entries":[]}', JSON.stringify({ version: 1, entries: [[file, { mtime: 1000 }], [7, null]] })]) {
		listSessionFiles('elsewhere', fakeFs({}).fs);
		restoreListingCache(text);
		const { fs } = fakeFs({ [file]: `${line('user', 'from the file')}\n` });
		assert.strictEqual(listSessionFiles('damaged', fs)[0].label, 'from the file');
	}
});
