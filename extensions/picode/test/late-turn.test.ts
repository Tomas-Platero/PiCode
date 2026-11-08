/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What pi does on its own after the chat's turn ended, as one entry for the conversation.
 *
 * The events follow what a real gentle-pi 4.7.0 session did when a background job ended.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LateTurnCollector, lateTurnRequest, type LateTurnEvent } from '../src/late-turn.ts';

const notice = (status: string, exitCode: number | null = 0): LateTurnEvent => ({
	type: 'message_end',
	message: { role: 'custom', customType: 'gentle-jobs.notice', display: true, content: 'text', details: { gentleJobs: { jobId: 'job-1', kind: 'command', label: 'UI job', status, exitCode, outputPath: 'D:/tmp/job-1.log' } } },
});
const say = (delta: string): LateTurnEvent => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
const tool = (toolName: string, args: unknown): LateTurnEvent => ({ type: 'tool_execution_start', toolName, args });

function run(collector: LateTurnCollector, events: readonly LateTurnEvent[], chatTurnOpen = false) {
	return events.map(event => collector.accept(event, chatTurnOpen)).find(turn => turn !== undefined);
}

test('a job that ends after the turn becomes one entry: what set it off and what pi said', () => {
	const turn = run(new LateTurnCollector(), [notice('exited'), { type: 'agent_start' }, say('OK, the job '), say('finished.'), { type: 'message_end', message: { role: 'assistant' } }, { type: 'agent_settled' }]);
	assert.deepEqual(turn, { request: 'Background job finished: UI job', answer: 'OK, the job finished.' });
});

test('the steps pi took are listed in the order they happened', () => {
	const turn = run(new LateTurnCollector(), [notice('exited'), { type: 'agent_start' }, say('Reading.'), tool('read', { path: 'a.log' }), say('Done.'), { type: 'agent_settled' }]);
	const answer = turn?.answer ?? '';
	assert.ok(answer.indexOf('Reading.') < answer.indexOf('a.log'), answer);
	assert.ok(answer.indexOf('a.log') < answer.indexOf('Done.'), answer);
	assert.match(answer, /^Reading\.\n\n- /);
});

test('a turn the chat has open is never collected: that answer already shows it', () => {
	const collector = new LateTurnCollector();
	assert.equal(run(collector, [notice('exited'), { type: 'agent_start' }, say('hello'), tool('read', {}), { type: 'agent_settled' }], true), undefined);
	assert.equal(collector.running, false);
});

test('a turn that said and did nothing leaves no entry', () => {
	assert.equal(run(new LateTurnCollector(), [notice('exited'), { type: 'agent_start' }, { type: 'agent_settled' }]), undefined);
});

test('one turn does not leak into the next', () => {
	const collector = new LateTurnCollector();
	run(collector, [notice('exited'), { type: 'agent_start' }, say('first'), { type: 'agent_settled' }]);
	assert.deepEqual(run(collector, [{ type: 'agent_start' }, say('second'), { type: 'agent_settled' }]), { request: 'The agent continued on its own', answer: 'second' });
});

test('it knows when a late turn is running and what it is doing', () => {
	const collector = new LateTurnCollector();
	run(collector, [{ type: 'agent_start' }, tool('bash', { command: 'npm test' })]);
	assert.equal(collector.running, true);
	assert.match(collector.activity ?? '', /npm test/);
	run(collector, [{ type: 'agent_settled' }]);
	assert.equal(collector.running, false);
	assert.equal(collector.activity, undefined);
});

test('the sentence says how the job ended', () => {
	const job = { key: 'k', label: 'UI job', running: false };
	assert.equal(lateTurnRequest({ ...job, outcome: 'finished' }), 'Background job finished: UI job');
	assert.equal(lateTurnRequest({ ...job, outcome: 'failed' }), 'Background job failed: UI job');
	assert.equal(lateTurnRequest({ ...job, outcome: 'stopped' }), 'Background job stopped: UI job');
	assert.equal(lateTurnRequest({ ...job, running: true, outcome: 'running' }), 'Background job update: UI job');
	assert.equal(lateTurnRequest({ key: 'k', running: false, outcome: 'finished' }), 'Background job finished: Background job');
	assert.equal(lateTurnRequest(undefined), 'The agent continued on its own');
});

test('a job that exits with an error is told apart from one that went well', () => {
	const turn = run(new LateTurnCollector(), [notice('exited', 1), { type: 'agent_start' }, say('It broke.'), { type: 'agent_settled' }]);
	assert.equal(turn?.request, 'Background job failed: UI job');
});
