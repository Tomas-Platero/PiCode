/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The background-jobs pill's reading of the pushed rows, run on its own.
 *
 * What matters: a push that is not a row list yields nothing, junk rows are dropped
 * (a row without a start time cannot show an elapsed time), the face names the oldest job
 * without inventing a name, and the elapsed label says what a person reads.
 */

import assert from 'assert';
import { test } from 'node:test';
import { agentStatusOf, elapsedLabel, pillFace, pillRowsOf, pillTooltipLine } from '../picodeAgentStatusData.ts';

const T0 = 1_000_000_000;

const row = {
	jobNumber: '3',
	label: 'web lint',
	command: 'npm run lint',
	startedAt: T0,
};

test('a push that is not a row list reads as nothing', () => {
	assert.deepStrictEqual(pillRowsOf(undefined), []);
	assert.deepStrictEqual(pillRowsOf('jobs'), []);
	assert.deepStrictEqual(pillRowsOf([{ nope: true }]), []);
});

test('a row without a start time is dropped: no elapsed, no pill row', () => {
	assert.deepStrictEqual(pillRowsOf([{ jobNumber: '1' }, row]), [row]);
});

test('the face shows the count and names the oldest job by its label', () => {
	const face = pillFace([{ ...row, startedAt: T0 + 5 }, { jobNumber: '1', label: 'first', startedAt: T0 }], T0 + 60_000);

	assert.strictEqual(face.count, 2);
	assert.strictEqual(face.detail, 'first · 1m');
});

test('a job without a label names itself by its job number, not by nothing', () => {
	const face = pillFace([{ jobNumber: '12', startedAt: T0 }], T0 + 45_000);

	assert.strictEqual(face.count, 1);
	assert.strictEqual(face.detail, 'job 12 · 45s');
});

test('the elapsed label reads like a person reads time', () => {
	assert.strictEqual(elapsedLabel(T0, T0 + 45_000), '45s');
	assert.strictEqual(elapsedLabel(T0, T0 + 5 * 60_000), '5m');
	assert.strictEqual(elapsedLabel(T0, T0 + 3 * 3_600_000), '3h');
	// A clock that jumped backwards shows no negative time.
	assert.strictEqual(elapsedLabel(T0 + 10_000, T0), '0s');
});

test('the tooltip line says the name, the command when it differs, and the elapsed time', () => {
	assert.strictEqual(pillTooltipLine(row, T0 + 60_000), 'web lint — npm run lint · 1m');
	assert.strictEqual(pillTooltipLine({ jobNumber: '4', startedAt: T0 }, T0), 'job 4 · 0s');
});

test('a push that is not a status object is not a status', () => {
	assert.strictEqual(agentStatusOf(undefined), undefined);
	assert.strictEqual(agentStatusOf('working'), undefined);
	assert.strictEqual(agentStatusOf([row]), undefined);
});

test('a status push is read as what the pill draws', () => {
	const status = agentStatusOf({
		backgroundJobs: [row],
		running: true,
		activity: 'Reading src/app.ts',
		queued: 2,
	});

	assert.ok(status !== undefined);
	assert.strictEqual(status.jobs.length, 1);
	assert.ok(status.running);
	assert.strictEqual(status.activity, 'Reading src/app.ts');
	assert.strictEqual(status.queued, 2);
});

test('a status with nothing happening is not a status: the pill hides', () => {
	assert.strictEqual(agentStatusOf({ backgroundJobs: [], running: false, queued: 0 }), undefined);
});

test('junk in the optional fields is dropped, not guessed', () => {
	const status = agentStatusOf({ backgroundJobs: [], running: true, activity: '   ', queued: -3 });

	assert.ok(status !== undefined);
	assert.ok(status.running);
	assert.strictEqual(status.activity, undefined);
	assert.strictEqual(status.queued, 0);
});

test('the old background-only shape still carries its jobs', () => {
	const status = agentStatusOf({ backgroundJobs: [row] });

	assert.ok(status !== undefined);
	assert.strictEqual(status.jobs.length, 1);
	assert.ok(!status.running);
	assert.strictEqual(status.queued, 0);
});
