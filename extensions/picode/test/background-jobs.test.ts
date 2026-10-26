/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License. See License.txt
 *--------------------------------------------------------------------------------------------*/

/**
 * The background-jobs registry, run on its own.
 *
 * What matters: a job only exists once its start named it, its completion closes **its**
 * job (by number, or by the label or command the completion repeats), a completion that
 * names nothing open is ignored, and the list comes back oldest first.
 */

import assert from 'assert';
import { test } from 'node:test';
import { BackgroundJobTracker, backgroundJobRows, backgroundJobStartOf } from '../src/background-jobs.ts';

const T0 = 1_000_000;

test('a start without a job number is not a trackable job', () => {
	const tracker = new BackgroundJobTracker();
	tracker.start({ jobNumber: '' }, T0);

	assert.deepStrictEqual(tracker.list(), []);
});

test('a named start is listed oldest first', () => {
	const tracker = new BackgroundJobTracker();
	tracker.start({ jobNumber: '2', label: 'second' }, T0 + 10);
	tracker.start({ jobNumber: '1', label: 'first', command: 'npm run lint' }, T0);

	assert.deepStrictEqual(tracker.list().map(job => job.jobNumber), ['1', '2']);
});

test('the completion that names the job number closes exactly that job', () => {
	const tracker = new BackgroundJobTracker();
	tracker.start({ jobNumber: '3', label: 'lint' }, T0);
	tracker.start({ jobNumber: '4', label: 'build' }, T0 + 5);

	tracker.complete({ id: '3', label: 'lint' });

	assert.deepStrictEqual(tracker.list().map(job => job.jobNumber), ['4']);
});

test('a completion without a known number falls back to the label the start carried', () => {
	const tracker = new BackgroundJobTracker();
	tracker.start({ jobNumber: '7', label: 'dev server', command: 'vite' }, T0);

	tracker.complete({ label: 'dev server' });

	assert.ok(tracker.isEmpty());
});

test('a completion naming nothing open is ignored', () => {
	const tracker = new BackgroundJobTracker();
	tracker.start({ jobNumber: '1', label: 'lint' }, T0);

	tracker.complete({ id: '99' });
	tracker.complete({ label: 'never started' });

	assert.deepStrictEqual(tracker.list().length, 1);
});

test('the start is read from the tool result sentence the card also reads', () => {
	assert.deepStrictEqual(
		backgroundJobStartOf('Started background job 12 (web lint + type-check). It keeps running…'),
		{ jobNumber: '12', label: 'web lint + type-check' },
	);
	assert.deepStrictEqual(backgroundJobStartOf('Started background job 9.'), { jobNumber: '9' });
	assert.strictEqual(backgroundJobStartOf('something else'), undefined);
	assert.strictEqual(backgroundJobStartOf(undefined), undefined);
});

test('the rows the pill is told about carry when each job started', () => {
	const tracker = new BackgroundJobTracker();
	tracker.start({ jobNumber: '1', label: 'lint' }, T0);

	assert.deepStrictEqual(backgroundJobRows(tracker.list(), T0), [
		{ jobNumber: '1', label: 'lint', startedAt: T0 },
	]);
});

test('clear forgets every job — the session they belonged to is gone', () => {
	const tracker = new BackgroundJobTracker();
	tracker.start({ jobNumber: '1' }, T0);

	tracker.clear();

	assert.ok(tracker.isEmpty());
});
