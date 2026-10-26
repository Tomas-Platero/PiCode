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
import type { AgentTaskRow } from '../src/gentle-agents-store.ts';
import type { BackgroundJobStatus } from '../src/status-contract.ts';
import { FINISHED_AGENTS_SHOWN, elapsedLabel, taskBoard, taskDetail, taskState, taskTitle } from '../src/tasks-rows.ts';

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

const agent = (id: string, status: AgentTaskRow['status'], extra: Partial<AgentTaskRow> = {}): AgentTaskRow =>
	({ id, agent: 'review-risk', label: 'check the diff', status, startedAt: 1_000, endedAt: undefined, lastStep: 'read', turns: 1, toolCalls: 2, error: undefined, ...extra });

test('agents still going are running rows, after the jobs; the ones that ended are listed apart', () => {
	const board = taskBoard([job('1', 'lint')], [agent('a', 'running'), agent('b', 'queued'), agent('c', 'waiting'), agent('d', 'completed', { endedAt: 4_000 }), agent('e', 'failed', { endedAt: 3_000 })]);
	assert.deepEqual(board.running.map(row => row.kind === 'job' ? row.job.jobNumber : row.agent.id), ['1', 'a', 'b', 'c']);
	assert.deepEqual(board.finished.map(row => row.kind === 'agent' ? row.agent.id : ''), ['d', 'e']);
	assert.equal(board.total, 6);
});

test('finished agents are capped, newest first as gentle-pi ordered them', () => {
	const many = Array.from({ length: FINISHED_AGENTS_SHOWN + 3 }, (_, index) => agent(String(index), 'completed'));
	const board = taskBoard([], many);
	assert.equal(board.finished.length, FINISHED_AGENTS_SHOWN);
	assert.equal(board.finished[0]?.kind === 'agent' && board.finished[0].agent.id, '0');
});

test('an agent is titled by its label, then its role, then its id', () => {
	assert.equal(taskTitle({ kind: 'agent', agent: agent('1', 'running') }), 'check the diff');
	assert.equal(taskTitle({ kind: 'agent', agent: agent('1', 'running', { label: '' }) }), 'review-risk');
	assert.equal(taskTitle({ kind: 'agent', agent: agent('7', 'running', { label: '', agent: '' }) }), 'Agent 7');
});

test('an agent says its state in words a person uses', () => {
	const state = (status: AgentTaskRow['status']) => taskState({ kind: 'agent', agent: agent('1', status) });
	assert.deepEqual((["queued", "running", "waiting", "completed", "failed", "cancelled", "timed_out"] as const).map(state), ['queued', 'running', 'waiting for you', 'done', 'failed', 'stopped', 'timed out']);
});

test('an agent counts its role and its time: running until now, finished until it ended', () => {
	assert.equal(taskDetail({ kind: 'agent', agent: agent('1', 'running') }, 1_000 + 90_000), 'running · review-risk · 1m');
	assert.equal(taskDetail({ kind: 'agent', agent: agent('1', 'completed', { endedAt: 1_000 + 5_000 }) }, 1_000 + 90_000_000), 'done · review-risk · 5s');
	assert.equal(taskDetail({ kind: 'agent', agent: agent('1', 'running', { label: '', startedAt: undefined }) }, 0), 'running');
});
