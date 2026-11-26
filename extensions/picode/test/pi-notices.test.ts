/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piNotice } from '../src/pi-notices.ts';

test('reports cache warming and compaction costs only when enabled', () => {
	const event = { type: 'entry_appended', entry: { type: 'usage', kind: 'cache_warm', usage: { cost: { total: 0.03 } } } };
	assert.equal(piNotice(event, {}, []), undefined);
	assert.match(piNotice(event, { cacheWarming: true }, [])!, /0\.0300/);
	assert.match(piNotice({ type: 'compaction_end', result: { usage: { cost: { total: 0.12 } } } }, { compactionCosts: true }, [])!, /0\.1200/);
});

test('reports new provider reasoning drops without repeating earlier ones', () => {
	const message = { role: 'assistant', diagnostics: [{ type: 'openai_input_transformations', details: { transformations: [{ type: 'reasoning' }] } }] };
	assert.match(piNotice({ type: 'message_end', message }, { reasoningDrops: true }, [])!, /reasoning/i);
	assert.equal(piNotice({ type: 'message_end', message }, { reasoningDrops: true }, [{ type: 'message', message }]), undefined);
});

test('reports significant cache misses only after a previous cached request', () => {
	const usage = (input: number, cacheRead: number) => ({ input, cacheRead, cacheWrite: 0 });
	const previous = { type: 'message', message: { role: 'assistant', usage: usage(100, 4000) } };
	const event = { type: 'message_end', message: { role: 'assistant', usage: usage(4000, 100) } };
	assert.equal(piNotice(event, { cacheMisses: true }, []), undefined);
	assert.match(piNotice(event, { cacheMisses: true }, [previous])!, /cache/i);
});
