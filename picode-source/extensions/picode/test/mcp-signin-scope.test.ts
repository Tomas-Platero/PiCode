/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The scope that makes a sign-in durable, and the file edit that writes it, run on their own.
 *
 * The fixtures are the shapes pi keeps for `vercel` in this profile: a resource that advertises
 * `openid`, an authorization server that can also issue `offline_access`, and an entry in
 * `mcp.json` that asks for neither. What matters — that `offline_access` is added only when the
 * authorization server says it can issue it, that nothing already requested is dropped, and that
 * the write moves one field and leaves the rest of the file alone — needs no editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { offlineAccessScope, scopeTokens } from '../src/mcp-scopes.ts';
import { mcpServersFile, mcpServersTextWithOAuthScope, mergedServerEntry } from '../src/mcpServers.ts';

/** The discovery pi caches for one server, as `mcp-auth.json` holds it. */
function discovery(resourceScopes: readonly string[], authorizationServerScopes: readonly string[]): unknown {
	return {
		authorizationServerUrl: 'https://vercel.com',
		resourceMetadata: { resource: 'https://mcp.vercel.com/', scopes_supported: [...resourceScopes] },
		authorizationServerMetadata: { issuer: 'https://vercel.com', scopes_supported: [...authorizationServerScopes] },
	};
}

/** What `vercel` measured: the resource asks for `openid`, the server can also issue `offline_access`. */
const VERCEL = discovery(['openid'], ['openid', 'email', 'profile', 'offline_access']);

test('the scope tokens are the words of the list', () => {
	assert.deepStrictEqual(scopeTokens('openid  offline_access'), ['openid', 'offline_access']);
	assert.deepStrictEqual(scopeTokens({ scope: 'openid' }), []);
});

test('offline_access is added to what the resource advertises', () => {
	assert.strictEqual(offlineAccessScope(undefined, VERCEL), 'openid offline_access');
});

test('a scope the entry already asks for is kept, and nothing is duplicated', () => {
	assert.strictEqual(offlineAccessScope('openid email', VERCEL), 'openid email offline_access');
});

test('offline_access is not asked for a server that cannot issue it', () => {
	const asOnlyOpenid = discovery(['openid'], ['openid']);
	assert.strictEqual(offlineAccessScope(undefined, asOnlyOpenid), undefined);
});

test('nothing changes when offline_access is already requested', () => {
	assert.strictEqual(offlineAccessScope('openid offline_access', VERCEL), undefined);
});

test('no discovery is no decision', () => {
	assert.strictEqual(offlineAccessScope('openid', undefined), undefined);
	assert.strictEqual(offlineAccessScope('openid', 'not a record'), undefined);
	assert.strictEqual(offlineAccessScope('openid', { resourceMetadata: {} }), undefined);
});

test('without a scope that would be requested anyway, nothing is changed', () => {
	// Asking for `offline_access` alone would replace pi's own default with it.
	const answered = discovery([], ['offline_access']);
	assert.strictEqual(offlineAccessScope(undefined, answered), undefined);
});

test('a declared server keeps the keys the form does not express', () => {
	const previous = {
		type: 'http',
		url: 'https://mcp.vercel.com',
		oauth: { scope: 'openid offline_access' },
		enabled: false,
		exposure: 'codemode',
	};
	const merged = mergedServerEntry(previous, { type: 'http', url: 'https://mcp.vercel.com', oauth: {} });

	assert.deepStrictEqual(merged, {
		oauth: { scope: 'openid offline_access' },
		enabled: false,
		exposure: 'codemode',
		type: 'http',
		url: 'https://mcp.vercel.com',
	});
});

test('a declared server whose headers went away does not keep them', () => {
	const previous = { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer old' } };
	const merged = mergedServerEntry(previous, { type: 'http', url: 'https://example.test/mcp', oauth: {} });

	assert.strictEqual(merged['headers'], undefined);
});

test('writing a scope moves one field and leaves the rest of the file alone', () => {
	const file = {
		mcpServers: {
			vercel: { url: 'https://mcp.vercel.com' },
			github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } },
		},
		other: 'kept',
	};
	const text = mcpServersTextWithOAuthScope(file, 'vercel', 'openid offline_access');

	assert.ok(text !== undefined);
	assert.deepStrictEqual(JSON.parse(text), {
		mcpServers: {
			vercel: { url: 'https://mcp.vercel.com', oauth: { scope: 'openid offline_access' } },
			github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } },
		},
		other: 'kept',
	});
});

test('a scope write for a server the file does not hold is nothing', () => {
	assert.strictEqual(mcpServersTextWithOAuthScope({ mcpServers: {} }, 'vercel', 'openid offline_access'), undefined);
	assert.strictEqual(mcpServersTextWithOAuthScope(undefined, 'vercel', 'openid offline_access'), undefined);
});

test('the file the settings declare keeps a sign-in scope written beside it', () => {
	// The form writes `oauth: {}`; the sign-in repair puts `scope` in it, and every activation
	// rewrites the file — the scope has to survive that.
	const txt = mcpServersTextWithOAuthScope({ mcpServers: { vercel: { url: 'https://mcp.vercel.com' } } }, 'vercel', 'openid offline_access');
	const again = mcpServersFile(JSON.parse(txt as string), [{ name: 'vercel', transport: 'http', target: 'https://mcp.vercel.com', args: '', key: '' }]);

	assert.deepStrictEqual(again.mcpServers, {
		vercel: { oauth: { scope: 'openid offline_access' }, type: 'http', url: 'https://mcp.vercel.com' },
	});
});
