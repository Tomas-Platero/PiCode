/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The subagents gentle-pi publishes, read into rows, run on their own.
 *
 * The store takes the one structured push gentle-pi makes (`setWidget` under `gentle-agents`,
 * one JSON line of `gentle-agents.activity/v1`), so every rule is exercised with that line as
 * data: no editor, no pi, no process.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GENTLE_AGENTS_SCHEMA, GENTLE_AGENTS_WIDGET_KEY, GentleAgentsStore, isActiveStatus, parseAgentActivity } from '../src/gentle-agents-store.ts';

const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
	summary: {
		id, agent: 'review-risk', label: 'check the diff', prompt: 'a long request that never reaches the screen', status,
		createdAt: 1, startedAt: 1_000, endedAt: null, lastStep: 'read', lastActivityAt: 2, turns: 2, toolCalls: 5, error: null,
		...extra,
	},
	thread: { version: 1, dropped: 0, items: [{ kind: 'text', text: 'secret thread text' }] },
});

const line = (tasks: unknown[]): string => JSON.stringify({ schema: GENTLE_AGENTS_SCHEMA, summary: {}, tasks });

test('a push becomes one row per task, in the order gentle-pi gave them', () => {
	const rows = parseAgentActivity([line([task('1', 'running'), task('2', 'completed', { endedAt: 5_000 })])]);
	assert.deepEqual(rows?.map(row => [row.id, row.status]), [['1', 'running'], ['2', 'completed']]);
	assert.equal(rows?.[0]?.agent, 'review-risk');
	assert.equal(rows?.[0]?.label, 'check the diff');
	assert.equal(rows?.[0]?.startedAt, 1_000);
	assert.equal(rows?.[0]?.endedAt, undefined);
	assert.equal(rows?.[1]?.endedAt, 5_000);
	assert.equal(rows?.[0]?.toolCalls, 5);
});

test('only a whitelisted handful of fields is kept: no prompt, no thread', () => {
	const [row] = parseAgentActivity([line([task('1', 'running')])])!;
	assert.deepEqual(Object.keys(row!).sort(), ['agent', 'endedAt', 'error', 'id', 'label', 'lastStep', 'startedAt', 'status', 'toolCalls', 'turns']);
	assert.ok(!JSON.stringify(row).includes('secret'));
	assert.ok(!JSON.stringify(row).includes('never reaches'));
});

test('an error is kept only when there is one', () => {
	const rows = parseAgentActivity([line([task('1', 'failed', { error: 'it broke' }), task('2', 'completed')])])!;
	assert.equal(rows[0]?.error, 'it broke');
	assert.equal(rows[1]?.error, undefined);
});

test('a line that is not the activity schema, or is broken, is not an answer', () => {
	assert.equal(parseAgentActivity([]), undefined);
	assert.equal(parseAgentActivity(['hello']), undefined);
	assert.equal(parseAgentActivity([`{ ${GENTLE_AGENTS_SCHEMA} not json`]), undefined);
	assert.equal(parseAgentActivity([JSON.stringify({ schema: 'something-else/v1', tasks: [] })]), undefined);
	assert.equal(parseAgentActivity([JSON.stringify({ schema: GENTLE_AGENTS_SCHEMA, tasks: 'no' })]), undefined);
});

test('a task with no id or an unknown status is skipped, the others stay', () => {
	const rows = parseAgentActivity([line([task('', 'running'), task('2', 'exploding'), task('3', 'waiting'), 7, null])])!;
	assert.deepEqual(rows.map(row => row.id), ['3']);
});

test('queued, running and waiting are the active states', () => {
	assert.deepEqual(['queued', 'running', 'waiting'].map(status => isActiveStatus(status as 'queued')), [true, true, true]);
	assert.deepEqual(['completed', 'failed', 'cancelled', 'timed_out'].map(status => isActiveStatus(status as 'failed')), [false, false, false, false]);
});

test('the store holds the last push and tells its listeners', () => {
	const store = new GentleAgentsStore();
	let fired = 0;
	const stop = store.onDidChange(() => { fired += 1; });
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [line([task('1', 'running')])]);
	assert.equal(store.current().length, 1);
	assert.equal(fired, 1);
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [line([task('1', 'completed', { endedAt: 9_000 })])]);
	assert.equal(store.current()[0]?.status, 'completed');
	assert.equal(fired, 2);
	stop();
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [line([])]);
	assert.equal(fired, 2, 'a stopped listener hears nothing');
});

test('other widgets, other shapes and broken pushes leave what was known untouched', () => {
	const store = new GentleAgentsStore();
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [line([task('1', 'running')])]);
	store.publish('some-other-widget', [line([])]);
	store.publish(GENTLE_AGENTS_WIDGET_KEY, 'not lines');
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [42]);
	store.publish(GENTLE_AGENTS_WIDGET_KEY, ['no schema here']);
	assert.deepEqual(store.current().map(row => row.id), ['1']);
});

test('removing the widget, or the session going, forgets the agents', () => {
	const store = new GentleAgentsStore();
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [line([task('1', 'running')])]);
	store.publish(GENTLE_AGENTS_WIDGET_KEY, undefined);
	assert.deepEqual(store.current(), []);
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [line([task('2', 'running')])]);
	store.clear();
	assert.deepEqual(store.current(), []);
});

test('a listener that throws does not stop the others', () => {
	const store = new GentleAgentsStore();
	let heard = false;
	store.onDidChange(() => { throw new Error('boom'); });
	store.onDidChange(() => { heard = true; });
	store.publish(GENTLE_AGENTS_WIDGET_KEY, [line([task('1', 'running')])]);
	assert.equal(heard, true);
});
