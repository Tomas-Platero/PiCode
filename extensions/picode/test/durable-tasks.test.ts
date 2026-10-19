/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable daemon's work, as the status panel lists it.
 *
 * `durable-tasks.ts` is pure (no `vscode`), so `node --test` runs it directly: the shapes
 * below are the daemon's own `sessions` rows and the snapshot's `run` presence.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { durableWorkRows, isSubagentConversation, snapshotInFlight, subagentTaskIdOf, type DurableConversationRow } from '../src/durable-tasks.ts';

/** A session row as the daemon's `sessions` shapes it. */
const row = (id: number, note: string, entries = 3, newest = 'entry 9 (pi.assistant)'): DurableConversationRow =>
	({ id, entries, newest, note });

test('the ownership task id is read from durable\'s own note, and only from it', () => {
	assert.equal(subagentTaskIdOf('subagent (task proof.subagent-run#3)'), 'proof.subagent-run#3');
	assert.equal(subagentTaskIdOf('subagent (task t1) '), 't1');
	assert.equal(subagentTaskIdOf('subagent(t)'), 't');
	assert.equal(subagentTaskIdOf('fork of 12'), undefined);
	assert.equal(subagentTaskIdOf(''), undefined);
	assert.equal(subagentTaskIdOf(undefined), undefined);
	assert.equal(isSubagentConversation('subagent (task t1)'), true);
	assert.equal(isSubagentConversation('fork of 12'), false);
});

test('a snapshot says in flight exactly when its run is present; anything else is unknown', () => {
	assert.equal(snapshotInFlight({ run: { inputs: ['s1'] } }), true);
	assert.equal(snapshotInFlight({ entries: [] }), false);
	assert.equal(snapshotInFlight(undefined), undefined);
	assert.equal(snapshotInFlight('junk'), undefined);
	assert.equal(snapshotInFlight(null), undefined);
});

test('rows are the subagent-owned conversations plus anything in flight; the rest leads nowhere', () => {
	const rows = durableWorkRows(
		[row(1, ''), row(2, 'subagent (task t2)'), row(3, 'fork of 1'), row(4, '')],
		new Map([[1, true], [2, false], [3, false], [4, false]]),
	);
	assert.deepEqual(rows, [
		{ conversationId: 1, inFlight: true, entries: 3, newest: 'entry 9 (pi.assistant)' },
		{ conversationId: 2, taskId: 't2', inFlight: false, entries: 3, newest: 'entry 9 (pi.assistant)' },
	]);
});

test('rows in flight lead, subagent-owned idle follow, conversation order otherwise', () => {
	const rows = durableWorkRows(
		[row(5, 'subagent (task t5)'), row(2, 'subagent (task t2)'), row(9, ''), row(4, '')],
		new Map([[5, false], [2, false], [9, true], [4, false]]),
	);
	assert.deepEqual(rows.map(r => r.conversationId), [9, 2, 5]);
});

test('a conversation that could not be snapshotted keeps its row, with the unknown said', () => {
	const rows = durableWorkRows([row(7, 'subagent (task t7)')], new Map());
	assert.deepEqual(rows, [{ conversationId: 7, taskId: 't7', inFlight: undefined, entries: 3, newest: 'entry 9 (pi.assistant)' }]);
});

test('malformed session rows are skipped, not invented', () => {
	const rows = durableWorkRows(
		[{ id: Number.NaN, entries: 0 } as unknown as DurableConversationRow, row(3, 'subagent (task t3)')],
		new Map(),
	);
	assert.deepEqual(rows.map(r => r.conversationId), [3]);
});
