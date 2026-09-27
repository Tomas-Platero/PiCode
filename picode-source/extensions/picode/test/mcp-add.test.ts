/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adding one MCP server, run on its own.
 *
 * The fixtures are the shapes on disk in a real profile: an existing `mcp.json` the settings
 * row wrote, one the owner filled in by hand with an env and headers the row cannot express,
 * and no file at all. What matters — that a complete draft becomes exactly the entry the
 * adapter documents, that everything already in the file survives the addition untouched, and
 * that a draft or a line that is not right is said rather than guessed — needs no editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import {
	mcpServersTextWithAdded,
	mcpServersWithAdded,
	parseKeyValueLines,
	serverFileEntry,
	serverNames,
	validateDraft,
	validateServerName,
	type AddServerDraft,
} from '../src/mcp-add.ts';
import { mcpServersFile, type McpServerSetting } from '../src/mcpServers.ts';
import { mcpServersFrom } from '../src/mcp-provider.ts';

test('a local server becomes the command, its arguments and its environment', () => {
	const entry = serverFileEntry({
		name: 'files',
		transport: 'stdio',
		command: ' node ',
		args: ['server.js', '--root', '/tmp with space'],
		env: { TOKEN: 'abc' },
	});

	assert.deepStrictEqual(entry, { command: 'node', args: ['server.js', '--root', '/tmp with space'], env: { TOKEN: 'abc' } });
});

test('a local server with no environment carries no env key', () => {
	assert.deepStrictEqual(serverFileEntry({ name: 'files', transport: 'stdio', command: 'node' }), { command: 'node', args: [] });
});

test('a remote server becomes its url and headers', () => {
	const entry = serverFileEntry({
		name: 'remote',
		transport: 'http',
		url: ' https://example.test/mcp ',
		headers: { Authorization: 'Bearer k' },
	});

	assert.deepStrictEqual(entry, { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer k' } });
});

test('a remote server with no headers carries no headers key', () => {
	assert.deepStrictEqual(
		serverFileEntry({ name: 'remote', transport: 'http', url: 'https://example.test/mcp' }),
		{ type: 'http', url: 'https://example.test/mcp' },
	);
});

test('a draft is refused while it is not yet a server the adapter could run', () => {
	assert.strictEqual(validateDraft({ name: '', transport: 'stdio' }).length, 2);
	assert.strictEqual(validateDraft({ name: 'has spaces', transport: 'stdio', command: 'node' }).length, 1);
	assert.strictEqual(validateDraft({ name: 'files', transport: 'stdio' }).length, 1);
	assert.strictEqual(validateDraft({ name: 'remote', transport: 'http' }).length, 1);
	assert.strictEqual(validateDraft({ name: 'remote', transport: 'http', url: 'ftp://example.test/mcp' }).length, 1);
});

test('a complete draft of either transport is accepted', () => {
	assert.deepStrictEqual(validateDraft({ name: 'files', transport: 'stdio', command: 'node' }), []);
	assert.deepStrictEqual(validateDraft({ name: 'remote', transport: 'http', url: 'https://example.test/mcp' }), []);
	assert.deepStrictEqual(validateDraft({ name: 'a.b-c_d', transport: 'stdio', command: 'node' }), []);
});

test('a name is told what it may hold, as it is typed', () => {
	assert.ok(validateServerName('') !== undefined);
	assert.ok(validateServerName('has spaces') !== undefined);
	assert.ok(validateServerName('-leading') !== undefined);
	assert.ok(validateServerName('files') === undefined);
});

test('KEY=VALUE lines become the record they say, and nothing else', () => {
	const parsed = parseKeyValueLines(['TOKEN=abc', 'a.b=1', 'URL=https://x/?a=1', '', '   ']);

	assert.deepStrictEqual(parsed.values, { TOKEN: 'abc', 'a.b': '1', URL: 'https://x/?a=1' });
	assert.deepStrictEqual(parsed.malformed, []);
});

test('a line with no = or an empty key is reported, not guessed', () => {
	const parsed = parseKeyValueLines(['no equals', '=value', 'OK=yes']);

	assert.deepStrictEqual(parsed.values, { OK: 'yes' });
	assert.deepStrictEqual(parsed.malformed, ['no equals', '=value']);
});

test('adding a server keeps the file exactly as it was, plus that one entry', () => {
	const existing = {
		adapterNote: 'kept',
		mcpServers: {
			files: { command: 'node', args: ['old.js'], env: { TOKEN: 'abc' } },
			remote: { type: 'http', url: 'https://example.test/mcp' },
		},
	};

	const merged = mcpServersWithAdded(existing, {
		name: 'added',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', 'new'],
		env: { PORT: '3000' },
	});

	assert.strictEqual(merged.adapterNote, 'kept');
	assert.deepStrictEqual(merged.mcpServers, {
		files: { command: 'node', args: ['old.js'], env: { TOKEN: 'abc' } },
		remote: { type: 'http', url: 'https://example.test/mcp' },
		added: { command: 'npx', args: ['-y', 'new'], env: { PORT: '3000' } },
	});
});

test('the same name replaces the entry it names, and only that one', () => {
	const merged = mcpServersWithAdded(
		{ mcpServers: { files: { command: 'node', args: ['old.js'] } } },
		{ name: ' files ', transport: 'http', url: 'https://example.test/mcp' },
	);

	assert.deepStrictEqual(merged.mcpServers, { files: { type: 'http', url: 'https://example.test/mcp' } });
});

test('no file yet, or one that is not an object of servers, is an empty profile to add to', () => {
	const draft: AddServerDraft = { name: 'added', transport: 'stdio', command: 'npx' };

	assert.deepStrictEqual(mcpServersWithAdded(undefined, draft), { mcpServers: { added: { command: 'npx', args: [] } } });
	assert.deepStrictEqual(mcpServersWithAdded({ mcpServers: 'broken' }, draft), { mcpServers: { added: { command: 'npx', args: [] } } });
	assert.deepStrictEqual(serverNames(undefined), []);
	assert.deepStrictEqual(serverNames({ mcpServers: 'broken' }), []);
	assert.deepStrictEqual(serverNames({ mcpServers: { files: {}, remote: {} } }), ['files', 'remote']);
});

test('the text written is the file the section then lists, through the same reader', () => {
	const text = mcpServersTextWithAdded(undefined, {
		name: 'files',
		transport: 'stdio',
		command: 'node',
		args: ['server.js'],
		env: { TOKEN: 'abc' },
	});

	assert.ok(text.endsWith('\n'));
	assert.deepStrictEqual(JSON.parse(text), { mcpServers: { files: { command: 'node', args: ['server.js'], env: { TOKEN: 'abc' } } } });

	const read = mcpServersFrom([{ path: '/profile/mcp.json', text, source: 'user' }]);
	assert.deepStrictEqual(read.servers.map(server => server.label), ['files']);
	const server = read.servers[0];
	assert.deepStrictEqual(server.kind === 'stdio' ? server.env : {}, { TOKEN: 'abc' });
});

test('the same is true for a remote server, headers and all', () => {
	const text = mcpServersTextWithAdded(undefined, {
		name: 'remote',
		transport: 'http',
		url: 'https://example.test/mcp',
		headers: { Authorization: 'Bearer k' },
	});

	const read = mcpServersFrom([{ path: '/profile/mcp.json', text, source: 'user' }]);
	const server = read.servers[0];
	assert.strictEqual(server.kind, 'http');
	assert.deepStrictEqual(server.kind === 'http' ? server.headers : {}, { Authorization: 'Bearer k' });
});

test('a server added here survives the settings row rewriting its own servers', () => {
	const text = mcpServersTextWithAdded(undefined, { name: 'added', transport: 'stdio', command: 'npx' });
	const rowServer: McpServerSetting = { name: 'row', transport: 'stdio', target: 'node', args: '', key: '' };

	const afterRow = mcpServersFile(JSON.parse(text), [rowServer]);

	assert.deepStrictEqual(afterRow.mcpServers, {
		row: { command: 'node', args: [] },
		added: { command: 'npx', args: [] },
	});
});
