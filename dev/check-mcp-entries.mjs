#!/usr/bin/env node
/*
 * Checks that what the connector writes into pi's `mcp.json` is what pi's own MCP accepts.
 *
 * Why this exists: pi's own MCP refuses two spellings the old adapter used — `auth: "oauth"`
 * (`auth.provider must be a provider name`) and `oauth: false` (`oauth must be an object`) — and an
 * entry it refuses is **skipped**, which from the owner's side looks like a server that is
 * configured and does nothing. That happened, it was found by hand, and the point of this check is
 * that it cannot come back unnoticed: it runs the connector's own writers through pi's own
 * validator, so neither a refactor nor a new field can reintroduce a spelling pi rejects.
 *
 * It also proves the check itself is not vacuous: the two legacy spellings have to be **rejected**
 * by the validator it just loaded. If a future pi accepts them, this script says so instead of
 * passing quietly and meaning nothing.
 *
 * Usage: node dev/check-mcp-entries.mjs [--pack <dir>]
 *
 * Needs the pack (the pinned pi lives inside it, `PiCode-Win32-x64/resources/pi-runtime`) and Node's
 * type stripping for the `.ts` imports, which is why `dev/build.sh` runs before it in CI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const packFlag = args.indexOf('--pack');
const PACK = path.resolve(packFlag === -1 ? path.join(REPO, 'PiCode-Win32-x64') : args[packFlag + 1]);

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const VALIDATOR = path.join(PACK, 'resources', 'pi-runtime', 'node_modules', ...PI_PACKAGE.split('/'), 'dist', 'core', 'mcp-servers.js');
const CONNECTOR = path.join(REPO, 'picode-source', 'extensions', 'picode', 'src');

if (!fs.existsSync(VALIDATOR)) {
	process.stderr.write(`error: ${VALIDATOR} is missing. Build the editor first (./dev/build.sh), or point --pack at a pack.\n`);
	process.exit(1);
}

const { validateMcpServerConfig } = await import(pathToFileURL(VALIDATOR).href);
const { mcpServerEntry, normalizedServerEntry } = await import(pathToFileURL(path.join(CONNECTOR, 'mcpServers.ts')).href);
const { serverFileEntry } = await import(pathToFileURL(path.join(CONNECTOR, 'mcp-add.ts')).href);

/** The settings row, as the form fills it. */
const row = key => ({ name: 'vercel', transport: 'http', target: 'https://mcp.vercel.com', args: '', key });

/**
 * What the connector writes, and what pi has to say about it.
 *
 * `must` is the whole check: `accept` for every entry the connector produces, because an entry pi
 * refuses is a server the owner configured that will never run.
 */
const cases = [
	{ what: 'the settings row: a remote server with a token', entry: mcpServerEntry(row('tok_123')), must: 'accept' },
	{ what: 'the settings row: a remote server that signs in', entry: mcpServerEntry(row('')), must: 'accept' },
	{ what: 'the settings row: a local server', entry: mcpServerEntry({ name: 'files', transport: 'stdio', target: 'npx', args: '-y @modelcontextprotocol/server-filesystem .', key: '' }), must: 'accept' },
	{ what: 'Add Server: a remote server with no headers', entry: serverFileEntry({ name: 'vercel', transport: 'http', url: 'https://mcp.vercel.com' }), must: 'accept' },
	{ what: 'Add Server: a remote server with headers', entry: serverFileEntry({ name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } }), must: 'accept' },
	{ what: 'Add Server: a local server with an environment', entry: serverFileEntry({ name: 'tools', transport: 'stdio', command: 'uvx', args: ['tools-mcp'], env: { API_KEY: '${TOOLS_KEY}' } }), must: 'accept' },
	{ what: 'the repair: a legacy entry that asked for OAuth', entry: normalizedServerEntry({ type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2', auth: 'oauth', oauth: {} }), must: 'accept' },
	{ what: 'the repair: a legacy entry with only `auth`', entry: normalizedServerEntry({ url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' }), must: 'accept' },
	{ what: 'the repair: a legacy entry that refused OAuth', entry: normalizedServerEntry({ url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t' }, auth: false, oauth: false }), must: 'accept' },
	{ what: 'a repair leaves a provider token alone', entry: normalizedServerEntry({ url: 'https://example.test/mcp', auth: { provider: 'vercel' } }), must: 'accept' },
	// The positive control: if the validator accepted these, everything above would pass for the
	// wrong reason and this check would be worth nothing.
	{ what: 'control: the legacy `auth: \"oauth\"` pi refuses', entry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', oauth: {} }, must: 'reject' },
	{ what: 'control: the legacy `oauth: false` pi refuses', entry: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t' }, auth: false, oauth: false }, must: 'reject' },
];

let failed = 0;
for (const { what, entry, must } of cases) {
	const verdict = validateMcpServerConfig('check', entry);
	const rejected = typeof verdict === 'string';
	const ok = must === 'reject' ? rejected : !rejected;
	if (!ok) {
		failed += 1;
	}
	const said = rejected ? `pi refuses it: ${verdict}` : 'pi accepts it';
	process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${what} — ${said}\n`);
	if (ok) {
		process.stdout.write(`      ${JSON.stringify(entry)}\n`);
	}
}

process.stdout.write(failed === 0
	? `\n${cases.length} entries checked against ${PI_PACKAGE}'s own validator: all as expected.\n`
	: `\n${failed} of ${cases.length} entries are not what pi expects.\n`);
process.exit(failed === 0 ? 0 : 1);
