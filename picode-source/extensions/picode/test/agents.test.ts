/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The launched agents, as rows.
 *
 * The state comes from the transcript's own last message entry — `assistant` means the agent
 * answered, `user`/`toolResult` means it still owes one — so these tests are about that reading
 * and about the list saying only what a listing supports.
 */

import * as assert from 'assert';
import { test } from 'node:test';
import { agentStateOf, agentsSummary, lastActivity, launchedAgents } from '../src/agents.ts';
import type { PiSessionFile } from '../src/sessions-provider.ts';

function file(id: string, over: Partial<PiSessionFile> = {}): PiSessionFile {
	return {
		id,
		file: `/sessions/--C--demo--/${id}.jsonl`,
		label: `prompt ${id}`,
		mtime: 1000,
		...over,
	};
}

test('the state is the last message entry, and nothing else', () => {
	assert.strictEqual(agentStateOf(file('a', { lastRole: 'assistant' })), 'answered');
	assert.strictEqual(agentStateOf(file('a', { lastRole: 'user' })), 'working');
	assert.strictEqual(agentStateOf(file('a', { lastRole: 'toolResult' })), 'working');
	assert.strictEqual(agentStateOf(file('a')), 'empty');
});

test('only a delegation is an agent, and it names the conversation that launched it', () => {
	const parent = file('parent', { label: 'the conversation', mtime: 500 });
	const child = file('child', { parent: parent.file, lastRole: 'assistant', mtime: 900 });
	const other = file('other', { lastRole: 'assistant' });

	const rows = launchedAgents([parent, child, other]);
	assert.deepStrictEqual(rows.map(row => row.id), ['child']);
	assert.strictEqual(rows[0].parentLabel, 'the conversation');
});

test('an agent whose parent is not in the listing names no parent, and invents none', () => {
	const child = file('child', { parent: 'C:\\somewhere\\else\\parent.jsonl', lastRole: 'assistant' });
	const rows = launchedAgents([child]);
	assert.strictEqual(rows[0].parent, 'C:\\somewhere\\else\\parent.jsonl');
	assert.strictEqual(rows[0].parentLabel, undefined);
});

test('the ones still working come first, then the newest', () => {
	const rows = launchedAgents([
		file('old-answered', { parent: 'p', lastRole: 'assistant', mtime: 100 }),
		file('new-answered', { parent: 'p', lastRole: 'assistant', mtime: 900 }),
		file('old-working', { parent: 'p', lastRole: 'toolResult', mtime: 200 }),
		file('new-working', { parent: 'p', lastRole: 'user', mtime: 300 }),
	]);
	assert.deepStrictEqual(rows.map(row => row.id), ['new-working', 'old-working', 'new-answered', 'old-answered']);
});

test('the summary counts the agents and how many owe an answer', () => {
	const rows = launchedAgents([
		file('a', { parent: 'p', lastRole: 'assistant' }),
		file('b', { parent: 'p', lastRole: 'toolResult' }),
		file('c', { parent: 'p', lastRole: 'user' }),
	]);
	assert.deepStrictEqual(agentsSummary(rows), { total: 3, working: 2 });
	assert.deepStrictEqual(agentsSummary([]), { total: 0, working: 0 });
});

test('the activity wording is the file clock said plainly', () => {
	const now = 1_000_000_000;
	assert.strictEqual(lastActivity(now - 5_000, now), 'just now');
	assert.strictEqual(lastActivity(now - 5 * 60_000, now), '5 min ago');
	assert.strictEqual(lastActivity(now - 3 * 3_600_000, now), '3 h ago');
	assert.strictEqual(lastActivity(now - 50 * 3_600_000, now), '2 d ago');
	// A clock that runs backwards (a file written by another machine) must not read as the future.
	assert.strictEqual(lastActivity(now + 60_000, now), 'just now');
});
