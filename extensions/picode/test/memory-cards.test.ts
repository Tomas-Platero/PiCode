/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the chat says when it keeps something in memory.
 *
 * The rule being pinned: the sentence is about **the memory**, never about the tool. A save reads
 * "Saved \"…\" to memory · picode", not `mcp__engram__mem_save`; an update names the memory it
 * changed; and a call that touches memory without keeping anything — a lookup, a pin, a
 * consolidation that was only previewed — says nothing at all, because announcing a save that did
 * not happen is worse than announcing nothing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD_TITLE_CHARS, isMemoryWriteCall, memoryCard } from '../src/memory-cards.ts';

test('a save says what it kept, and where it landed', () => {
	const args = { title: 'Pi is pinned in one place', content: 'because two numbers drift', project: 'picode', scope: 'decision' };
	const card = memoryCard('mcp__engram__mem_save', args);

	assert.ok(card);
	assert.equal(card.running, 'Saving "Pi is pinned in one place" to memory…');
	assert.equal(card.done, 'Saved "Pi is pinned in one place" to memory · picode · decision');
	assert.equal(card.failed, 'Could not save "Pi is pinned in one place" to memory');
});

test('a save that names no project still says the memory, and promises no place', () => {
	const card = memoryCard('mem_save', { title: 'A trap that cost an afternoon' });

	assert.ok(card);
	assert.equal(card.done, 'Saved "A trap that cost an afternoon" to memory');
});

test('the project alone is enough of a place', () => {
	const card = memoryCard('mem_save', { title: 'The feed lives in the channel branch', project: 'picode' });

	assert.equal(card?.done, 'Saved "The feed lives in the channel branch" to memory · picode');
});

test('arguments that arrive as JSON text are read the same as a parsed object', () => {
	const serialised = JSON.stringify({ title: 'One answer, three readers', project: 'picode' });

	assert.equal(memoryCard('mcp__engram__mem_save', serialised)?.done, 'Saved "One answer, three readers" to memory · picode');
});

test('an update names the memory it changed, or its id when only the body changed', () => {
	const named = memoryCard('mcp__engram__mem_update', { id: '41', expected_project: 'picode', title: 'Pi is pinned in one place' });
	const unnamed = memoryCard('mcp__engram__mem_update', { id: '41', expected_project: 'picode', content: 'the reason changed' });

	assert.equal(named?.done, 'Updated "Pi is pinned in one place" in memory · picode');
	assert.equal(unnamed?.done, 'Updated #41 in memory · picode');
});

test('a consolidation is a write only when it was confirmed', () => {
	const plan = { ids_to_delete: [1, 2], new_title: 'One memory, not two', new_content: 'merged', expected_project: 'picode' };

	assert.equal(isMemoryWriteCall('mcp__engram__mem_consolidate', plan), false, 'a preview changes nothing and announces nothing');
	assert.equal(memoryCard('mcp__engram__mem_consolidate', plan), undefined);
	assert.equal(isMemoryWriteCall('mcp__engram__mem_consolidate', { ...plan, confirm: true }), true);
	assert.equal(memoryCard('mcp__engram__mem_consolidate', { ...plan, confirm: true })?.done,
		'Merged memories into "One memory, not two" · picode');
});

test('work on memory is not memory being kept', () => {
	for (const tool of ['mcp__engram__mem_search', 'mcp__engram__mem_get_observation', 'mcp__engram__mem_pin', 'mcp__engram__mem_judge', 'mcp__engram__mem_save_prompt', 'mcp__engram__mem_context']) {
		assert.equal(isMemoryWriteCall(tool, { title: 'x', id: '1' }), false, `${tool} must keep the ordinary row`);
		assert.equal(memoryCard(tool, { title: 'x', id: '1' }), undefined);
	}
});

test('the engine tool is the last segment, whatever the server is called', () => {
	assert.equal(isMemoryWriteCall('mcp__engram__mem_save', { title: 'x' }), true);
	assert.equal(isMemoryWriteCall('mcp__memory_engine__mem_save', { title: 'x' }), true);
	assert.equal(isMemoryWriteCall('mem_save', { title: 'x' }), true);
	assert.equal(isMemoryWriteCall('mcp__engram__mem_saver', { title: 'x' }), false, 'a name that merely starts the same way is not the tool');
});

test('a title long enough to break the line is cut with an ellipsis', () => {
	const title = 'x'.repeat(CARD_TITLE_CHARS + 40);
	const card = memoryCard('mem_save', { title });

	assert.ok(card);
	assert.equal(card.done.includes('…'), true);
	assert.equal(card.done.length < title.length + 40, true);
});

test('a save with no title still has a sentence', () => {
	const card = memoryCard('mcp__engram__mem_save', {});

	assert.equal(card?.done, 'Saved this memory to memory');
});

test('a tool name that is not a string is not a memory write', () => {
	assert.equal(isMemoryWriteCall(undefined, { title: 'x' }), false);
	assert.equal(isMemoryWriteCall(42, { title: 'x' }), false);
	assert.equal(memoryCard(undefined, { title: 'x' }), undefined);
});
