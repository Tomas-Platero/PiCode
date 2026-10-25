/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The transcript's rows: what the daemon's entries become, and what a live event does to them.
 *
 * `durable-transcript-model.ts` is pure (no `vscode`), so `node --test` runs it directly. The
 * entries below are the durable storage format with pi-ai messages inside them, which is what
 * `subscribe` answers with.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTranscriptEvent, MAX_ROWS, MAX_TOOL_BYTES, transcriptOf, type TranscriptView } from '../src/durable-transcript-model.ts';

const user = (id: string, text: string, at = 1_000) => ({
	id,
	kind: 'pi.user',
	model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: at }],
});

const assistant = (id: string, text: string, at = 2_000) => ({
	id,
	kind: 'pi.assistant',
	model: [{ role: 'assistant', content: [{ type: 'text', text }], timestamp: at }],
});

const tool = (id: string, toolName: string, text: string, options: { isError?: boolean; durationMs?: number } = {}) => ({
	id,
	kind: 'pi.tool-result',
	model: [{
		role: 'toolResult',
		toolCallId: 'call-1',
		toolName,
		content: [{ type: 'text', text }],
		isError: options.isError === true,
		timestamp: 3_000,
		...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
	}],
});

const snapshot = (entries: readonly unknown[], running = false) => ({ entries, ...(running ? { run: { inputs: [1] } } : {}) });

test('each entry becomes the row a reader expects', () => {
	const view = transcriptOf(7, snapshot([user('e1', 'hola'), assistant('e2', 'qué tal'), tool('e3', 'bash', 'ok')]), 10_000);

	assert.deepEqual(view.rows.map(row => row.kind), ['user', 'assistant', 'tool']);
	assert.equal(view.entries, 3);
	assert.equal(view.omitted, 0);
	assert.equal(view.conversationId, 7);
	assert.equal(view.running, false);
	const toolRow = view.rows[2];
	assert.equal(toolRow.kind, 'tool');
	if (toolRow.kind === 'tool') {
		assert.equal(toolRow.name, 'bash');
		assert.equal(toolRow.lines, 1);
		assert.equal(toolRow.bytes, 2);
		assert.equal(toolRow.isError, false);
	}
});

test('a tool result that failed is flagged, and keeps its duration when the daemon gives one', () => {
	const view = transcriptOf(1, snapshot([tool('e1', 'bash', 'boom\nsecond line', { isError: true, durationMs: 1500 })]), 5_000);
	const row = view.rows[0];
	assert.equal(row.kind, 'tool');
	if (row.kind === 'tool') {
		assert.equal(row.isError, true);
		assert.equal(row.lines, 2);
		assert.equal(row.durationMs, 1500);
	}
});

test('context marks become notices instead of noisy entries', () => {
	const view = transcriptOf(1, snapshot([
		{ id: 'e1', kind: 'pi.system', model: [{ role: 'system', content: '' }] },
		{ id: 'e2', kind: 'pi.reset', model: [] },
		{ id: 'e3', kind: 'pi.compaction', model: [] },
	]), 1_000);
	assert.deepEqual(view.rows.map(row => row.kind), ['notice', 'notice', 'notice']);
	assert.deepEqual(view.rows.map(row => (row.kind === 'notice' ? row.text : '')), [
		'The prompt context was rebuilt.',
		'A new context starts here.',
		'Older entries were summarized.',
	]);
});

test('the header knows whether a run is in flight, and when it started', () => {
	const running = transcriptOf(1, snapshot([user('e1', 'go', 1_234), assistant('e2', 'working')], true), 2_000);
	assert.equal(running.running, true);
	assert.equal(running.startedAt, 1_234);
});

test('the newest rows win, and the count that was dropped is reported', () => {
	const entries = Array.from({ length: MAX_ROWS + 100 }, (_value, index) => user(`e${index}`, `prompt ${index}`));
	const view = transcriptOf(1, snapshot(entries), 1_000);
	assert.equal(view.rows.length, MAX_ROWS);
	assert.equal(view.omitted, 100);
	assert.equal(view.entries, MAX_ROWS + 100);
	// The tail is what survives: the last prompt is still there.
	const last = view.rows[view.rows.length - 1];
	assert.equal(last.kind, 'user');
	if (last.kind === 'user') {
		assert.equal(last.text, `prompt ${MAX_ROWS + 99}`);
	}
});

test('an enormous tool result is cut and says so', () => {
	const huge = 'x'.repeat(MAX_TOOL_BYTES + 10);
	const view = transcriptOf(1, snapshot([tool('e1', 'bash', huge)]), 1_000);
	const row = view.rows[0];
	assert.equal(row.kind, 'tool');
	if (row.kind === 'tool') {
		assert.equal(row.truncated, true);
		assert.ok(row.text.endsWith('… (truncated)'), row.text.slice(-30));
		assert.equal(row.bytes, MAX_TOOL_BYTES + 10);
	}
});

test('a live entry is appended once, even when the same event arrives twice', () => {
	const first = transcriptOf(1, snapshot([user('e1', 'hola')]), 1_000);
	const withEntry = applyTranscriptEvent(first, { type: 'entry_appended', entry: assistant('e2', 'respuesta') }, 2_000);

	assert.equal(withEntry.rows.length, 2);
	assert.equal(withEntry.entries, 2);

	const again = applyTranscriptEvent(withEntry, { type: 'entry_appended', entry: assistant('e2', 'respuesta') }, 2_100);
	assert.equal(again, withEntry, 'a repeated entry must not repaint');
});

test('run_start and run_end move the header, and the clock starts once', () => {
	const idle = transcriptOf(1, snapshot([user('e1', 'hola', 1_000)]), 1_000);
	const running = applyTranscriptEvent(idle, { type: 'run_start' }, 4_000);
	assert.equal(running.running, true);
	assert.equal(running.startedAt, 1_000);

	const done = applyTranscriptEvent(running, { type: 'run_end' }, 9_000);
	assert.equal(done.running, false);
	assert.equal(done.startedAt, 1_000);
});

test('events that change nothing a reader sees return the same frame', () => {
	const view: TranscriptView = transcriptOf(1, snapshot([user('e1', 'hola')]), 1_000);
	for (const event of [
		{ type: 'message_update', changes: [] },
		{ type: 'tool_execution_update', partial: 'x' },
		{ type: 'usage_changed', usage: {} },
		{ type: 'unknown_thing' },
		null,
		'not an event',
	]) {
		assert.equal(applyTranscriptEvent(view, event, 2_000), view);
	}
});

test('a reconnect snapshot replaces the frame', () => {
	const before = transcriptOf(1, snapshot([user('e1', 'hola')]), 1_000);
	const after = applyTranscriptEvent(before, { type: 'snapshot', entries: [user('e1', 'hola'), assistant('e2', 'más')] }, 2_000);
	assert.equal(after.rows.length, 2);
	assert.equal(after.entries, 2);
});

// --- one row per call: the call and its result are the same thing ---------------------------

let nextCallId = 0;
const callId = () => `call_${++nextCallId}`;

/** An assistant entry that only announced calls: no prose, no reasoning. */
const assistantWithCalls = (id: string, calls: readonly { id: string; name: string; command?: string }[], at = 2_000) => ({
	id,
	kind: 'pi.assistant',
	model: [{
		role: 'assistant',
		content: calls.map(call => ({
			type: 'toolCall',
			id: call.id,
			name: call.name,
			// The shape a real conversation carries: the command lives in `arguments.command`.
			arguments: call.command === undefined ? { path: 'README.md' } : { command: call.command },
		})),
		timestamp: at,
	}],
});

/** The result of one call, as `pi.tool-result` stores it. */
const resultOf = (id: string, toolCallId: string, text: string, options: { isError?: boolean; durationMs?: number; toolName?: string } = {}) => ({
	id,
	kind: 'pi.tool-result',
	model: [{
		role: 'toolResult',
		toolCallId,
		toolName: options.toolName ?? 'bash',
		content: [{ type: 'text', text }],
		isError: options.isError === true,
		...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
		timestamp: 3_000,
	}],
});

test('a call and its result are one row, with the command on the line', () => {
	const id = callId();
	const command = 'find src/app/api -maxdepth 1 -mindepth 1 -type d | sort';
	const view = transcriptOf(7, snapshot([
		user('e1', 'lista las rutas'),
		assistantWithCalls('e2', [{ id, name: 'bash', command }]),
		resultOf('e3', id, '/api/account\n/api/admin\n', { durationMs: 91 }),
	]), 10_000);

	assert.deepEqual(view.rows.map(row => row.kind), ['user', 'tool'], 'the call and the result are ONE row');
	const row = view.rows.find(candidate => candidate.kind === 'tool');
	assert.equal(row?.kind, 'tool');
	if (row?.kind !== 'tool') { return; }
	assert.equal(row.summary, command, 'the folded line says what ran');
	assert.equal(row.details, command, 'the opened row has the whole command');
	assert.equal(row.durationMs, 91);
	assert.equal(row.lines, 2);
	assert.equal(row.status, undefined, 'a call with a result is not running');
});

test('a call with no result yet is a row that says it is running, and stops saying it', () => {
	const id = callId();
	const entries = [user('e1', 'corre esto'), assistantWithCalls('e2', [{ id, name: 'bash', command: 'sleep 5' }])];

	const during = transcriptOf(7, snapshot(entries, true), 10_000);
	const running = during.rows.find(row => row.kind === 'tool');
	assert.equal(running?.kind, 'tool');
	if (running?.kind !== 'tool') { return; }
	assert.equal(running.status, 'running');
	assert.equal(running.summary, 'sleep 5');
	assert.equal(running.text, '', 'there is no output to show yet');
	assert.equal(running.lines, 0);

	const after = applyTranscriptEvent(during, { type: 'run_end', inputs: [1] }, 20_000);
	const ended = after.rows.find(row => row.kind === 'tool');
	assert.equal(ended?.kind, 'tool');
	if (ended?.kind !== 'tool') { return; }
	assert.equal(ended.status, 'no-result', 'a run that ended without a result says so');
});

test('three calls in a row fold into one line that names them', () => {
	const ids = [callId(), callId(), callId()];
	const view = transcriptOf(7, snapshot([
		user('e1', 'mira'),
		assistantWithCalls('e2', ids.map((id, index) => ({ id, name: 'bash', command: `echo ${index}` }))),
		...ids.map((id, index) => resultOf(`r${index}`, id, 'ok\n')),
	]), 10_000);

	assert.deepEqual(view.rows.map(row => row.kind), ['user', 'tool-group']);
	const group = view.rows[1];
	assert.equal(group.kind, 'tool-group');
	if (group.kind !== 'tool-group') { return; }
	assert.equal(group.calls.length, 3);
	assert.equal(group.names, 'bash ×3');
	const expectedBytes = group.calls.reduce((sum, call) => sum + (call.kind === 'tool' ? call.bytes : 0), 0);
	assert.ok(expectedBytes > 0, 'the members carry their output size');
	assert.equal(group.totalBytes, expectedBytes, 'the folded line says how much output the streak produced');
});

test('two calls in a row stay separate, and an error inside a streak stays visible', () => {
	const ids = [callId(), callId(), callId(), callId(), callId(), callId()];
	const view = transcriptOf(7, snapshot([
		user('e1', 'varias'),
		assistantWithCalls('e2', ids.map((id, index) => ({ id, name: 'bash', command: `echo ${index}` }))),
		resultOf('r1', ids[0], 'ok'),
		resultOf('r2', ids[1], 'ok'),
		resultOf('r3', ids[2], 'command not found', { isError: true }),
		resultOf('r4', ids[3], 'ok'),
		resultOf('r5', ids[4], 'ok'),
		resultOf('r6', ids[5], 'ok'),
	]), 10_000);

	const kinds = view.rows.map(row => row.kind);
	assert.deepEqual(kinds, ['user', 'tool', 'tool', 'tool', 'tool-group'],
		'a streak shorter than three stays open, the error never folds');
	const error = view.rows.find(row => row.kind === 'tool' && row.isError === true);
	assert.equal(error?.kind, 'tool');
	if (error?.kind !== 'tool') { return; }
	assert.equal(error.summary, 'echo 2', 'the failing call still says which command failed');
	const group = view.rows[view.rows.length - 1];
	assert.equal(group.kind, 'tool-group');
	if (group.kind !== 'tool-group') { return; }
	assert.equal(group.calls.length, 3, 'the three after the error do fold');
});
