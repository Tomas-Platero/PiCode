/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading memory, pinned.
 *
 * Three promises are under test here, and each one is a way the panel could lie:
 *
 *  * a half-written row from a store another agent is writing to becomes **no row**, never a row
 *    with `undefined` in it;
 *  * "the engine sent nothing" and "the store is empty" stay different answers, because the view
 *    says different things for them;
 *  * the detail tab prints facts a person can read — no identifiers, no routes, no paths.
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	memoryClientName,
	memoryDetailMarkdown,
	memoryDoctorMarkdown,
	memoryWhen,
	parseMemoryConflicts,
	parseMemoryDetail,
	parseMemoryDoctor,
	parseMemoryReview,
	parseMemoryRows
} from '../src/memory-client.ts';

const ROW = {
	id: 163,
	sync_id: 'obs-c05d90743457093b',
	session_id: '01a12225-d807-709b-af1f-5e9a03080795@PiCode',
	type: 'session-summary',
	title: 'pi durable al source de PiCode',
	content: '## 2026-10-09\n\n- Movido con git mv.',
	project: 'picode',
	scope: 'project',
	revision_count: 2,
	duplicate_count: 1,
	created_at: '2026-10-09T12:04:00Z',
	updated_at: '2026-10-19T08:00:00Z',
	last_seen_at: '2026-10-19T08:00:00Z'
};

test('a list keeps the rows it can show and drops the ones it cannot', () => {
	const rows = parseMemoryRows([ROW, { id: 2, title: '   ' }, { title: 'no id' }, null, 'junk']);
	assert.equal(rows?.length, 1);
	assert.equal(rows?.[0].id, 163);
	assert.equal(rows?.[0].project, 'picode');
	assert.equal(rows?.[0].revisions, 2);
	assert.equal(rows?.[0].duplicates, 1);
});

test('an empty store and a failed read are different answers', () => {
	// An empty array is a real answer: the view says "nothing saved yet".
	assert.deepEqual(parseMemoryRows([]), []);
	// Not a list at all: the view says nothing, because it does not know anything.
	assert.equal(parseMemoryRows({ error: 'nope' }), undefined);
	assert.equal(parseMemoryRows(undefined), undefined);
});

test('a memory without a type or a scope is still a memory', () => {
	const rows = parseMemoryRows([{ id: 7, title: 'Something' }]);
	assert.equal(rows?.[0].type, 'memory');
	assert.equal(rows?.[0].scope, '');
	assert.equal(rows?.[0].createdAt, '');
});

test('the detail carries the body; a body-less row is not a detail', () => {
	const detail = parseMemoryDetail(ROW);
	assert.equal(detail?.content, '## 2026-10-09\n\n- Movido con git mv.');
	assert.equal(parseMemoryDetail({ id: 1 }), undefined);
});

test('conflicts are read in both spellings a store may hold', () => {
	const current = parseMemoryConflicts({
		total: 1,
		relations: [{ id: 4, from_id: 10, to_id: 11, relation_type: 'contradicts' }]
	});
	assert.deepEqual(current?.rows, [{ id: 4, fromId: 10, toId: 11, relationType: 'contradicts' }]);

	const older = parseMemoryConflicts({ relations: [{ id: 5, from: 20, to: 21, type: 'supersedes' }] });
	assert.deepEqual(older?.rows, [{ id: 5, fromId: 20, toId: 21, relationType: 'supersedes' }]);
	assert.equal(older?.total, 1);

	// A relation that cannot name both ends is not drawn: it would be a line to nowhere.
	assert.deepEqual(parseMemoryConflicts({ relations: [{ id: 6, from_id: 10 }] })?.rows, []);
	assert.equal(parseMemoryConflicts({}), undefined);
});

test('the review queue counts what it lists', () => {
	const queue = parseMemoryReview({ count: 1, observations: [ROW] });
	assert.equal(queue?.count, 1);
	assert.equal(queue?.rows[0].title, 'pi durable al source de PiCode');
	// A count the list disagrees with is still a count; the rows are what can be shown.
	assert.equal(parseMemoryReview({ count: 3, observations: [] })?.count, 3);
	assert.equal(parseMemoryReview(undefined), undefined);
});

test('the doctor report reduces to a summary and the failing checks', () => {
	const report = parseMemoryDoctor({
		status: 'error',
		summary: { total: 10, ok: 9, warnings: 0, blocked: 0, errors: 1 },
		checks: [
			{ check_id: 'ambiguous_active_runtime_sessions', result: 'ok', severity: 'info', message: 'No issues detected.' },
			{ check_id: 'foreign_store', result: 'fail', severity: 'error', message: 'The store is served by another instance.' }
		]
	});
	assert.equal(report?.status, 'error');
	assert.deepEqual(report?.summary, { total: 10, ok: 9, warnings: 0, blocked: 0, errors: 1 });
	assert.equal(report?.checks.length, 2);
	assert.equal(parseMemoryDoctor({ status: 'ok' }), undefined);
});

test('a date is shown as a date, and a missing one as nothing', () => {
	assert.match(memoryWhen('2026-10-09T12:04:00Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	assert.equal(memoryWhen(''), '');
	assert.equal(memoryWhen('not a date'), '');
});

test('where a memory came from is a name, never an identifier', () => {
	assert.equal(memoryClientName('01a12225-d807-709b-af1f-5e9a03080795@PiCode'), 'PiCode');
	assert.equal(memoryClientName('someone@durable'), 'durable');
	assert.equal(memoryClientName('no-at-sign'), undefined);
	assert.equal(memoryClientName(undefined), undefined);
});

test('the detail tab shows the body first, then the facts, once each', () => {
	const markdown = memoryDetailMarkdown(parseMemoryDetail(ROW)!);
	assert.match(markdown, /^# pi durable al source de PiCode/);
	assert.match(markdown, /Movido con git mv\./);
	assert.match(markdown, /- \*\*Project:\*\* picode/);
	assert.match(markdown, /- \*\*Revisions:\*\* 2/);
	assert.match(markdown, /- \*\*Came from:\*\* a PiCode session/);
	// The identifiers the engine uses internally are not the reader's business.
	assert.doesNotMatch(markdown, /01a12225/);
	assert.doesNotMatch(markdown, /obs-c05d/);
	assert.doesNotMatch(markdown, /sync_id/);
});

test('a first version does not claim revisions it never had', () => {
	const markdown = memoryDetailMarkdown(parseMemoryDetail({ ...ROW, revision_count: 1, duplicate_count: 0 })!);
	assert.doesNotMatch(markdown, /Revisions/);
	assert.doesNotMatch(markdown, /Duplicates/);
});

test('the doctor tab leads with the verdict, not with ten rows of "ok"', () => {
	const markdown = memoryDoctorMarkdown(parseMemoryDoctor({
		status: 'error',
		summary: { total: 3, ok: 2, warnings: 0, blocked: 0, errors: 1 },
		checks: [
			{ check_id: 'store_is_served', result: 'ok', severity: 'info', message: 'No issues detected.' },
			{ check_id: 'sessions_resolve', result: 'ok', severity: 'info', message: 'No issues detected.' },
			{ check_id: 'foreign_store', result: 'error', severity: 'error', message: 'Another instance owns it.', why: 'Two processes would write over each other.' }
		]
	})!);
	assert.match(markdown, /1 of 3 checks need attention/);
	assert.match(markdown, /❌ \*\*foreign store\*\* — Another instance owns it\./);
	assert.match(markdown, /> Two processes would write over each other\./);
	assert.match(markdown, /✅ 2 other checks passed\./);
	// Passing checks are counted, not listed: their names are machinery.
	assert.doesNotMatch(markdown, /store is served/);
});

test('a clean report says so in one line', () => {
	const markdown = memoryDoctorMarkdown(parseMemoryDoctor({
		status: 'ok',
		summary: { total: 10, ok: 10, warnings: 0, blocked: 0, errors: 0 },
		checks: [{ check_id: 'anything', result: 'ok', severity: 'info', message: 'No issues detected.' }]
	})!);
	assert.match(markdown, /Everything checked out: 10 checks, no problems\./);
});

test('a cloud-only failure is named as such, because the cloud is off here', () => {
	const markdown = memoryDoctorMarkdown(parseMemoryDoctor({
		status: 'error',
		summary: { total: 2, ok: 1, warnings: 0, blocked: 0, errors: 1 },
		checks: [
			{ check_id: 'store_is_served', result: 'ok', severity: 'info', message: 'No issues detected.' },
			{ check_id: 'sync_target_closed_space', result: 'error', severity: 'error', message: '2 finding(s) detected.', why: 'A row points at a target no pipeline can advance.' }
		]
	})!);
	// Not a failure: the cloud is not used, so the verdict is clean and the leftover is a quiet note.
	assert.match(markdown, /Everything that matters checked out/);
	assert.doesNotMatch(markdown, /❌|need attention/);
	assert.match(markdown, /Not used: cloud sync/);
});
