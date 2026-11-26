/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A session started by another app is found by its task mark, and "found" is not "received":
 * pi has the assignment only when a user message follows the mark.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findTaskSession, TASK_ENTRY_TYPE, taskStatus, transcriptEntries } from '../src/agent-bridge-task.ts';

const mark = { taskId: 'OMPM-42', promptHash: 'a'.repeat(64) };
const header = (id: string) => ({ type: 'session', version: 3, id, timestamp: '2026-11-26T10:00:00.000Z', cwd: 'D:\\p' });
const markEntry = (data = mark) => ({ type: 'custom', customType: TASK_ENTRY_TYPE, data, id: 'm1', parentId: null });
const user = { type: 'message', id: 'u1', parentId: 'm1', message: { role: 'user', content: 'Fix the login' } };
const assistant = { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [] } };
const jsonl = (...entries: object[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('a mark followed by a user message means pi received the assignment', () => {
	assert.deepEqual(taskStatus([header('s1'), markEntry(), user], mark), { marked: true, received: true });
});

test('a mark without a user message after it is a session, not a received assignment', () => {
	assert.deepEqual(taskStatus([header('s1'), markEntry()], mark), { marked: true, received: false });
	assert.deepEqual(taskStatus([header('s1'), user, markEntry()], mark), { marked: true, received: false });
});

test('a mark for the same task with another assignment does not count', () => {
	assert.deepEqual(taskStatus([markEntry({ taskId: 'OMPM-42', promptHash: 'b'.repeat(64) }), user], mark), { marked: false, received: false });
});

test('the session name is not the mark: a renamed session is still found', () => {
	const renamed = { type: 'session_info', id: 'i1', parentId: 'a1', name: 'Something else entirely' };
	const files = [{ file: 'one.jsonl' }];
	const found = findTaskSession(files, mark, () => jsonl(header('s1'), markEntry(), user, assistant, renamed));
	assert.deepEqual(found, { sessionId: 's1', received: true });
});

test('a session whose title carries the task id but has no mark is not the task session', () => {
	const titled = { type: 'session_info', id: 'i1', parentId: null, name: 'OMPM-42 · Fix the login' };
	assert.equal(findTaskSession([{ file: 'one.jsonl' }], mark, () => jsonl(header('s1'), titled, user)), undefined);
});

test('a received session wins over one that only carries the mark', () => {
	const texts: Record<string, string> = {
		'marked.jsonl': jsonl(header('only-marked'), markEntry()),
		'received.jsonl': jsonl(header('received'), markEntry(), user),
	};
	const found = findTaskSession([{ file: 'marked.jsonl' }, { file: 'received.jsonl' }], mark, file => texts[file]);
	assert.deepEqual(found, { sessionId: 'received', received: true });
});

test('a marked session without the assignment is reported as not received', () => {
	assert.deepEqual(findTaskSession([{ file: 'x.jsonl' }], mark, () => jsonl(header('s1'), markEntry())), { sessionId: 's1', received: false });
});

test('unreadable files and a torn last line are tolerated', () => {
	const torn = jsonl(header('s1'), markEntry(), user) + '{"type":"message","id":"a1"';
	const found = findTaskSession([{ file: 'gone.jsonl' }, { file: 'torn.jsonl' }], mark, file => file === 'torn.jsonl' ? torn : undefined);
	assert.deepEqual(found, { sessionId: 's1', received: true });
	assert.equal(transcriptEntries(torn).length, 3);
});

test('no files, no session', () => {
	assert.equal(findTaskSession([], mark, () => undefined), undefined);
});

/**
 * The premise the exactly-once guarantee rests on, against pi itself: a mark appended to a new
 * session stays in memory until the first user message, and then reaches disk together with it.
 * A crash between the two therefore leaves no file at all, never a mark without its assignment.
 */
const piSessionManager = new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js', import.meta.url);

test('pi writes the task mark only together with the first user message', { skip: !existsSync(fileURLToPath(piSessionManager)) }, async () => {
	const { SessionManager } = await import(piSessionManager.href) as { SessionManager: { create(cwd: string, dir: string): { appendCustomEntry(type: string, data: unknown): string; appendMessage(message: unknown): string; getSessionFile(): string | undefined; getSessionId(): string } } };
	const dir = mkdtempSync(path.join(tmpdir(), 'picode-bridge-mark-'));
	try {
		const manager = SessionManager.create(dir, dir);
		manager.appendCustomEntry(TASK_ENTRY_TYPE, mark);
		const file = manager.getSessionFile();
		assert.ok(file);
		assert.equal(existsSync(file), false, 'the mark alone must not create the session file');
		manager.appendMessage({ role: 'user', content: 'Fix the login', timestamp: Date.now() });
		assert.equal(existsSync(file), true);
		const found = findTaskSession([{ file }], mark, name => readFileSync(name, 'utf8'));
		assert.deepEqual(found, { sessionId: manager.getSessionId(), received: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
