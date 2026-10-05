/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The sign-in rule behind the MCP rows, run on its own.
 *
 * The fixtures are the shapes on disk in PiCode's own profile: `mcp.json` entries exactly as
 * `mcpServers.ts` writes them, and `mcp-auth.json` exactly as pi's OAuth store writes it. What
 * matters — that an `enabled` server pi cannot use does not read as usable, that one which
 * authenticates itself through its own headers still does, and that a profile that cannot be
 * read does not turn into a confident "On" — needs no editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { mcpServerStates, type McpServerStateRow } from '../src/mcp-provider.ts';

/** The profile's `mcp.json` servers record, as the status data reads it. */
function servers(entries: Record<string, unknown>): Record<string, unknown> {
	return entries;
}

function row(rows: readonly McpServerStateRow[], name: string): McpServerStateRow {
	const found = rows.find(entry => entry.name === name);
	assert.ok(found !== undefined, `no row for "${name}"`);
	return found;
}

/** The state a row shows, as one word for the assertions below. */
function stateOf(rows: readonly McpServerStateRow[], name: string): string {
	const entry = row(rows, name);
	if (!entry.on) {
		return 'off';
	}
	return entry.signIn ?? 'ok';
}

test('a url server with a stored sign-in is usable', () => {
	const stored = JSON.stringify({
		'mcp__atlassian_rovo_mcp|https://mcp.atlassian.com/v1/mcp/authv2': {
			tokens: { access_token: 'at', refresh_token: 'rt' },
		},
	});
	const rows = mcpServerStates(
		servers({ 'atlassian-rovo-mcp': { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2' } }),
		{ text: stored },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'atlassian-rovo-mcp'), 'ok');
});

test('a url server whose stored token expired needs a sign-in again', () => {
	const stored = JSON.stringify({
		'mcp__sentry|https://mcp.sentry.dev/mcp': {
			tokens: { access_token: 'at' },
			tokensExpireAt: 500,
		},
	});
	const rows = mcpServerStates(
		servers({ sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } }),
		{ text: stored },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'sentry'), 'needed');
});

test('a url server with no stored sign-in and no headers needs a sign-in', () => {
	const rows = mcpServerStates(
		servers({ vercel: { type: 'http', url: 'https://mcp.vercel.com' } }),
		{ text: undefined },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'vercel'), 'needed');
});

test('a url server with no stored sign-in but its own header authenticates itself', () => {
	// `github`, as this profile holds it: an `Authorization` header with pi's interpolation in
	// it, which pi fills in at use time. The header being there is the fact the row shows.
	const rows = mcpServerStates(
		servers({
			github: {
				type: 'http',
				url: 'https://api.githubcopilot.com/mcp/',
				headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
			},
		}),
		{ text: undefined },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'github'), 'ok');
});

test('a credentials file that is missing entirely still leaves the header server usable', () => {
	const rows = mcpServerStates(
		servers({
			github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } },
			vercel: { type: 'http', url: 'https://mcp.vercel.com' },
		}),
		{ text: undefined },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'github'), 'ok');
	assert.strictEqual(stateOf(rows, 'vercel'), 'needed');
});

test('a credentials file that is not JSON is the same fact as no stored sign-in', () => {
	const rows = mcpServerStates(
		servers({ vercel: { type: 'http', url: 'https://mcp.vercel.com' } }),
		{ text: '{ not json' },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'vercel'), 'needed');
});

test('a url server read under a profile whose sign-ins may not be looked at stays honest', () => {
	// The external pi's profile is off-limits, so whether it holds a sign-in is unknown —
	// the row must say so instead of defaulting to `On` or to `needs sign-in`.
	const rows = mcpServerStates(
		servers({ vercel: { type: 'http', url: 'https://mcp.vercel.com' } }),
		undefined,
		1000,
	);

	assert.strictEqual(stateOf(rows, 'vercel'), 'unknown');
});

test('a url server that authenticates itself is usable even when the sign-ins are off-limits', () => {
	const rows = mcpServerStates(
		servers({ github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } } }),
		undefined,
		1000,
	);

	assert.strictEqual(stateOf(rows, 'github'), 'ok');
});

test('a local server needs no sign-in', () => {
	const rows = mcpServerStates(
		servers({ codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } }),
		{ text: undefined },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'codegraph'), 'ok');
});

test('a switched-off server stays off, whatever its sign-in would be', () => {
	const rows = mcpServerStates(
		servers({ vercel: { type: 'http', url: 'https://mcp.vercel.com', enabled: false } }),
		{ text: undefined },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'vercel'), 'off');
	assert.strictEqual(row(rows, 'vercel').signIn, undefined);
});

test('the stored key is pi\'s own spelling of the name and the url', () => {
	// pi writes `mcp__<name with - → _>|<normalized url>`; the lookup must find it there.
	const stored = JSON.stringify({
		'mcp__my_server|https://mcp.example.com/v1': { tokens: { access_token: 'at' } },
	});
	const rows = mcpServerStates(
		servers({ 'my-server': { type: 'http', url: 'https://mcp.example.com/v1' } }),
		{ text: stored },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'my-server'), 'ok');
});

test('a url that cannot be parsed has no stored sign-in to find', () => {
	const rows = mcpServerStates(
		servers({ odd: { type: 'http', url: 'not a url' } }),
		{ text: '{}' },
		1000,
	);

	assert.strictEqual(stateOf(rows, 'odd'), 'needed');
});

test('every declared server keeps its row, in the order the file holds it', () => {
	const rows = mcpServerStates(
		servers({
			aikido: { command: 'node', args: ['aikido.js'] },
			'atlassian-rovo-mcp': { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2' },
			github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
			vercel: { type: 'http', url: 'https://mcp.vercel.com' },
		}),
		{ text: undefined },
		1000,
	);

	assert.deepStrictEqual(rows.map(entry => [entry.name, entry.on]), [
		['aikido', true],
		['atlassian-rovo-mcp', true],
		['github', true],
		['vercel', true],
	]);
});
