/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The transcript's wire shape, and the clock the header reads from it.
 *
 * This file exists because of a bug that no test covered: the frame the webview received did not
 * carry `at`, so the finished-run clock computed `undefined - startedAt` and the header said
 * "NaNs total". A mapping is only trustworthy when a test names every field the page reads, and
 * a clock is only trustworthy when a missing input is "no clock" instead of a number-shaped NaN.
 *
 * `durable-transcript-wire.ts` is pure (no `vscode`), so `node --test` runs it directly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTranscriptEvent, transcriptOf } from '../src/durable-transcript-model.ts';
import { elapsedMs, wireView } from '../src/durable-transcript-wire.ts';

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

const tool = (id: string, text: string, isError = false) => ({
	id,
	kind: 'pi.tool-result',
	model: [{
		role: 'toolResult',
		toolCallId: 'call-1',
		toolName: 'bash',
		content: [{ type: 'text', text }],
		isError,
		timestamp: 3_000,
		durationMs: 1_500,
	}],
});

const snapshot = (entries: readonly unknown[], running = false) => ({ entries, ...(running ? { run: { inputs: [1] } } : {}) });

const identity = (markdown: string) => markdown;

test('a live frame carries every field the header reads', () => {
	const view = transcriptOf(172, snapshot([user('e1', 'hola')], true), 4_000);
	const frame = wireView(view, 'live', identity);

	assert.equal(frame.conversationId, 172);
	assert.equal(frame.running, true);
	assert.equal(frame.startedAt, 1_000);
	assert.equal(frame.at, 4_000);
	assert.equal(frame.connection, 'live');
	assert.equal(frame.entries, 1);
	assert.equal(frame.omitted, 0);
	assert.ok(Array.isArray(frame.rows));
});

test('a finished frame still carries `at`, so the total is a number and not NaN', () => {
	// This is the regression: the wire view used to drop `at`, and the page then computed
	// `undefined - startedAt`.
	const running = transcriptOf(172, snapshot([user('e1', 'hola', 1_000)], true), 1_000);
	const done = applyTranscriptEvent(running, { type: 'run_end' }, 16_000);
	const frame = wireView(done, 'live', identity);

	assert.equal(typeof frame.at, 'number');
	assert.ok(Number.isFinite(frame.at), `frame.at is ${frame.at}`);
	assert.equal(elapsedMs(frame.startedAt, frame.at), 15_000, 'NaNs total');
});

test('a missing clock reads as no clock, never as NaN', () => {
	assert.equal(elapsedMs(undefined, 5_000), undefined);
	assert.equal(elapsedMs(1_000, undefined), undefined);
	assert.equal(elapsedMs(Number.NaN, 5_000), undefined);
	assert.equal(elapsedMs(1_000, Number.NaN), undefined);
	// A clock that would go backwards is clamped rather than printed as negative time.
	assert.equal(elapsedMs(5_000, 4_000), 0);
});

test('rows keep their kind, and only the agent row carries rendered HTML', () => {
	const view = transcriptOf(1, snapshot([user('e1', 'hola'), assistant('e2', '**hola**'), tool('e3', 'salida')]), 9_000);
	const frame = wireView(view, 'live', markdown => `<rendered>${markdown}</rendered>`);

	const [userRow, assistantRow, toolRow] = frame.rows;
	assert.equal(userRow.kind, 'user');
	assert.equal(userRow.text, 'hola');
	assert.equal(userRow.html, undefined, 'a user row must not carry HTML');

	assert.equal(assistantRow.kind, 'assistant');
	assert.equal(assistantRow.html, '<rendered>**hola**</rendered>');

	assert.equal(toolRow.kind, 'tool');
	assert.equal(toolRow.text, undefined, 'a tool row is text, never HTML');
	assert.equal(toolRow.tool?.name, 'bash');
	assert.equal(toolRow.tool?.lines, 1);
	assert.equal(toolRow.tool?.bytes, 6);
	assert.equal(toolRow.tool?.isError, false);
	assert.equal(toolRow.tool?.durationMs, 1_500);
});

test('a failed tool row keeps the flag the page paints red', () => {
	const view = transcriptOf(1, snapshot([tool('e1', 'boom', true)]), 9_000);
	const frame = wireView(view, 'live', identity);
	assert.equal(frame.rows[0].tool?.isError, true);
});
