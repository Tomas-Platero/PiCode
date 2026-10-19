/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The sign-in callback match, run on its own.
 *
 * The cloud sign-in contract is: the editor opens
 * `{webOrigin}/auth/editor?callback=<encoded picode://auth/callback?flow=editor>`, the user
 * signs in there, and the page ends with `window.location.assign(`${callback}&code=…`)` —
 * so the OS hands the editor exactly `picode://auth/callback?flow=editor&code=<code>` through
 * the `picode` protocol handler. That hand-off only works while the protocol is registered by
 * a living installation (this broke once: an uninstalled beta still owned the registry entry,
 * so the browser redirect launched a dead exe and the editor saw nothing, logged nothing).
 *
 * `oneTimeCodeFromCallback` is the matcher the provider's URL handler uses to claim the
 * callback; it is pure (no editor imports) so `node --test` can run it directly.
 *
 * The parsed shape used below (`scheme`/`path`/`query`) is exactly what the core's
 * `URI.parse` produces for the callback URL; `new URL` reads the same fields off the string.
 */

import assert from 'assert';
import { test } from 'node:test';
import { AUTH_CALLBACK_PATH, oneTimeCodeFromCallback } from '../../../src/vs/workbench/contrib/picode/browser/picodeAuthCallback.ts';

/**
 * What the core's `URI.parse` yields for the string the web page assigns: it lowercases the
 * scheme and percent-decodes the query exactly once, so `code=a%2Bb` arrives as `a+b`.
 */
function parseLikeEditor(url: string): { scheme: string; path: string; query: string } {
	const parsed = new URL(url);
	const rawQuery = parsed.search.replace(/^\?/, '');
	let query: string;
	try {
		query = decodeURIComponent(rawQuery);
	} catch {
		query = rawQuery;
	}
	return {
		scheme: parsed.protocol.replace(/:$/, ''),
		path: parsed.pathname,
		query,
	};
}

test('accepts the exact URL the web page calls back with', () => {
	const callback = `picode:${AUTH_CALLBACK_PATH}?flow=editor`;
	const webRedirect = `${callback}&code=${encodeURIComponent('dG9rZW4-abc123')}`;

	const code = oneTimeCodeFromCallback(parseLikeEditor(webRedirect), 'picode');
	assert.strictEqual(code, 'dG9rZW4-abc123');
});

test('accepts the callback even when the flow marker query is absent', () => {
	// The matcher claims on scheme+path; the web only appends `&code=`, so a callback
	// without `flow=editor` (older editor, hand-built link) must still resolve.
	// The provider builds the callback without an authority, so the serialized URI has a
	// single slash (`picode:/auth/callback?…`) — the same shape the web page's validator
	// normalizes (`replace(/^\/{1,2}/, '')`). With two slashes the middle segment would be
	// an authority and the path would not match, which is exactly why the shape is fixed here.
	const code = oneTimeCodeFromCallback(parseLikeEditor('picode:/auth/callback?code=abc'), 'picode');
	assert.strictEqual(code, 'abc');
});

test('decodes percent-encoded codes', () => {
	const webRedirect = 'picode:/auth/callback?flow=editor&code=a%2Bb%2Fc%3D';
	const code = oneTimeCodeFromCallback(parseLikeEditor(webRedirect), 'picode');
	assert.strictEqual(code, 'a+b/c=');
});

test('rejects another scheme (the browser could be pointed at a lookalike)', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor('picode2://auth/callback?code=abc'), 'picode');
	assert.strictEqual(code, undefined);
});

test('rejects a different path on the right scheme', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor('picode://other/path?code=abc'), 'picode');
	assert.strictEqual(code, undefined);
});

test('rejects the callback URL when no code came back', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor('picode:/auth/callback?flow=editor'), 'picode');
	assert.strictEqual(code, undefined);
});

test('rejects an empty code', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor('picode:/auth/callback?flow=editor&code='), 'picode');
	assert.strictEqual(code, undefined);
});

test('rejects an unparseable query with undefined, not a throw', () => {
	const code = oneTimeCodeFromCallback({ scheme: 'picode', path: AUTH_CALLBACK_PATH, query: '%&=%%' }, 'picode');
	assert.strictEqual(code, undefined);
});
