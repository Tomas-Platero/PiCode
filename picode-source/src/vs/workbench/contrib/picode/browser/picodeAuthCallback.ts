/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor side of the one-time-code sign-in contract, as pure logic.
 *
 * The editor hands the web app a `picode://auth/callback?flow=editor` address; after sign-in
 * the page ends with `window.location.assign(`${callback}&code=…`)`, so the OS delivers
 * `picode://auth/callback?flow=editor&code=<code>` to whatever installation currently owns
 * the `picode` protocol handler (registered in
 * `src/vs/platform/url/electron-main/electronUrlListener.ts`). This file holds the one piece
 * of that contract that must be exact — which URIs the sign-in handler claims, and the code
 * it extracts — kept free of editor imports so `node --test` can exercise it directly
 * (see `extensions/picode/test/picode-auth-callback.test.ts`).
 */

/** The path on the `picode` scheme that carries the sign-in callback. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * Returns the one-time code from a callback URI, or `undefined` when the URI is not the
 * editor's sign-in callback and must be left for another handler.
 *
 * The match is on scheme and path only — deliberately not on the query: the web app builds
 * its redirect by appending `&code=` to the callback we sent, so `flow=editor` travels along
 * but is not part of the contract, and unknown additional parameters must not break the
 * hand-off. A missing or empty `code` also yields `undefined`: without a code the URI cannot
 * complete a sign-in and claiming it would just swallow it.
 *
 * The query is parsed by hand, not with `URLSearchParams`, for one reason: by the time the
 * URI reaches the handler, `URI.parse` has already percent-decoded the query exactly once
 * (`uri.ts` percentDecodes every component). The web app encodes the code with
 * `encodeURIComponent`, so after that single decode the value is the literal code — running
 * `URLSearchParams` on top would apply a second layer of decoding and its `+`-means-space
 * rule, silently corrupting any code containing `+`. One decode happened upstream; this
 * splitter adds none. (Sign-in codes are base64url, so this is belt-and-braces, but the
 * matcher must not be the thing that corrupts a code.)
 */
export function oneTimeCodeFromCallback(
	uri: { readonly scheme: string; readonly path: string; readonly query: string },
	expectedScheme: string,
): string | undefined {
	if (uri.scheme.toLowerCase() !== expectedScheme.toLowerCase()) {
		return undefined;
	}
	if (uri.path !== AUTH_CALLBACK_PATH) {
		return undefined;
	}
	try {
		for (const pair of uri.query.split('&')) {
			const eq = pair.indexOf('=');
			if (eq !== -1 && pair.slice(0, eq) === 'code') {
				const value = pair.slice(eq + 1);
				return value ? value : undefined;
			}
		}
	} catch {
		// Splitting cannot throw on a string, but keep the promise: a malformed query
		// means "not our callback", never a crash.
	}
	return undefined;
}
