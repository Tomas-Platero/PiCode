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
