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
import { signInFromSetup, tryConsumeAccountCallback } from '../../../src/vs/code/electron-main/picodeAccountSignIn.ts';
import { AUTH_CALLBACK_PATH, oneTimeCodeFromCallback } from '../../../src/vs/workbench/contrib/picode/browser/picodeAuthCallback.ts';

const STATE = 'this-sign-in';

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
	const webRedirect = `${callback}&state=${STATE}&code=${encodeURIComponent('dG9rZW4-abc123')}`;

	const code = oneTimeCodeFromCallback(parseLikeEditor(webRedirect), 'picode', STATE);
	assert.strictEqual(code, 'dG9rZW4-abc123');
});

test('accepts the callback when only the state and the code came back', () => {
	// The matcher claims on scheme+path; the web only appends `&code=`, so a callback
	// without `flow=editor` (older editor, hand-built link) must still resolve.
	// The provider builds the callback without an authority, so the serialized URI has a
	// single slash (`picode:/auth/callback?…`) — the same shape the web page's validator
	// normalizes (`replace(/^\/{1,2}/, '')`). With two slashes the middle segment would be
	// an authority and the path would not match, which is exactly why the shape is fixed here.
	const code = oneTimeCodeFromCallback(parseLikeEditor(`picode:/auth/callback?state=${STATE}&code=abc`), 'picode', STATE);
	assert.strictEqual(code, 'abc');
});

test('decodes percent-encoded codes', () => {
	const webRedirect = `picode:/auth/callback?flow=editor&state=${STATE}&code=a%2Bb%2Fc%3D`;
	const code = oneTimeCodeFromCallback(parseLikeEditor(webRedirect), 'picode', STATE);
	assert.strictEqual(code, 'a+b/c=');
});

test('rejects another scheme (the browser could be pointed at a lookalike)', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor(`picode2://auth/callback?state=${STATE}&code=abc`), 'picode', STATE);
	assert.strictEqual(code, undefined);
});

test('rejects a different path on the right scheme', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor(`picode://other/path?state=${STATE}&code=abc`), 'picode', STATE);
	assert.strictEqual(code, undefined);
});

test('rejects the callback URL when no code came back', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor(`picode:/auth/callback?flow=editor&state=${STATE}`), 'picode', STATE);
	assert.strictEqual(code, undefined);
});

test('rejects an empty code', () => {
	const code = oneTimeCodeFromCallback(parseLikeEditor(`picode:/auth/callback?flow=editor&state=${STATE}&code=`), 'picode', STATE);
	assert.strictEqual(code, undefined);
});

test('rejects an unparseable query with undefined, not a throw', () => {
	const code = oneTimeCodeFromCallback({ scheme: 'picode', path: AUTH_CALLBACK_PATH, query: '%&=%%' }, 'picode', STATE);
	assert.strictEqual(code, undefined);
});

test('rejects a code that does not come back with the state of this sign-in', () => {
	assert.strictEqual(oneTimeCodeFromCallback(parseLikeEditor('picode:/auth/callback?code=attacker'), 'picode', STATE), undefined);
	assert.strictEqual(oneTimeCodeFromCallback(parseLikeEditor('picode:/auth/callback?state=other&code=attacker'), 'picode', STATE), undefined);
});

/** Runs the setup window's sign-in up to the browser, answering the exchange with a canned token. */
async function setupSignIn(): Promise<{ state: string; exchanged: string[]; finished: ReturnType<typeof signInFromSetup> }> {
	const exchanged: string[] = [];
	globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
		exchanged.push(JSON.parse(init.body).code);
		return new Response(JSON.stringify({ customToken: 'not.a.token', plan: 'free' }), { status: 200 });
	}) as typeof fetch;
	let opened = '';
	const finished = signInFromSetup({
		webOrigin: 'https://web.test',
		openExternal: async url => { opened = url; },
		registerProtocol: () => true,
		log: () => undefined,
	});
	const callback = new URL(new URL(opened).searchParams.get('callback')!);
	return { state: callback.searchParams.get('state')!, exchanged, finished };
}

test('the setup sign-in ignores a forged callback and finishes with its own', async () => {
	const { state, exchanged, finished } = await setupSignIn();
	assert.ok(state.length >= 32, 'every sign-in sends an unguessable state');

	assert.strictEqual(tryConsumeAccountCallback('picode://auth/callback?flow=editor&code=attacker'), true, 'a forged link opens no window');
	assert.strictEqual(tryConsumeAccountCallback('picode://auth/callback?state=wrong&code=attacker'), true);

	assert.strictEqual(tryConsumeAccountCallback(`picode://auth/callback?flow=editor&state=${state}&code=real`), true);
	const result = await finished;
	assert.strictEqual(result.ok, true);
	assert.deepStrictEqual(exchanged, ['real']);
});

test('a callback with no sign-in waiting is not kept for the next one', async () => {
	assert.strictEqual(tryConsumeAccountCallback('picode://auth/callback?code=planted'), false, 'the setup window has nothing to claim');

	const { state, exchanged, finished } = await setupSignIn();
	assert.deepStrictEqual(exchanged, [], 'the planted code is never exchanged');
	tryConsumeAccountCallback(`picode://auth/callback?state=${state}&code=real`);
	await finished;
	assert.deepStrictEqual(exchanged, ['real']);
});
