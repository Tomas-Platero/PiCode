/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The MCP server discovery, run on its own.
 *
 * The three sources a status answer merges — the profile's own list, the project's
 * `.pi/mcp.json`, and the servers the live session connected through a pi extension or
 * plugin — meet in pure functions here. What matters: a name clash keeps the source that
 * has an entry the settings form can edit, a server the session connected but no file
 * declares is reported rather than dropped, and a tool name that is not an MCP tool is not
 * read as one.
 */

import assert from 'assert';
import { test } from 'node:test';
import { discoveredMcpServers, mcpServerNameOfTool, mergeMcpServers } from '../src/mcp-provider.ts';

test('a server name comes out of the mcp__ prefix and the first double underscore', () => {
	assert.strictEqual(mcpServerNameOfTool('mcp__github__create_issue'), 'github');
	assert.strictEqual(mcpServerNameOfTool('mcp__files__read'), 'files');
	// A server id may carry single underscores; the separator is the double one.
	assert.strictEqual(mcpServerNameOfTool('mcp__my_server__run_task'), 'my_server');
});

test('a tool name that is not an MCP tool yields no server', () => {
	assert.strictEqual(mcpServerNameOfTool('read'), undefined);
	assert.strictEqual(mcpServerNameOfTool('mcp__'), undefined);
	assert.strictEqual(mcpServerNameOfTool('mcp__x'), undefined);
	assert.strictEqual(mcpServerNameOfTool('bash'), undefined);
});

test('discovered servers are the connected ones no known source declares', () => {
	const rows = discoveredMcpServers(['github'], ['github', 'storybook', '']);

	assert.deepStrictEqual(rows, [{ name: 'storybook', on: true, origin: 'discovered' }]);
});

test('without a live session there is no discovery and no invented row', () => {
	assert.deepStrictEqual(discoveredMcpServers([], undefined), []);
});

test('merge keeps the first source on a name clash: profile over project over discovered', () => {
	const merged = mergeMcpServers(
		[{ name: 'github', on: true, signIn: 'ok', origin: 'profile' }],
		[{ name: 'github', on: false, origin: 'project' }, { name: 'local-tools', on: true, origin: 'project' }],
		[{ name: 'local-tools', on: true, origin: 'discovered' }, { name: 'storybook', on: true, origin: 'discovered' }],
	);

	assert.deepStrictEqual(merged, [
		{ name: 'github', on: true, signIn: 'ok', origin: 'profile' },
		{ name: 'local-tools', on: true, origin: 'project' },
		{ name: 'storybook', on: true, origin: 'discovered' },
	]);
});

test('an empty set of sources merges to an empty list', () => {
	assert.deepStrictEqual(mergeMcpServers(), []);
});
