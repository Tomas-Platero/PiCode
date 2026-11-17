/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A session on a branch starts with its transcript already on disk, named after the branch, so it is
 * in the Sessions list before its first message.
 */

import assert from 'assert';
import * as fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { writeNamedTranscript, uuidv7 } = await import('../src/session-transcript');

test('ids are time-ordered uuid v7', () => {
	const id = uuidv7(Date.UTC(2026, 10, 16));
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.ok(uuidv7(Date.UTC(2026, 10, 16)) < uuidv7(Date.UTC(2026, 10, 17)));
});

test('the transcript has pi\'s header and the branch as the session name', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-tr-'));
	try {
		const sessionDir = path.join(dir, 'sessions', '--D--code--app--');
		const written = writeNamedTranscript(sessionDir, 'D:\code\.picode-worktrees\app\feat-x', 'feat/x', Date.UTC(2026, 10, 16, 10, 0, 0));
		assert.strictEqual(path.dirname(written.file), sessionDir);
		assert.ok(path.basename(written.file).endsWith(`_${written.id}.jsonl`));
		const lines = fs.readFileSync(written.file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
		assert.deepStrictEqual(lines[0], { type: 'session', version: 3, id: written.id, timestamp: '2026-11-16T10:00:00.000Z', cwd: 'D:\code\.picode-worktrees\app\feat-x' });
		assert.strictEqual(lines[1].type, 'session_info');
		assert.strictEqual(lines[1].name, 'feat/x');
		assert.strictEqual(lines[1].parentId, null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
