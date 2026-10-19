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
	mcpServersTextWithEdited,
	mcpServersTextWithRemoved,
	mcpServersTextWithToggled,
	mcpServersWithAdded,
	mcpServersWithEdited,
	mcpServersWithRemoved,
	parseKeyValueLines,
	serverEntry,
	serverFileEntry,
	serverNames,
	validateDraft,
	validateServerName,
	type AddServerDraft,
} from '../src/mcp-add.ts';
import { mcpServerEntry, mcpServersFile, normalizedServerEntry, normalizedServersFile, type McpServerSetting } from '../src/mcpServers.ts';
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

test('a remote server with no headers is written to sign in, in the shape both readers take', () => {
	assert.deepStrictEqual(
		serverFileEntry({ name: 'remote', transport: 'http', url: 'https://example.test/mcp' }),
		{ type: 'http', url: 'https://example.test/mcp', oauth: {} },
	);
});

// The settings row and the Add Server flow must agree on the shape: one entry has to be read by
// pi's own MCP and by the adapter the owner may still have installed. `auth: "oauth"` is the
// spelling pi refuses, and `oauth: {}` is the one both understand.
test('the settings row writes a remote server the same way, token or sign-in', () => {
	const row = (key: string): McpServerSetting => ({ name: 'remote', transport: 'http', target: 'https://example.test/mcp', args: '', key });

	assert.deepStrictEqual(mcpServerEntry(row('')), { type: 'http', url: 'https://example.test/mcp', oauth: {} });
	assert.deepStrictEqual(mcpServerEntry(row(' tok ')), { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer tok' } });
});

test('an entry written for the old adapter is repaired, and one already in shape is left alone', () => {
	assert.deepStrictEqual(
		normalizedServerEntry({ type: 'http', url: 'https://a.test/mcp', auth: 'oauth', oauth: {} }),
		{ type: 'http', url: 'https://a.test/mcp', oauth: {} },
	);
	assert.deepStrictEqual(
		normalizedServerEntry({ url: 'https://a.test/mcp', auth: 'oauth' }),
		{ url: 'https://a.test/mcp', oauth: {} },
	);
	assert.deepStrictEqual(
		normalizedServerEntry({ url: 'https://a.test/mcp', headers: { Authorization: 'Bearer t' }, auth: false, oauth: false }),
		{ url: 'https://a.test/mcp', headers: { Authorization: 'Bearer t' } },
	);
	assert.deepStrictEqual(
		normalizedServerEntry({ url: 'https://a.test/mcp', auth: { provider: 'vercel' } }),
		{ url: 'https://a.test/mcp', auth: { provider: 'vercel' } },
	);
});

test('everything else in the file survives the repair untouched', () => {
	const file = {
		settings: { autoAuth: false, toolPrefix: 'short' },
		mcpServers: {
			legacy: { type: 'http', url: 'https://a.test/mcp', auth: 'oauth', oauth: {}, lifecycle: 'lazy' },
			broken: 'not an object',
			kept: { command: 'node', args: ['x.js'], directTools: false },
		},
	};

	assert.deepStrictEqual(normalizedServersFile(file), {
		settings: { autoAuth: false, toolPrefix: 'short' },
		mcpServers: {
			legacy: { type: 'http', url: 'https://a.test/mcp', oauth: {}, lifecycle: 'lazy' },
			broken: 'not an object',
			kept: { command: 'node', args: ['x.js'], directTools: false },
		},
	});
	assert.deepStrictEqual(normalizedServersFile({ mcpServers: 'broken' }), { mcpServers: 'broken' });
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
	assert.deepStrictEqual(validateDraft({ name: 'a-b_c', transport: 'stdio', command: 'node' }), []);
});

test('a name is told what it may hold, as it is typed', () => {
	assert.ok(validateServerName('') !== undefined);
	assert.ok(validateServerName('has spaces') !== undefined);
	assert.ok(validateServerName('-leading') !== undefined);
	assert.ok(validateServerName('files') === undefined);
});

// pi's own MCP validates server names with `^[A-Za-z0-9_-]+$` and refuses the rest, so a dot that
// got written would be a server listed in the file that never connects. Left as its own test
// because the reason is not the shape of a name, it is who reads the file.
test('a name with a dot is refused: pi would never start that server', () => {
	assert.ok(validateServerName('my.server') !== undefined);
	assert.deepStrictEqual(validateDraft({ name: 'my.server', transport: 'http', url: 'https://example.test/mcp' }), [
		'A name holds letters, digits, dashes and underscores, and starts with a letter or a digit.',
	]);
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

	assert.deepStrictEqual(merged.mcpServers, { files: { type: 'http', url: 'https://example.test/mcp', oauth: {} } });
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

test('the entry a file holds for one server can be read back to prefill an edit', () => {
	const existing = {
		mcpServers: {
			files: { command: 'node', args: ['server.js'], env: { TOKEN: 'abc' } },
			remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer k' } },
		},
	};

	assert.deepStrictEqual(serverEntry(existing, 'files'), { command: 'node', args: ['server.js'], env: { TOKEN: 'abc' } });
	assert.deepStrictEqual(serverEntry(existing, 'remote'), { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer k' } });
});

test('a server the file does not hold, or an entry that is no server at all, reads as none', () => {
	assert.strictEqual(serverEntry(undefined, 'files'), undefined);
	assert.strictEqual(serverEntry({ mcpServers: 'broken' }, 'files'), undefined);
	assert.strictEqual(serverEntry({ mcpServers: { files: {} } }, 'remote'), undefined);
	assert.strictEqual(serverEntry({ mcpServers: { junk: 'not an object' } }, 'junk'), undefined);
});

test('editing a server replaces exactly its entry, and everything else survives untouched', () => {
	const existing = {
		adapterNote: 'kept',
		mcpServers: {
			files: { command: 'node', args: ['old.js'], env: { TOKEN: 'abc' } },
			remote: { type: 'http', url: 'https://example.test/mcp' },
		},
	};

	const edited = mcpServersWithEdited(existing, 'remote', { type: 'http', url: 'https://other.example/mcp', headers: { Authorization: 'Bearer new' } });

	assert.ok(edited !== undefined);
	assert.strictEqual(edited.adapterNote, 'kept');
	assert.deepStrictEqual(edited.mcpServers, {
		files: { command: 'node', args: ['old.js'], env: { TOKEN: 'abc' } },
		remote: { type: 'http', url: 'https://other.example/mcp', headers: { Authorization: 'Bearer new' } },
	});

	const text = mcpServersTextWithEdited(existing, 'remote', { type: 'http', url: 'https://other.example/mcp' });
	assert.ok(text !== undefined && text.endsWith('\n'));
	const read = mcpServersFrom([{ path: '/profile/mcp.json', text, source: 'user' }]);
	assert.deepStrictEqual(read.servers.map(server => server.label), ['files', 'remote']);
	const remote = read.servers.find(server => server.label === 'remote');
	assert.ok(remote !== undefined && remote.kind === 'http');
	assert.strictEqual(remote.kind === 'http' ? remote.url : '', 'https://other.example/mcp');
});

test('editing a server the file does not hold is said, not written', () => {
	const existing = { mcpServers: { files: { command: 'node', args: [] } } };

	assert.strictEqual(mcpServersWithEdited(existing, 'remote', { type: 'http', url: 'https://example.test/mcp' }), undefined);
	assert.strictEqual(mcpServersTextWithEdited(existing, 'remote', { type: 'http', url: 'https://example.test/mcp' }), undefined);
	assert.strictEqual(mcpServersTextWithEdited(undefined, 'remote', { type: 'http', url: 'https://example.test/mcp' }), undefined);
});

test('removing a server removes exactly its entry, and everything else survives untouched', () => {
	const existing = {
		adapterNote: 'kept',
		mcpServers: {
			files: { command: 'node', args: ['old.js'], env: { TOKEN: 'abc' } },
			remote: { type: 'http', url: 'https://example.test/mcp' },
		},
	};

	const removed = mcpServersWithRemoved(existing, 'remote');

	assert.ok(removed !== undefined);
	assert.strictEqual(removed.adapterNote, 'kept');
	assert.deepStrictEqual(removed.mcpServers, { files: { command: 'node', args: ['old.js'], env: { TOKEN: 'abc' } } });

	const text = mcpServersTextWithRemoved(existing, 'remote');
	assert.ok(text !== undefined && text.endsWith('\n'));
	const read = mcpServersFrom([{ path: '/profile/mcp.json', text, source: 'user' }]);
	assert.deepStrictEqual(read.servers.map(server => server.label), ['files']);
});

test('removing a server the file does not hold is said, not written', () => {
	const existing = { mcpServers: { files: { command: 'node', args: [] } } };

	assert.strictEqual(mcpServersWithRemoved(existing, 'remote'), undefined);
	assert.strictEqual(mcpServersTextWithRemoved(existing, 'remote'), undefined);
	assert.strictEqual(mcpServersTextWithRemoved(undefined, 'remote'), undefined);
});

// pi's own switch, and the one the status panel's rows flip: off writes `enabled: false`, on removes
// the key (pi's default is on, and a file that says only what it means stays readable). Everything else
// — the rest of the entry, the rest of the file — is untouched in both directions.
test('the switch flips both ways and leaves everything else exactly as it was', () => {
	const existing = {
		settings: { toolPrefix: 'short' },
		mcpServers: { vercel: { type: 'http', url: 'https://mcp.vercel.com', headers: { Authorization: 'Bearer t' } } },
	};

	const off = mcpServersTextWithToggled(existing, 'vercel');
	assert.ok(off !== undefined);
	assert.strictEqual(off.on, false);
	assert.deepStrictEqual(JSON.parse(off.text), {
		settings: { toolPrefix: 'short' },
		mcpServers: { vercel: { type: 'http', url: 'https://mcp.vercel.com', headers: { Authorization: 'Bearer t' }, enabled: false } },
	});

	const backOn = mcpServersTextWithToggled(JSON.parse(off.text), 'vercel');
	assert.ok(backOn !== undefined);
	assert.strictEqual(backOn.on, true);
	assert.deepStrictEqual(JSON.parse(backOn.text), existing);
});

test('switching a name the file does not hold, or an entry it cannot read, is said not written', () => {
	assert.strictEqual(mcpServersTextWithToggled({ mcpServers: { other: {} } }, 'vercel'), undefined);
	assert.strictEqual(mcpServersTextWithToggled({ mcpServers: { vercel: 'broken' } }, 'vercel'), undefined);
	assert.strictEqual(mcpServersTextWithToggled(undefined, 'vercel'), undefined);
});
