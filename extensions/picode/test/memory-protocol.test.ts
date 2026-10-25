/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The memory protocol, pinned.
 *
 * Two things are being protected here, and neither is cosmetic:
 *
 *  * **It only appears when the tools do.** A session without a connected memory must not be told
 *    to call `mem_search`: that turns one missing server into a model apologising for a tool it
 *    cannot see. The tool list is the signal.
 *  * **It stays short.** This text is paid on every turn of every conversation. The budget is the
 *    test — growing it is a decision, not a side effect of a helpful edit.
 */

import assert from 'assert';
import { test } from 'node:test';
import { MEMORY_PROTOCOL, MEMORY_PROTOCOL_BUDGET, memorySection } from '../src/memory-protocol.ts';

test('the section is offered only when the session really has the memory tools', () => {
	// The chat's names are whatever pi gave the server: only the markers matter.
	assert.equal(memorySection(['mcp__engram__mem_search', 'mcp__engram__mem_save']), MEMORY_PROTOCOL);
	assert.equal(memorySection(['engram_mem_search', 'engram_mem_save', 'read']), MEMORY_PROTOCOL);

	// Nothing at all, or half of the pair: no protocol.
	assert.equal(memorySection([]), undefined);
	assert.equal(memorySection(['read', 'write', 'bash']), undefined);
	assert.equal(memorySection(['mcp__engram__mem_search']), undefined);
	assert.equal(memorySection(['mcp__engram__mem_save']), undefined);
});

test('the protocol says when to look, what to keep, and what is not memory', () => {
	// The three rules a person would give a new colleague, in the words the model reads.
	assert.match(MEMORY_PROTOCOL, /Search before answering/);
	assert.match(MEMORY_PROTOCOL, /Save what should outlive this conversation/);
	assert.match(MEMORY_PROTOCOL, /Do not save the transcript/);
	// The tools it names are the ones the engine actually exposes.
	assert.match(MEMORY_PROTOCOL, /mem_search/);
	assert.match(MEMORY_PROTOCOL, /mem_save/);
	assert.match(MEMORY_PROTOCOL, /mem_get_observation/);
});

test('the protocol stays inside its budget', () => {
	assert.ok(
		MEMORY_PROTOCOL.length <= MEMORY_PROTOCOL_BUDGET,
		`the memory protocol is ${MEMORY_PROTOCOL.length} characters, over its ${MEMORY_PROTOCOL_BUDGET} budget`
	);
});
