/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The ledger of a turn's changed files, run on its own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why
 * `chat-edits.ts` carries no local imports and no `vscode`: which tools are ledgered, what
 * the events name and how the lines are counted are the parts worth exercising, and none
 * of them needs an editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	absolutePathOfBeforeUriPath,
	beforeUriPathOf,
	clearTurnEdits,
	countLineChanges,
	isFileMutationTool,
	mutatedPathOf,
	recordAfter,
	snapshotBefore,
	turnFileEdits,
	whenEditsSettled,
	beforeContentFor,
} from '../src/chat-edits.ts';

test('a snapshot URI path round-trips any absolute path', () => {
	// Windows drives and backslashes included: the URI carries the whole path, encoded.
	const windows = 'D:\\repos\\my folder\\app.ts';
	assert.strictEqual(absolutePathOfBeforeUriPath(beforeUriPathOf(windows)), windows);
	const posix = '/home/owner/my folder/app.ts';
	assert.strictEqual(absolutePathOfBeforeUriPath(beforeUriPathOf(posix)), posix);
});

test('only the structured file-mutation tools are ledgered', () => {
	assert.strictEqual(isFileMutationTool('edit'), true);
	assert.strictEqual(isFileMutationTool('write'), true);
	assert.strictEqual(isFileMutationTool('bash'), false);
	assert.strictEqual(isFileMutationTool('read'), false);
	assert.strictEqual(isFileMutationTool(undefined), false);
	assert.strictEqual(isFileMutationTool(42), false);
});

test('the path a mutating tool names is read from its arguments', () => {
	assert.strictEqual(mutatedPathOf({ path: 'src/app.ts', edits: [] }), 'src/app.ts');
	assert.strictEqual(mutatedPathOf({ path: 'out.txt', content: 'x' }), 'out.txt');
	assert.strictEqual(mutatedPathOf({ edits: [] }), undefined);
	assert.strictEqual(mutatedPathOf({ path: '' }), undefined);
	assert.strictEqual(mutatedPathOf({ path: 42 }), undefined);
	assert.strictEqual(mutatedPathOf(null), undefined);
	assert.strictEqual(mutatedPathOf('edit src/app.ts'), undefined);
});

test('an untouched file counts as no change', () => {
	assert.deepStrictEqual(countLineChanges('a\nb\nc\n', 'a\nb\nc\n'), [0, 0]);
	assert.deepStrictEqual(countLineChanges('', ''), [0, 0]);
});

test('added and removed lines are counted by a real diff, not by size', () => {
	// One line replaced by another: +1 and −1, even though both sides have three lines.
	assert.deepStrictEqual(countLineChanges('a\nb\nc\n', 'a\nx\nc\n'), [1, 1]);
	// Lines appended: added only.
	assert.deepStrictEqual(countLineChanges('a\n', 'a\nb\nc\n'), [2, 0]);
	// Lines removed: removed only.
	assert.deepStrictEqual(countLineChanges('a\nb\nc\n', 'a\n'), [0, 2]);
	// A line inserted in the middle shifts nothing else.
	assert.deepStrictEqual(countLineChanges('a\nc\n', 'a\nb\nc\n'), [1, 0]);
});

test('a wholesale rewrite reads as everything changed', () => {
	assert.deepStrictEqual(countLineChanges('one\ntwo\nthree\n', 'un\ndos\ntres\n'), [3, 3]);
});

test('a file edited in one turn keeps its first before and last after', async () => {
	clearTurnEdits();
	const reads: Record<string, string | undefined> = { '/w/f.ts': 'v1\n' };
	const read = async (p: string) => reads[p];
	snapshotBefore('/w/f.ts', read);
	// The snapshot read lands before the tool writes (a microtask, always earlier than
	// a tool whose execute awaits), so the write is simulated after it settles.
	await whenEditsSettled();
	// The file is written by the tool after the snapshot.
	reads['/w/f.ts'] = 'v2\n';
	recordAfter('/w/f.ts', read);
	await whenEditsSettled();
	const edits = turnFileEdits();
	assert.strictEqual(edits.length, 1);
	assert.strictEqual(edits[0].path, '/w/f.ts');
	assert.strictEqual(edits[0].before, 'v1\n');
	assert.strictEqual(edits[0].after, 'v2\n');
	assert.strictEqual(edits[0].isNew, false);
	assert.deepStrictEqual([edits[0].added, edits[0].removed], [1, 1]);

	// A second call on the same file must not replace the first snapshot.
	snapshotBefore('/w/f.ts', read);
	recordAfter('/w/f.ts', read);
	await whenEditsSettled();
	assert.strictEqual(turnFileEdits()[0].before, 'v1\n');
	assert.strictEqual(turnFileEdits()[0].after, 'v2\n');
});

test('a file the tool creates has no before and counts as all added', async () => {
	clearTurnEdits();
	const reads: Record<string, string | undefined> = { '/w/new.ts': undefined };
	const read = async (p: string) => reads[p];
	snapshotBefore('/w/new.ts', read);
	await whenEditsSettled();
	reads['/w/new.ts'] = 'line one\nline two\n';
	recordAfter('/w/new.ts', read);
	await whenEditsSettled();
	const [entry] = turnFileEdits();
	assert.strictEqual(entry.isNew, true);
	assert.strictEqual(entry.before, undefined);
	assert.strictEqual(entry.added, 2);
	assert.strictEqual(entry.removed, 0);
	assert.strictEqual(beforeContentFor('/w/new.ts'), undefined);
});

test('a failed read never invents a change', async () => {
	clearTurnEdits();
	const read = async (_p: string) => { throw new Error('EACCES'); };
	snapshotBefore('/w/locked.ts', read);
	recordAfter('/w/locked.ts', read);
	await whenEditsSettled();
	assert.strictEqual(turnFileEdits().length, 0);
});

test('the snapshot store stays bounded without losing the ledger', async () => {
	clearTurnEdits();
	const reads = new Map<string, string>();
	for (let i = 0; i < 70; i++) {
		const p = `/w/f${i}.ts`;
		// The file exists before its tool runs — that is what the snapshot reads.
		reads.set(p, `initial ${i}\n`);
		snapshotBefore(p, async q => reads.get(q));
		await whenEditsSettled();
		reads.set(p, `content ${i}\n`);
		recordAfter(p, async q => reads.get(q));
	}
	await whenEditsSettled();
	const edits = turnFileEdits();
	assert.strictEqual(edits.length, 70);
	// The ledger survives at full size; only the heavy "before" text of the oldest gives way.
	assert.strictEqual(beforeContentFor('/w/f0.ts'), undefined);
	assert.notStrictEqual(beforeContentFor('/w/f69.ts'), undefined);
});

test('the before-scheme provider can still serve a kept snapshot', async () => {
	clearTurnEdits();
	const reads: Record<string, string | undefined> = { '/w/keep.ts': 'old\n' };
	const read = async (p: string) => reads[p];
	snapshotBefore('/w/keep.ts', read);
	await whenEditsSettled();
	reads['/w/keep.ts'] = 'new\n';
	recordAfter('/w/keep.ts', read);
	await whenEditsSettled();
	assert.strictEqual(beforeContentFor('/w/keep.ts'), 'old\n');
});

import { undoEdits, rememberTurnForUndo, undoableTurn, forgetUndoableTurn, type TurnFileEdit, type UndoIo } from '../src/chat-edits.ts';

function fakeDisk(files: Record<string, string>): UndoIo & { files: Record<string, string> } {
	return {
		files,
		read: async p => files[p],
		write: async (p, c) => { files[p] = c; },
		remove: async p => { delete files[p]; },
	};
}

test('undo puts back the snapshot and removes what the turn created', async () => {
	const disk = fakeDisk({ '/a': 'new a', '/b': 'created' });
	const edits: TurnFileEdit[] = [
		{ path: '/a', before: 'old a', after: 'new a', added: 1, removed: 1, isNew: false },
		{ path: '/b', after: 'created', added: 1, removed: 0, isNew: true },
	];
	const results = await undoEdits(edits, disk);
	assert.deepStrictEqual(results.map(r => r.outcome), ['restored', 'removed']);
	assert.deepStrictEqual(disk.files, { '/a': 'old a' });
});

test('undo leaves a file alone when it changed after the turn', async () => {
	const disk = fakeDisk({ '/a': 'owner edited this' });
	const results = await undoEdits([{ path: '/a', before: 'old', after: 'new', added: 1, removed: 1, isNew: false }], disk);
	assert.strictEqual(results[0].outcome, 'changed-since');
	assert.strictEqual(disk.files['/a'], 'owner edited this');
});

test('undo reports a failing write instead of throwing', async () => {
	const disk = fakeDisk({ '/a': 'new' });
	disk.write = async () => { throw new Error('read-only'); };
	const results = await undoEdits([{ path: '/a', before: 'old', after: 'new', added: 1, removed: 1, isNew: false }], disk);
	assert.strictEqual(results[0].outcome, 'failed');
});

test('only the last turns stay undoable, and an undone turn is forgotten', () => {
	const keys = Array.from({ length: 7 }, () => rememberTurnForUndo([]));
	assert.strictEqual(undoableTurn(keys[0]), undefined);
	assert.notStrictEqual(undoableTurn(keys[6]), undefined);
	forgetUndoableTurn(keys[6]);
	assert.strictEqual(undoableTurn(keys[6]), undefined);
});
