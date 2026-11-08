/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent's own task list, as the Tasks block and the status column draw it.
 *
 * `agent-todo.ts` is pure (no `vscode`), so `node --test` runs it directly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINISHED_LIST_SHOWN_MS, TodoTracker, todoDetail, todoFromResult, todoIcon, todoProgress, type TodoRow } from '../src/agent-todo.ts';

const answer = (tasks: unknown[]) => ({ content: [], details: { gentleTodo: { tasks, nextId: 9, updatedTurn: 1 } } });

test('the list is read from the tool\'s own answer', () => {
	const rows = todoFromResult(answer([
		{ id: 1, title: 'Read the issue', status: 'done' },
		{ id: 2, title: '  Fix the roster check ', status: 'in_progress', note: 'ignored' },
		{ id: 3, title: 'Run the tests', status: 'pending' },
	]));
	assert.deepEqual(rows, [
		{ id: 1, title: 'Read the issue', status: 'done' },
		{ id: 2, title: 'Fix the roster check', status: 'in_progress', note: 'ignored' },
		{ id: 3, title: 'Run the tests', status: 'pending' },
	]);
});

test('an answer that is not a list leaves what was known; an empty list is a cleared one', () => {
	assert.equal(todoFromResult(undefined), undefined);
	assert.equal(todoFromResult({ content: [], details: {} }), undefined);
	assert.equal(todoFromResult({ details: { gentleTodo: { tasks: 'nope' } } }), undefined);
	assert.deepEqual(todoFromResult(answer([])), []);
});

test('a task with no title or an unknown state is not drawn', () => {
	assert.deepEqual(todoFromResult(answer([{ id: 1, title: '', status: 'pending' }, { id: 2, title: 'ok', status: 'later' }, { id: 3, title: 'fine', status: 'blocked' }])),
		[{ id: 3, title: 'fine', status: 'blocked' }]);
});

const row = (status: TodoRow['status'], id = 1): TodoRow => ({ id, title: `task ${id}`, status });

test('the list stays while a task is open, and a few minutes after the last one finished', () => {
	const tracker = new TodoTracker();
	assert.equal(tracker.current(0), undefined);
	tracker.set([row('done', 1), row('in_progress', 2)], 1_000);
	assert.equal(tracker.current(1_000 + 60 * 60 * 1000)?.tasks.length, 2, 'open work is never dropped by the clock');
	tracker.set([row('done', 1), row('dropped', 2)], 2_000);
	assert.equal(tracker.current(2_000 + FINISHED_LIST_SHOWN_MS - 1)?.tasks.length, 2);
	assert.equal(tracker.current(2_000 + FINISHED_LIST_SHOWN_MS), undefined);
});

test('clearing the list takes it away', () => {
	const tracker = new TodoTracker();
	tracker.set([row('pending')], 1);
	tracker.set([], 2);
	assert.equal(tracker.current(3), undefined);
});

test('progress counts what is done out of what still counts', () => {
	assert.equal(todoProgress([row('done', 1), row('done', 2), row('pending', 3), row('dropped', 4)]), '2/3');
	assert.equal(todoProgress([]), '0/0');
});

test('every state has its own icon', () => {
	const icons = (['pending', 'in_progress', 'blocked', 'done', 'dropped'] as const).map(todoIcon);
	assert.equal(new Set(icons).size, 5);
});

test('the step in progress says what is happening right now', () => {
	const step: TodoRow = { id: 1, title: 'Fix', status: 'in_progress' };
	const noted: TodoRow = { ...step, note: 'half way' };
	assert.equal(todoDetail(noted, { working: true, activity: 'read src/app.ts' }), 'read src/app.ts');
	assert.equal(todoDetail(noted, { working: true }), 'half way');
	assert.equal(todoDetail(step, { working: true }), 'Working…');
});

test('a step left in progress with no turn behind it says it is paused, and does not turn', () => {
	const step: TodoRow = { id: 1, title: 'Fix', status: 'in_progress' };
	assert.equal(todoDetail(step, { working: false }), 'Paused');
	assert.equal(todoDetail({ ...step, note: 'half way' }, { working: false }), 'half way');
	assert.equal(todoIcon('in_progress', true), 'loading');
	assert.equal(todoIcon('in_progress', false), 'debug-pause');
});

test('blocked says why; the other states say nothing', () => {
	assert.equal(todoDetail({ id: 1, title: 'x', status: 'blocked' }, {}), 'Blocked');
	assert.equal(todoDetail({ id: 1, title: 'x', status: 'blocked', note: 'needs a key' }, {}), 'needs a key');
	assert.equal(todoDetail({ id: 1, title: 'x', status: 'done', note: 'n' }, { working: true, activity: 'a' }), undefined);
	assert.equal(todoDetail({ id: 1, title: 'x', status: 'pending' }, { working: true, activity: 'a' }), undefined);
});
