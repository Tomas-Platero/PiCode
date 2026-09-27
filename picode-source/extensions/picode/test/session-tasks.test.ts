/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extractTasks, type TaskRow } from '../src/session-tasks.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const todoResult = (state: unknown) => ({
	type: 'message',
	message: { role: 'toolResult', toolName: 'todo', details: { gentleTodo: state } },
});

test('a session with no todo results has no task list', () => {
	assert.equal(extractTasks([
		{ type: 'message', message: { role: 'user', content: 'hi' } },
		{ type: 'model_change', provider: 'nan', modelId: 'x' },
	]), undefined);
});

test('the last snapshot wins', () => {
	const rows = extractTasks([
		todoResult({ tasks: [{ id: 1, title: 'old', status: 'in_progress' }] }),
		todoResult({ tasks: [{ id: 1, title: 'new', status: 'done' }] }),
	]);
	assert.deepEqual(rows, [{ title: 'new', status: 'done' }]);
});

test('malformed snapshots and entries are skipped, not invented', () => {
	assert.equal(extractTasks([
		{ type: 'message', message: { role: 'toolResult', toolName: 'todo', details: 'junk' } },
		todoResult({ tasks: 'nope' }),
		todoResult(undefined),
	]), undefined);
});

test('titleless tasks are dropped, statuses default to pending, notes survive', () => {
	const rows = extractTasks([
		todoResult({ tasks: [
			{ title: '', status: 'done' },
			{ title: 'a' },
			{ title: 'b', status: 'done', note: 'shipped' },
		] }),
	]);
	assert.deepEqual(rows, [
		{ title: 'a', status: 'pending' },
		{ title: 'b', status: 'done', note: 'shipped' },
	]);
});

test('in-progress tasks lead, the rest keeps snapshot order', () => {
	const rows = extractTasks([
		todoResult({ tasks: [
			{ id: 1, title: 'first done', status: 'done' },
			{ id: 2, title: 'working', status: 'in_progress', note: 'writing tests' },
			{ id: 3, title: 'later', status: 'pending' },
		] }),
	]);
	assert.deepEqual(rows?.map(row => row.title), ['working', 'first done', 'later']);
});
