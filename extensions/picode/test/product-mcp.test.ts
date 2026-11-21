/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The MCP servers the product offers a profile once. `node --test` runs this file directly. */

import assert from 'assert';
import { test } from 'node:test';
import { PRODUCT_MCP_SERVERS, withProductMcpServers } from '../src/product-mcp.ts';

const CONTEXT7 = { type: 'http', url: 'https://mcp.context7.com/mcp', oauth: {} };

test('the product offers Context7, the server Gentle AI provisions', () => {
	assert.deepEqual(PRODUCT_MCP_SERVERS.map(server => server.name), ['context7']);
});

test('a profile with no mcp.json gets Context7 and remembers it was offered', () => {
	const result = withProductMcpServers(undefined, undefined);
	assert.deepEqual(result.added, ['context7']);
	assert.deepEqual(JSON.parse(result.mcpText!), { mcpServers: { context7: CONTEXT7 } });
	assert.deepEqual(JSON.parse(result.seedsText!), { mcpServers: ['context7'] });
});

test('the servers already there stay exactly as they were', () => {
	const existing = { mcpServers: { github: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${T}' } } }, other: true };
	const result = withProductMcpServers(JSON.stringify(existing), undefined);
	assert.deepEqual(JSON.parse(result.mcpText!), { ...existing, mcpServers: { ...existing.mcpServers, context7: CONTEXT7 } });
});

test("an owner's own context7 entry wins: nothing is written to mcp.json, the offer is recorded", () => {
	const existing = JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } });
	const result = withProductMcpServers(existing, undefined);
	assert.deepEqual(result.added, []);
	assert.equal(result.mcpText, undefined);
	assert.deepEqual(JSON.parse(result.seedsText!), { mcpServers: ['context7'] });
});

test('once offered, a removed server is not added back', () => {
	const result = withProductMcpServers(JSON.stringify({ mcpServers: {} }), JSON.stringify({ mcpServers: ['context7'] }));
	assert.deepEqual(result, { added: [] });
});

test('a broken mcp.json is left alone and nothing is recorded, so the next start tries again', () => {
	const result = withProductMcpServers('{ "mcpServers": ', undefined);
	assert.deepEqual(result, { added: [] });
});

test('other keys of the seeds file are kept', () => {
	const result = withProductMcpServers(undefined, JSON.stringify({ later: 1 }));
	assert.deepEqual(JSON.parse(result.seedsText!), { later: 1, mcpServers: ['context7'] });
});
