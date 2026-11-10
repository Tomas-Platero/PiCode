/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * When a saved conversation has to ask about its folder.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { lostFolderOf } from '../src/session-folder.ts';

test('a folder that is gone is reported', () => {
	assert.equal(lostFolderOf('/old/project', '/new/project', () => false), '/old/project');
});

test('a folder that is still there asks nothing', () => {
	assert.equal(lostFolderOf('/old/project', '/new/project', () => true), undefined);
});

test('the folder the chat runs in anyway asks nothing, even if the check says gone', () => {
	assert.equal(lostFolderOf('/same/project', '/same/project', () => false), undefined);
});

test('a header without a folder asks nothing', () => {
	assert.equal(lostFolderOf(undefined, '/new/project', () => false), undefined);
	assert.equal(lostFolderOf('', '/new/project', () => false), undefined);
	assert.equal(lostFolderOf(42, '/new/project', () => false), undefined);
});

test('the real disk decides by default', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'picode-lost-'));
	try {
		assert.equal(lostFolderOf(dir, '/elsewhere'), undefined);
		rmSync(dir, { recursive: true });
		assert.equal(lostFolderOf(dir, '/elsewhere'), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
