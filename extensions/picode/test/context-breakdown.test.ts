/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the Context block of Status shows: where the model's context goes.
 *
 * pi only knows the total; the parts are estimated here from what it sends the model (its system
 * text by sections, the tools it declares, the messages). When the total is known, the messages
 * take what the other parts leave, so the rows always add up to it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextBreakdown, splitSystemPrompt } from '../src/context-breakdown.ts';

const tokens = (text: string) => Math.ceil(text.length / 4);

const PROMPT = [
	'You are a coding assistant running inside pi.',
	'<tools>\n- read: read a file\n</tools>',
	'<rules>\n- be brief\n</rules>',
	'<project_context>\nProject-specific instructions and guidelines:\n<project_instructions path="AGENTS.md">Use English.</project_instructions>\n</project_context>',
	'<skills>\n<available_skills><skill><name>pdf</name></skill></available_skills>\n</skills>',
	'<cwd>\nD:/work\n</cwd>',
	'<memory>\nSave what matters.\n</memory>',
].join('\n\n');

test('the system text splits into pi\'s own, the project files, the skills and the rest', () => {
	const parts = splitSystemPrompt(PROMPT);
	assert.ok(parts.pi.includes('You are a coding assistant'));
	assert.ok(parts.pi.includes('<tools>') && parts.pi.includes('<rules>') && parts.pi.includes('<cwd>'));
	assert.ok(parts.project.includes('AGENTS.md'));
	assert.ok(parts.skills.includes('available_skills'));
	assert.ok(parts.other.includes('<memory>'));
	assert.ok(!parts.pi.includes('AGENTS.md') && !parts.other.includes('available_skills'));
});

test('a system text without sections counts as pi\'s own', () => {
	const parts = splitSystemPrompt('Whatever an extension forced.');
	assert.equal(parts.pi, 'Whatever an extension forced.');
	assert.equal(parts.project + parts.skills + parts.other, '');
});

test('tools are split into pi\'s and MCP, and only the declared ones count', () => {
	const result = contextBreakdown({
		systemPrompt: '',
		messages: [],
		tools: [
			{ name: 'read', description: 'Read a file', parameters: { type: 'object' } },
			{ name: 'mcp__jira__search', description: 'Search Jira', parameters: { type: 'object' } },
			{ name: 'hidden', description: 'Not declared', parameters: {} },
		],
		activeToolNames: ['read', 'mcp__jira__search'],
		contextWindow: 1000,
		reserveTokens: 100,
	});
	const part = (id: string) => result.parts.find(candidate => candidate.id === id)?.tokens ?? 0;
	assert.equal(part('tools'), tokens(JSON.stringify({ name: 'read', description: 'Read a file', parameters: { type: 'object' } })));
	assert.equal(part('mcp'), tokens(JSON.stringify({ name: 'mcp__jira__search', description: 'Search Jira', parameters: { type: 'object' } })));
	assert.equal(result.exact, false);
});

test('with the total known, the messages take what the rest leaves and the rows add up to it', () => {
	const result = contextBreakdown({
		systemPrompt: PROMPT,
		messages: [{ role: 'user', content: 'hi' }],
		tools: [],
		contextWindow: 10_000,
		usedTokens: 2_000,
		reserveTokens: 1_000,
	});
	const sum = result.parts.reduce((total, part) => total + part.tokens, 0);
	assert.equal(result.used, 2_000);
	assert.equal(result.exact, true);
	assert.equal(sum, 2_000);
	assert.equal(result.reserve, 1_000);
	assert.equal(result.free, 7_000);
	assert.equal(result.untilCompaction, 7_000);
});

test('without a total, everything is estimated, messages included, and system messages are not counted twice', () => {
	const result = contextBreakdown({
		systemPrompt: '',
		messages: [{ role: 'user', content: 'x'.repeat(400) }, { role: 'system', sections: { a: 'y'.repeat(4000) } }],
		tools: [],
		contextWindow: 10_000,
		reserveTokens: 0,
		estimateMessage: message => tokens(JSON.stringify(message)),
	});
	const messages = result.parts.find(part => part.id === 'messages')!.tokens;
	assert.equal(messages, tokens(JSON.stringify({ role: 'user', content: 'x'.repeat(400) })));
	assert.equal(result.used, messages);
	assert.equal(result.exact, false);
});

test('a context fuller than the window leaves nothing free and nothing until compaction', () => {
	const result = contextBreakdown({ systemPrompt: '', messages: [], tools: [], contextWindow: 1_000, usedTokens: 950, reserveTokens: 100 });
	assert.equal(result.free, 0);
	assert.equal(result.untilCompaction, 0);
});
