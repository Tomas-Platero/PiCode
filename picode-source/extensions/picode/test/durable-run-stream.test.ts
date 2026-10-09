/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The durable run's live events, mapped for the chat.
 *
 * `durable-run-stream.ts` is pure (no `vscode`), so `node --test` runs it directly: the
 * shapes below are the daemon's subscribe-stream events, exactly as
 * `picode-source/durable`'s harness delivers them (`pi-durable`'s events.js `translate`).
 * The rules pinned here are the agent's own CLI renderer's (`durable/lib/render.js`'s
 * `makeRunRenderer`), so the chat reads a run the same way the terminal does.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurableRunStreamMapper } from '../src/durable-run-stream.ts';

/** A text-delta event, as the daemon's `translate` shapes a partial generation message. */
const delta = (text: string): unknown =>
	({ type: 'message_update', changes: [{ type: 'text_delta', delta: text }] });

/** An assistant message_end, carrying the entry whose model holds the full answer. */
const messageEnd = (text: string): unknown =>
	({ type: 'message_end', entry: { kind: 'pi.assistant', model: [{ role: 'assistant', content: text }] } });

test('text deltas stream as they come, and count as streamed', () => {
	const mapper = new DurableRunStreamMapper();
	assert.deepEqual(mapper.consume({ type: 'message_start' }), {});
	assert.deepEqual(mapper.consume(delta('Hola ')), { markdown: 'Hola ' });
	assert.deepEqual(mapper.consume(delta('mundo')), { markdown: 'mundo' });
});

test('an answer whose deltas were streamed is NOT written again at its end', () => {
	const mapper = new DurableRunStreamMapper();
	mapper.consume({ type: 'message_start' });
	mapper.consume(delta('respuesta parcial'));
	assert.deepEqual(mapper.consume(messageEnd('respuesta completa')), {}, 'the deltas were the message');
});

test('an answer that arrives whole is written at its end, and only there', () => {
	const mapper = new DurableRunStreamMapper();
	assert.deepEqual(mapper.consume(messageEnd('La respuesta entera.')), { markdown: 'La respuesta entera.' });
	// The daemon opens every non-streamed answer with its own message_start (events.js
	// `translate` pushes it when the entry was not shown partially), so the next whole
	// answer arrives after a reset and is written too — each one exactly once.
	assert.deepEqual(mapper.consume({ type: 'message_start' }), {});
	assert.deepEqual(mapper.consume(messageEnd('La segunda, entera.')), { markdown: 'La segunda, entera.' });
});

test('message_start resets the streamed flag: the next answer is written from its own deltas', () => {
	const mapper = new DurableRunStreamMapper();
	mapper.consume({ type: 'message_start' });
	mapper.consume(delta('primera'));
	mapper.consume(messageEnd('primera'));
	assert.deepEqual(mapper.consume({ type: 'message_start' }), {});
	assert.deepEqual(mapper.consume(delta('segunda ')), { markdown: 'segunda ' });
	assert.deepEqual(mapper.consume(messageEnd('segunda entera')), {}, 'second answer was streamed too');
});

test('tool starts show as progress, named after the tool', () => {
	const mapper = new DurableRunStreamMapper();
	assert.deepEqual(mapper.consume({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} }), { progress: 'bash' });
	assert.deepEqual(mapper.consume({ type: 'tool_execution_start', toolCallId: 't2' }), {}, 'a tool without a name says nothing');
});

test('a failed task is a warning; the run\'s plumbing is dropped, not guessed at', () => {
	const mapper = new DurableRunStreamMapper();
	assert.deepEqual(mapper.consume({ type: 'task_failed', taskId: 't9', kind: 'pi.generation', message: 'provider unreachable' }), { warning: 'provider unreachable' });
	assert.deepEqual(mapper.consume({ type: 'task_failed', taskId: 't9', kind: 'pi.generation' }), {});
	assert.deepEqual(mapper.consume({ type: 'run_end', inputs: ['s1'] }), {});
	assert.deepEqual(mapper.consume({ type: 'entry_appended', entry: { kind: 'pi.system' } }), {});
	assert.deepEqual(mapper.consume({ type: 'auto_retry_start', attempt: 2 }), {});
	assert.deepEqual(mapper.consume(undefined), {});
	assert.deepEqual(mapper.consume('junk'), {});
});

test('message updates that carry no text delta say nothing', () => {
	const mapper = new DurableRunStreamMapper();
	assert.deepEqual(mapper.consume({ type: 'message_update', changes: [{ type: 'usage_update' }] }), {});
	assert.deepEqual(mapper.consume({ type: 'message_update', changes: [{ type: 'text_delta' }] }), {});
	assert.deepEqual(mapper.consume({ type: 'message_update' }), {});
});
