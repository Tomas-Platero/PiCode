/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Tasks block's rows.
 *
 * `tasks-rows.ts` is pure (no `vscode`), so `node --test` runs it directly: the list it builds
 * is the shape the pill already answers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BackgroundJobStatus } from '../src/status-contract.ts';
import { elapsedLabel, taskBoard, taskDetail, taskState, taskTitle } from '../src/tasks-rows.ts';

const job = (jobNumber: string, label?: string): BackgroundJobStatus =>
	({ jobNumber, ...(label === undefined ? {} : { label }), startedAt: 1_000 });

test('every open job is a running row, in the order the tracker gave them', () => {
	const board = taskBoard([job('1', 'lint'), job('2')]);
	assert.deepEqual(board.running.map(row => taskTitle(row)), ['lint', 'Background job 2']);
	assert.equal(board.total, 2);
});

test('no jobs is an empty board, not an error', () => {
	const board = taskBoard([]);
	assert.equal(board.total, 0);
	assert.equal(board.running.length, 0);
});

test('the title is the label, or the job number when it has none', () => {
	assert.equal(taskTitle({ kind: 'job', job: job('2', 'web lint') }), 'web lint');
	assert.equal(taskTitle({ kind: 'job', job: job('2') }), 'Background job 2');
});

test('a job is running by definition and counts time', () => {
	assert.equal(taskState({ kind: 'job', job: job('1') }), 'running');
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
