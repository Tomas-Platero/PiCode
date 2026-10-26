/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The last window out stops the engine PiCode started, and nothing else. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { leaveEngine, markEngineStarted, takeLease } from '../src/engram-leases.ts';

function withDir(body: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'picode-leases-'));
	try {
		body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('the first window out leaves the engine to the one still open', () => {
	withDir(dir => {
		takeLease(dir, 100);
		takeLease(dir, 200);
		markEngineStarted(dir, 999);
		assert.equal(leaveEngine(dir, 100, () => true), undefined);
		assert.equal(leaveEngine(dir, 200, () => true), 999);
	});
});

test('an engine nobody at PiCode started is never handed back for stopping', () => {
	withDir(dir => {
		takeLease(dir, 100);
		assert.equal(leaveEngine(dir, 100, () => true), undefined);
	});
});

test('a window that crashed does not keep the engine alive for ever', () => {
	withDir(dir => {
		takeLease(dir, 100);
		takeLease(dir, 200);
		markEngineStarted(dir, 999);
		// 100 is gone without leaving; 200 closes and finds nobody else running.
		assert.equal(leaveEngine(dir, 200, pid => pid !== 100), 999);
	});
});

test('two windows closing together ask for the stop only once', () => {
	withDir(dir => {
		takeLease(dir, 100);
		markEngineStarted(dir, 999);
		assert.equal(leaveEngine(dir, 100, () => true), 999);
		assert.equal(leaveEngine(dir, 100, () => true), undefined);
	});
});
