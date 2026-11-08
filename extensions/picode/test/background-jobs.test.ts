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
import { BackgroundJobTracker, backgroundJobRows, backgroundJobStartOf, gentleJobEndedBy, gentleJobOfToolResult } from '../src/background-jobs.ts';

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

test('a job start carries the file its output goes to', () => {
	const start = backgroundJobStartOf(['Started background job 3 (web lint).', 'Output: /data/jobs/3.log', 'You will be notified once.'].join(String.fromCharCode(10)));
	assert.strictEqual(start?.outputPath, '/data/jobs/3.log');
	assert.strictEqual(backgroundJobStartOf('Started background job 3 (web lint). It keeps running.')?.outputPath, undefined);
});

test('a completed job is remembered as ended, newest first, and capped', () => {
	const tracker = new BackgroundJobTracker();
	for (let n = 1; n <= 7; n++) {
		tracker.start({ jobNumber: String(n), label: `job ${n}` }, T0 + n);
		tracker.complete({ id: String(n) }, T0 + 100 + n);
	}
	assert.deepStrictEqual(tracker.list(), []);
	assert.deepStrictEqual(tracker.finished().map(job => job.jobNumber), ['7', '6', '5', '4', '3']);
	assert.strictEqual(tracker.finished()[0].endedAt, T0 + 107);
	tracker.clear();
	assert.deepStrictEqual(tracker.finished(), []);
});

// The answers below are the shapes a real gentle-pi 4.7.0 session wrote.
const OUTPUT = 'D:/data/tmp/gentle-jobs-07wfvo/job-1.log';
const details = (status: string, event?: string) => ({ gentleJobs: { jobId: 'job-1', kind: 'command', label: 'UI test job', status, exitCode: null, outputPath: OUTPUT, ...(event === undefined ? {} : { event }) } });

test('a job of gentle-pi opens from the answer of the tool that started it', () => {
	const job = gentleJobOfToolResult('bash_background', { content: [], details: details('running') });
	assert.deepStrictEqual(job, { key: OUTPUT, label: 'UI test job', outputPath: OUTPUT, running: true, outcome: 'running' });
	assert.strictEqual(gentleJobOfToolResult('monitor', { details: details('running') })?.running, true);
});

test('job_stop closes a job and can never open one', () => {
	assert.strictEqual(gentleJobOfToolResult('job_stop', { details: details('stopped') })?.running, false);
	assert.strictEqual(gentleJobOfToolResult('job_stop', { details: details('running') }), undefined);
});

test('any other tool, or an answer without a job, says nothing', () => {
	assert.strictEqual(gentleJobOfToolResult('bash', { details: details('running') }), undefined);
	assert.strictEqual(gentleJobOfToolResult('bash_background', { details: {} }), undefined);
	assert.strictEqual(gentleJobOfToolResult('bash_background', undefined), undefined);
});

test('the notice of an ended job closes it; a monitor reporting lines does not', () => {
	const notice = (status: string, event?: string) => ({ role: 'custom', customType: 'gentle-jobs.notice', display: true, content: 'text', details: details(status, event) });
	assert.strictEqual(gentleJobEndedBy(notice('exited'))?.key, OUTPUT);
	assert.strictEqual(gentleJobEndedBy(notice('failed'))?.key, OUTPUT);
	assert.strictEqual(gentleJobEndedBy(notice('running', 'events')), undefined);
	assert.strictEqual(gentleJobEndedBy({ customType: 'another', details: details('exited') }), undefined);
});
