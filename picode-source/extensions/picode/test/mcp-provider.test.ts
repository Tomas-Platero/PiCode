/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `mcp.json` mapping, run on its own.
 *
 * The shapes here are the ones on disk in a real profile: `{"mcpServers": {}}` is what PiCode writes
 * before anything is declared, and every other fixture is what `mcpServers.ts` writes when a server
 * is. What matters — that a server the owner declared is listed, that one he did not is not, and
 * that a malformed entry is skipped instead of guessed at — needs no editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { mcpServerFrom, mcpServersFrom, type McpConfigFile, type PiMcpServer } from '../src/mcp-provider.ts';

/** A config file as the caller hands it over: where it is, what it says, whose it is. */
function config(path: string, servers: unknown, source: 'user' | 'local' = 'user'): McpConfigFile {
	return { path, text: JSON.stringify({ mcpServers: servers }), source };
}

function only(servers: readonly PiMcpServer[]): PiMcpServer {
	assert.strictEqual(servers.length, 1);
	return servers[0];
}

test('the empty file PiCode writes declares no server', () => {
	const read = mcpServersFrom([config('/profile/mcp.json', {})]);

	assert.deepStrictEqual(read.servers, []);
	assert.deepStrictEqual(read.skipped, []);
});

test('a local server is mapped with its arguments and environment', () => {
	const read = mcpServersFrom([
		config('/profile/mcp.json', {
			files: { command: 'node', args: ['server.js', '--root', '/tmp'], env: { TOKEN: 'abc', PORT: 8080 } },
		}),
	]);

	const server = only(read.servers);
	assert.strictEqual(server.kind, 'stdio');
	assert.strictEqual(server.label, 'files');
	assert.strictEqual(server.kind === 'stdio' ? server.command : undefined, 'node');
	assert.deepStrictEqual(server.kind === 'stdio' ? server.args : [], ['server.js', '--root', '/tmp']);
	assert.deepStrictEqual(server.kind === 'stdio' ? server.env : {}, { TOKEN: 'abc', PORT: 8080 });
	assert.strictEqual(server.source, 'user');
	assert.strictEqual(server.file, '/profile/mcp.json');
});

test('a remote server is mapped with its url and headers', () => {
	const read = mcpServersFrom([
		config('/profile/mcp.json', {
			remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer k' } },
		}),
	]);

	const server = only(read.servers);
	assert.strictEqual(server.kind, 'http');
	assert.strictEqual(server.kind === 'http' ? server.url : undefined, 'https://example.test/mcp');
	assert.deepStrictEqual(server.kind === 'http' ? server.headers : {}, { Authorization: 'Bearer k' });
});

test('an entry that names a command is started as a command even when it also carries a url', () => {
	const mapped = mcpServerFrom('both', { command: 'npx', url: 'https://example.test/mcp' });

	assert.ok(!('reason' in mapped));
	assert.strictEqual(mapped.kind, 'stdio');
});

test('environment values that are not literals are left out rather than sent wrong', () => {
	const mapped = mcpServerFrom('env', { command: 'node', env: { KEEP: 'yes', DROP_NULL: null, DROP_OBJECT: { a: 1 }, DROP_LIST: ['a'] } });

	assert.ok(!('reason' in mapped));
	assert.deepStrictEqual(mapped.kind === 'stdio' ? mapped.env : {}, { KEEP: 'yes' });
});

test('an entry that can be no server at all is skipped and said so', () => {
	const read = mcpServersFrom([
		config('/profile/mcp.json', {
			empty: {},
			'blank-url': { type: 'http', url: '   ' },
			'sse-server': { type: 'sse', url: 'https://example.test/sse' },
			'not-an-object': 'node server.js',
			ok: { command: 'node' },
		}),
	]);

	assert.deepStrictEqual(read.servers.map(server => server.label), ['ok']);
	assert.deepStrictEqual(read.skipped, [
		'/profile/mcp.json: "empty" was left out — no command and no url',
		'/profile/mcp.json: "blank-url" was left out — a "http" server with no url',
		'/profile/mcp.json: "sse-server" was left out — the transport "sse" has no definition in the editor',
		'/profile/mcp.json: "not-an-object" was left out — the entry is not an object',
	]);
});

test('a file that is not JSON, or not carrying an object of servers, is skipped not guessed', () => {
	const read = mcpServersFrom([
		{ path: '/profile/mcp.json', text: '{ half written', source: 'user' },
		{ path: '/project/.pi/mcp.json', text: '{"mcpServers": ["files"]}', source: 'local' },
		{ path: '/other/mcp.json', text: '[]', source: 'user' },
		// A file with no `mcpServers` key declares nothing of ours: it is not an error.
		{ path: '/empty/mcp.json', text: '{}', source: 'user' },
	]);

	assert.deepStrictEqual(read.servers, []);
	assert.deepStrictEqual(read.skipped, [
		'/profile/mcp.json: the file is not JSON',
		'/project/.pi/mcp.json: "mcpServers" is not an object',
		'/other/mcp.json: the file is not an object',
	]);
});

test('a project server replaces the profile one of the same name, and both files are read', () => {
	const read = mcpServersFrom([
		config('/profile/mcp.json', {
			files: { command: 'node', args: ['profile.js'] },
			remote: { type: 'http', url: 'https://example.test/mcp' },
		}),
		config('/project/.pi/mcp.json', { files: { command: 'node', args: ['project.js'] } }, 'local'),
	]);

	assert.deepStrictEqual(read.servers.map(server => server.label), ['files', 'remote']);
	const files = read.servers[0];
	assert.deepStrictEqual(files.kind === 'stdio' ? files.args : [], ['project.js']);
	assert.strictEqual(files.source, 'local');
	assert.strictEqual(files.file, '/project/.pi/mcp.json');
	assert.deepStrictEqual(read.skipped, []);
});
