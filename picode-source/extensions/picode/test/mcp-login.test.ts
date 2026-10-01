/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Signing in to pi's MCP servers, run on its own.
 *
 * The output used here is pi's own: the address it prints on its own line after `Sign in to MCP
 * server "<name>" in your browser:` and the sentence it ends with. What matters — that the command
 * is pi's and not a second OAuth implementation of ours, that the address survives being read, and
 * that a failure repeats the last thing pi said — needs no editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { authorizationUrlIn, lastLineOf, loginArguments, loginTarget } from '../src/mcp-login.ts';

test('the sign-in is pi\'s own command, with the server it was handed', () => {
	assert.deepStrictEqual(loginArguments('sentry'), ['mcp', 'login', 'sentry']);
});

test('a server name is trimmed, and a name that is not one reads as empty', () => {
	assert.strictEqual(loginTarget(' sentry '), 'sentry');
	assert.strictEqual(loginTarget(''), '');
	assert.strictEqual(loginTarget(undefined), '');
});

test('the address pi printed is read, on the line it printed it', () => {
	const output = 'Sign in to MCP server "sentry" in your browser:\nhttps://mcp.sentry.dev/oauth/authorize?client_id=abc&state=xyz\n';

	assert.strictEqual(authorizationUrlIn(output), 'https://mcp.sentry.dev/oauth/authorize?client_id=abc&state=xyz');
});

test('an address wrapped in a sentence keeps only the address', () => {
	assert.strictEqual(authorizationUrlIn('Open it: (https://example.test/callback?code=1).'), 'https://example.test/callback?code=1');
});

test('output with no address reads as none, rather than as the first word', () => {
	assert.strictEqual(authorizationUrlIn('Signed in to MCP server "sentry" (12 tools).\n'), undefined);
	assert.strictEqual(authorizationUrlIn(''), undefined);
});

test("a failure repeats the last thing pi said, cut to a notification's length", () => {
	assert.strictEqual(lastLineOf('connecting\nerror: Sign-in to MCP server "sentry" failed: no browser\n'), 'error: Sign-in to MCP server "sentry" failed: no browser');
	assert.strictEqual(lastLineOf('   \n\n'), undefined);
	assert.strictEqual(lastLineOf('x'.repeat(300))?.length, 201);
});
