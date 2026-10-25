/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Tasks block's rows.
 *
 * `tasks-rows.ts` is pure (no `vscode`), so `node --test` runs it directly: the two lists it
 * merges are the shapes the pill and the durable reader already answer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DurableWorkRow } from '../src/durable-tasks.ts';
import type { BackgroundJobStatus } from '../src/status-contract.ts';
import { elapsedLabel, newestLine, taskBoard, taskDetail, taskState, taskTitle } from '../src/tasks-rows.ts';

const job = (jobNumber: string, label?: string): BackgroundJobStatus =>
	({ jobNumber, ...(label === undefined ? {} : { label }), startedAt: 1_000 });

const work = (conversationId: number, inFlight: boolean | undefined, taskId?: string, entries = 4, newest = 'entry 9 (pi.assistant)'): DurableWorkRow =>
	({ conversationId, ...(taskId === undefined ? {} : { taskId }), inFlight, entries, ...(newest === '' ? {} : { newest }) });

test('every open job leads; tasks split by whether a run is in flight', () => {
	const board = taskBoard([job('1', 'lint')], [work(10, true, 't1'), work(11, false, 't2'), work(12, undefined)]);
	assert.deepEqual(board.running.map(row => taskTitle(row)), ['lint', 'Task t1']);
	// A task whose state could not be read is not guessed into either group: it waits.
	assert.deepEqual(board.idle.map(row => taskTitle(row)), ['Task t2', 'Conversation 12']);
	assert.equal(board.total, 4);
});

test('a daemon that did not answer contributes no task, and does not erase the jobs', () => {
	const board = taskBoard([job('7')], undefined);
	assert.equal(board.total, 1);
	assert.equal(taskTitle(board.running[0]), 'Background job 7');
	assert.equal(board.idle.length, 0);
});

test('the title is the label, the task id, or the conversation it lives in', () => {
	assert.equal(taskTitle({ kind: 'job', job: job('2', 'web lint') }), 'web lint');
	assert.equal(taskTitle({ kind: 'job', job: job('2') }), 'Background job 2');
	assert.equal(taskTitle({ kind: 'task', work: work(4, false, 'proof#3') }), 'Task proof#3');
	assert.equal(taskTitle({ kind: 'task', work: work(4, false) }), 'Conversation 4');
});

test('the state word never guesses: unknown stays unknown', () => {
	assert.equal(taskState({ kind: 'job', job: job('1') }), 'running');
	assert.equal(taskState({ kind: 'task', work: work(1, true) }), 'running');
	assert.equal(taskState({ kind: 'task', work: work(1, false) }), 'idle');
	assert.equal(taskState({ kind: 'task', work: work(1, undefined) }), 'state unavailable');
});

test('a job counts time and a task counts entries', () => {
	assert.equal(taskDetail({ kind: 'task', work: work(1, true, 't', 1) }, 0), 'running · 1 entry');
	assert.equal(taskDetail({ kind: 'task', work: work(1, true, 't', 8) }, 0), 'running · 8 entries');
	assert.equal(taskDetail({ kind: 'job', job: job('1') }, 1_000 + 90_000), 'running · 1m');
});

test('elapsed time is the shortest true wording', () => {
	assert.equal(elapsedLabel(0, 5_000), '5s');
	assert.equal(elapsedLabel(0, 59_000), '59s');
	assert.equal(elapsedLabel(0, 60_000), '1m');
	assert.equal(elapsedLabel(0, 3_600_000), '1h 0m');
	assert.equal(elapsedLabel(0, 90_000_000), '1d 1h');
	assert.equal(elapsedLabel(5_000, 1_000), '0s');
});

test('the newest entry is one line, shortened and not rewritten', () => {
	assert.equal(newestLine(undefined), undefined);
	assert.equal(newestLine('   '), undefined);
	assert.equal(newestLine('entry 9 (pi.assistant)\nmore'), 'entry 9 (pi.assistant)');
	assert.equal(newestLine('x'.repeat(80), 10), 'xxxxxxxxx…');
	assert.equal(newestLine('short'), 'short');
});
