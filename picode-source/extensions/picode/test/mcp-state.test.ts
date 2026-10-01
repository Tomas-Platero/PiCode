/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading pi's own answer about its MCP servers, run on its own.
 *
 * The fixtures are the shapes pi 0.99.2 actually printed: a server that connected with one tool, and
 * one that failed because the command did not exist (the reason arriving on two lines, in the
 * machine's language). What matters — that a failure keeps its reason, that an unreadable answer is
 * empty rather than a lie — needs no editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { mcpStateReport, oneLine, stateSentence } from '../src/mcp-state.ts';

const CONNECTED = JSON.stringify({
	servers: [
		{ name: 'probe', scope: 'global', source: 'C:\\profile\\mcp.json', enabled: true, exposure: 'codemode', transport: 'node server.mjs', state: 'connected', tools: ['echo'] },
		{
			name: 'broken',
			scope: 'global',
			source: 'C:\\profile\\mcp.json',
			enabled: true,
			exposure: 'codemode',
			transport: 'no-such-command-anywhere',
			state: 'failed',
			tools: [],
			error: 'MCP connection closed\n"no-such-command-anywhere" no se reconoce como un comando interno o externo.',
		},
	],
	errors: [],
});

test('a connected server arrives with its state and how many tools it offers', () => {
	const report = mcpStateReport(CONNECTED);
	assert.strictEqual(report.servers.length, 2);
	assert.deepStrictEqual(report.servers[0], { name: 'probe', state: 'connected', tools: 1 });
});

test('a failure keeps pi\'s reason, which is the only part that explains it', () => {
	const broken = mcpStateReport(CONNECTED).servers[1];
	assert.strictEqual(broken?.state, 'failed');
	assert.ok(broken?.error?.startsWith('MCP connection closed'));
	assert.ok(broken?.error?.includes('no se reconoce'));
});

test('the file-level problems come through as their own list', () => {
	const report = mcpStateReport(JSON.stringify({
		servers: [],
		errors: ['C:\\profile\\mcp.json: invalid server name "my.server" (use letters, digits, "_" and "-")'],
	}));

	assert.deepStrictEqual(report.servers, []);
	assert.strictEqual(report.errors.length, 1);
	assert.ok(report.errors[0].includes('invalid server name'));
});

test('an answer that is not that answer reads as empty, never as "no servers"', () => {
	for (const output of ['', 'not json at all', '{"servers": "broken"}', '[]', '{"servers": [{"name": "x"}]}']) {
		assert.deepStrictEqual(mcpStateReport(output), { servers: [], errors: [] }, output);
	}
});

test('the sentence keeps pi\'s word and counts the tools, singular included', () => {
	assert.strictEqual(stateSentence({ name: 'probe', state: 'connected', tools: 1 }), '"probe": connected, 1 tool');
	assert.strictEqual(stateSentence({ name: 'supabase', state: 'connected', tools: 12 }), '"supabase": connected, 12 tools');
	assert.strictEqual(stateSentence({ name: 'sentry', state: 'needs-auth', tools: 0 }), '"sentry": needs-auth');
});

test('a failure sentence carries the reason, on one line and not for ever', () => {
	const sentence = stateSentence({ name: 'broken', state: 'failed', tools: 0, error: 'MCP connection closed\n"no-such-command" x\n' });

	assert.ok(sentence.startsWith('"broken": failed — MCP connection closed · "no-such-command" x'));
	assert.ok(!sentence.includes('\n'));
	assert.ok(stateSentence({ name: 'x', state: 'failed', tools: 0, error: 'y'.repeat(400) }).length < 240);
});

test('squashing a message keeps its lines, and caps it', () => {
	assert.strictEqual(oneLine('a\n\n  b  \nc'), 'a · b · c');
	assert.strictEqual(oneLine('   '), '');
	assert.strictEqual(oneLine('x'.repeat(300)).length, 201);
});
