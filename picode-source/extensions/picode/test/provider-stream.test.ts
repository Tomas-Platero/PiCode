import * as assert from 'assert';
import { test } from 'node:test';
import { parseProviderStreamEvent } from '../src/provider-stream.ts';

test('openai-completions: the answer text arrives as its own part', () => {
	const parts = parseProviderStreamEvent('{"choices":[{"delta":{"content":"hola"}}]}', 'openai-completions');
	assert.deepStrictEqual(parts, { text: 'hola' });
});

test('openai-completions: the reasoning delta arrives as thinking — both spellings', () => {
	assert.deepStrictEqual(
		parseProviderStreamEvent('{"choices":[{"delta":{"reasoning_content":"pensando"}}]}', 'openai-completions'),
		{ thinking: 'pensando' },
	);
	assert.deepStrictEqual(
		parseProviderStreamEvent('{"choices":[{"delta":{"reasoning":"razonando"}}]}', 'openai-completions'),
		{ thinking: 'razonando' },
	);
});

test('openai-completions: a delta carrying text and reasoning together carries both', () => {
	const parts = parseProviderStreamEvent('{"choices":[{"delta":{"content":"a","reasoning_content":"b"}}]}', 'openai-completions');
	assert.deepStrictEqual(parts, { text: 'a', thinking: 'b' });
});

test('openai-responses: the answer and the reasoning summaries arrive per event type', () => {
	assert.deepStrictEqual(
		parseProviderStreamEvent('{"type":"response.output_text.delta","delta":"texto"}', 'openai-responses'),
		{ text: 'texto' },
	);
	assert.deepStrictEqual(
		parseProviderStreamEvent('{"type":"response.reasoning_summary_text.delta","delta":"summary"}', 'openai-responses'),
		{ thinking: 'summary' },
	);
	assert.deepStrictEqual(
		parseProviderStreamEvent('{"type":"response.reasoning_text.delta","delta":"reason"}', 'openai-responses'),
		{ thinking: 'reason' },
	);
});

test('events the dialect table does not name are skipped, never guessed', () => {
	assert.strictEqual(parseProviderStreamEvent('{"type":"response.completed"}', 'openai-responses'), undefined);
	assert.strictEqual(parseProviderStreamEvent('{"choices":[{"delta":{}}]}', 'openai-completions'), undefined);
	assert.strictEqual(parseProviderStreamEvent('{"usage":{}}', 'openai-completions'), undefined);
	assert.strictEqual(parseProviderStreamEvent('not json', 'openai-completions'), undefined);
	assert.strictEqual(parseProviderStreamEvent('[]', 'openai-completions'), undefined);
	assert.strictEqual(parseProviderStreamEvent('', 'openai-completions'), undefined);
});
