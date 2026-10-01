/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The session backup's key rules, run on their own.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why the key
 * builders live beside pi's own slug in `sessions-provider.ts`, which carries no `vscode`.
 *
 * The rule under test is the one a restore once broke: on Windows the same project folder
 * can be spelled `C:\demo` by one session and `c:\demo` by another — NTFS preserves the
 * case it is given but matches without it. The transcript's own spelling of the cwd, the
 * on-disk folder's, and the remembered state's must all fold to **one** key, or the same
 * file is backed up twice and restored as two projects.
 */

import assert from 'assert';
import { test } from 'node:test';
import { listSessionBackupFiles, sessionKeyFromTranscript, type BackupFs } from '../src/sessions-provider.ts';

/** Case is identity where the file system keeps it, and noise where it folds it. */
const FOLDS_CASE = process.platform === 'win32';

const SESSION_NAME = '2026-09-28T09-00-00.000Z_abc.jsonl';

/** A one-line transcript whose session header spells the cwd as given. */
const transcriptWith = (cwd: string): string =>
	`{"type":"session","version":3,"id":"abc","timestamp":"2026-09-28T09:00:00.000Z","cwd":"${cwd.replace(/\\/g, '\\\\')}"}`;

/** A sessions tree holding one project folder, as the editor's spelling created it. */
const fsWithProjectDir = (slug: string): BackupFs => {
	const files: Record<string, string> = {
		[`/sessions/${slug}/${SESSION_NAME}`]: transcriptWith('c:\\demo'),
	};
	// Windows' path.join answers with backslashes; the fake tree is spelled with slashes.
	const norm = (p: string): string => p.replaceAll('\\', '/');
	return {
		read: file => Buffer.from(files[norm(file)] ?? ''),
		write: () => undefined,
		exists: file => norm(file) in files,
		size: file => (files[norm(file)] ?? '').length,
		mtime: () => 1000,
		isDirectory: dir => norm(dir) === `/sessions/${slug}`,
		list: dir => {
			const base = norm(dir);
			return base === '/sessions'
				? [slug]
				: Object.keys(files).filter(file => file.startsWith(`${base}/`)).map(file => file.slice(base.length + 1));
		},
	};
};

test('a drive letter spelled in another case is the same backup key', () => {
	const upper = sessionKeyFromTranscript(transcriptWith('C:\\demo'));
	const lower = sessionKeyFromTranscript(transcriptWith('c:\\demo'));
	assert.ok(upper !== undefined && lower !== undefined);
	if (FOLDS_CASE) {
		assert.strictEqual(upper, lower);
	} else {
		assert.notStrictEqual(upper, lower);
	}
});

test('the listing spells a project key exactly as the transcript does', () => {
	// The folder on disk was created from one spelling; the transcript's header spells
	// the drive the way another session saw it. Both must land on one key where the
	// file system folds case.
	const listed = listSessionBackupFiles('/sessions', fsWithProjectDir('--C--demo--'));
	assert.strictEqual(listed.length, 1);
	const fromListing = listed[0].key;
	const fromTranscript = sessionKeyFromTranscript(transcriptWith('c:\\demo'))!;
	if (FOLDS_CASE) {
		assert.strictEqual(fromListing, fromTranscript);
	} else {
		assert.notStrictEqual(fromListing, fromTranscript);
	}
});
