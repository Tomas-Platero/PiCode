/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a `/name` typed in the chat turns into, and what the chat's slash list offers.
 *
 * Measured against the profile's real commands (2026-10-29): a skill picked from the slash list
 * reached pi as `/vitest`, which pi does not expand; `/compact` reached the model as a sentence;
 * and `/gentle:jobs` answered with a warning about a terminal the chat does not have.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EDITOR_COMMANDS, isListedCommand, panelText, parseSlash, routeSlash, sessionStatsMarkdown, TERMINAL_ONLY_COMMANDS } from '../src/chat-commands.ts';
import { chatSlashCommandsOf, piPromptTemplatesOf } from '../src/command-registry.ts';

const context = {
	extensionCommands: new Set(['gentle:status', 'btw', 'mcp', 'gentle:jobs']),
	skills: new Set(['vitest', 'btw']),
};

test('a slash command is split into its name and its arguments', () => {
	assert.deepEqual(parseSlash('/mcp login sentry'), { name: 'mcp', args: 'login sentry' });
	assert.deepEqual(parseSlash('  /compact  '), { name: 'compact', args: '' });
	assert.deepEqual(parseSlash('/name my\nnew name'), { name: 'name', args: 'my\nnew name' });
	assert.equal(parseSlash('how does /compact work?'), undefined);
	assert.equal(parseSlash('/'), undefined);
});

test('an extension command goes to pi untouched', () => {
	assert.deepEqual(routeSlash('/gentle:status', context), { kind: 'pi', text: '/gentle:status' });
	assert.deepEqual(routeSlash('/mcp login x', context), { kind: 'pi', text: '/mcp login x' });
});

test('a skill picked from the slash list is loaded the way pi loads skills', () => {
	assert.deepEqual(routeSlash('/vitest', context), { kind: 'pi', text: '/skill:vitest' });
	assert.deepEqual(routeSlash('/vitest add a test', context), { kind: 'pi', text: '/skill:vitest add a test' });
	// The command of the same name is what pi itself would run.
	assert.deepEqual(routeSlash('/btw quick question', context), { kind: 'pi', text: '/btw quick question' });
	// pi's own form stays as it is.
	assert.deepEqual(routeSlash('/skill:vitest', context), { kind: 'pi', text: '/skill:vitest' });
});

test('pi’s terminal commands are answered by the editor', () => {
	assert.deepEqual(routeSlash('/compact keep the plan', context), { kind: 'editor', name: 'compact', args: 'keep the plan' });
	assert.deepEqual(routeSlash('/new', context), { kind: 'editor', name: 'new', args: '' });
	assert.deepEqual(routeSlash('/gentle:models', context), { kind: 'editor', name: 'gentle:models', args: '' });
});

test('an extension command of the same name wins over the editor’s answer', () => {
	const withCompact = { ...context, extensionCommands: new Set([...context.extensionCommands, 'compact']) };
	assert.deepEqual(routeSlash('/compact', withCompact), { kind: 'pi', text: '/compact' });
});

test('a terminal-only command is said plainly, never sent to the model', () => {
	const tree = routeSlash('/tree', context);
	assert.equal(tree?.kind, 'unavailable');
	// Even when an extension registered it: it would draw a panel nobody sees.
	const jobs = routeSlash('/gentle:jobs', context);
	assert.equal(jobs?.kind, 'unavailable');
	assert.equal(jobs?.kind === 'unavailable' ? jobs.command.action : undefined, 'tasks');
});

test('an unknown slash text still reaches pi (a prompt template, or a path the model reads)', () => {
	assert.deepEqual(routeSlash('/skill-creation build one', context), { kind: 'pi', text: '/skill-creation build one' });
	assert.equal(routeSlash('plain words', context), undefined);
});

test('no editor command is also terminal-only', () => {
	for (const command of EDITOR_COMMANDS) {
		assert.equal(TERMINAL_ONLY_COMMANDS.has(command.name), false, command.name);
		assert.ok(command.description.length > 0, command.name);
	}
});

test('the slash list holds commands, templates and the editor’s answers, without terminal-only ones', () => {
	const session = {
		extensionRunner: { getRegisteredCommands: () => [{ name: 'gentle:status', description: 'Status' }, { name: 'gentle:jobs' }] },
		promptTemplates: [{ name: 'skill-creation', description: 'Create a skill', argumentHint: '<topic>' }, { name: 'gentle:status' }],
	};
	const listed = chatSlashCommandsOf(session, [{ name: 'compact', description: 'Compact' }], isListedCommand);
	assert.deepEqual(listed.map(command => command.name), ['gentle:status', 'skill-creation', 'compact']);
	assert.deepEqual(listed[1], { name: 'skill-creation', description: 'Create a skill', argumentHint: '<topic>' });
});

test('templates are read defensively', () => {
	assert.deepEqual(piPromptTemplatesOf(undefined), []);
	assert.deepEqual(piPromptTemplatesOf({ promptTemplates: 'nope' }), []);
	assert.deepEqual(piPromptTemplatesOf({ promptTemplates: [{ name: '' }, { description: 'x' }] }), []);
});

test('a terminal panel becomes plain text', () => {
	assert.equal(panelText(['', '\u001b[1m╭──╮\u001b[0m   ', '│ ⚡ │', '', '']), '╭──╮\n│ ⚡ │');
	assert.equal(panelText(['  ', '']), undefined);
});

test('/session shows only the figures it knows', () => {
	const markdown = sessionStatsMarkdown({ name: 'Fix | login', userMessages: 3, input: 12345, cost: 0.01234 });
	assert.match(markdown, /Fix \\\| login/);
	assert.match(markdown, /12,345/);
	assert.match(markdown, /\$0\.0123/);
	assert.doesNotMatch(markdown, /Tool calls/);
	assert.match(sessionStatsMarkdown({}), /no messages/);
});
