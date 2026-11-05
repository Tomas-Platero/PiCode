/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { beforeEach, test } from 'node:test';
import { recordTiming, resetTimings, timed, timingReport } from '../src/perf-timings.ts';

beforeEach(resetTimings);

test('the report sums runs and keeps the slowest and the last', () => {
	recordTiming('work', 10);
	recordTiming('work', 30);
	recordTiming('work', 20);
	assert.ok(timingReport().includes('| work | 3 | 20.0 | 30.0 | 20.0 |'));
});

test('the report lists the heaviest work first', () => {
	recordTiming('light', 1);
	recordTiming('heavy', 100);
	const report = timingReport();
	assert.ok(report.indexOf('heavy') < report.indexOf('light'));
});

test('timed returns what the work returns, sync and async', async () => {
	assert.strictEqual(timed('sync', () => 7), 7);
	assert.strictEqual(await timed('async', async () => 8), 8);
	assert.ok(timingReport().includes('| sync | 1 |'));
	assert.ok(timingReport().includes('| async | 1 |'));
});

test('a failure still counts and still reaches the caller', async () => {
	assert.throws(() => timed('throws', () => { throw new Error('no'); }), /no/);
	await assert.rejects(timed('rejects', async () => { throw new Error('no'); }), /no/);
	assert.ok(timingReport().includes('| throws | 1 |'));
	assert.ok(timingReport().includes('| rejects | 1 |'));
});
