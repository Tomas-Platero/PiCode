/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The one scope that decides whether a sign-in is durable.
 *
 * A remote MCP server's sign-in is only as good as the credential pi stores for it. When the
 * authorization server hands over an access token and **no refresh token**, that credential cannot
 * be renewed, so the moment it expires the row is back to "Needs sign-in" — and a restart does not
 * help, because there is nothing to renew with. That is what this profile measured on `vercel`:
 * `scope: "openid"`, `expires_in: 3600`, and no `refresh_token` at all.
 *
 * `offline_access` is the OAuth scope that asks the authorization server for a refresh token. pi
 * does not request it on its own: it asks for the scopes the resource advertises
 * (`@earendil-works/pi-mcp/dist/oauth/discovery.js`), and a resource that did not list it is never
 * asked for it. The way to ask is pi's own server config — `oauth.scope` in `mcp.json`
 * (`McpOAuthConfig.scope`, "Scopes to request, separated by spaces") — which is what the sign-in
 * writes before it starts.
 *
 * The rule is deliberately narrow: add `offline_access` **only** when the authorization server's
 * metadata says it can issue it, and never drop a scope that would be requested anyway. Asking a
 * server for a scope it does not support is an `invalid_scope` error, and dropping one is a server
 * that cannot do its job; neither is worth a durable sign-in.
 *
 * No `vscode` import: this is a decision, and a decision can be exercised by running it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tokens of a space-separated scope list, ignoring what is not one. */
export function scopeTokens(scope: unknown): string[] {
	return typeof scope === 'string' ? scope.split(/\s+/).filter(token => token.length > 0) : [];
}

/** The strings of a `scopes_supported` list, ignoring what is not one. */
function advertisedScopes(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
		: [];
}

/** The scope that asks for a refresh token. */
const OFFLINE_ACCESS = 'offline_access';

/**
 * The scope a sign-in should ask for so what it stores can be renewed, or `undefined` when nothing
 * should change.
 *
 * `existingScope` is what the entry already asks for (pi's `oauth.scope`), if anything.
 * `discovery` is the metadata pi keeps for the server — `resourceMetadata` and
 * `authorizationServerMetadata`, the shape of both its cached `discovery` in `mcp-auth.json` and a
 * fresh `discoverOAuthServerInfo` answer. The result keeps every scope that would be requested
 * anyway — what the entry asked for, and what the resource advertises, which is pi's own default —
 * and appends `offline_access`, in that order and each once.
 */
export function offlineAccessScope(existingScope: unknown, discovery: unknown): string | undefined {
	if (!isRecord(discovery)) {
		return undefined;
	}
	const authorizationServer = isRecord(discovery['authorizationServerMetadata']) ? discovery['authorizationServerMetadata'] : undefined;
	if (authorizationServer === undefined || !advertisedScopes(authorizationServer['scopes_supported']).includes(OFFLINE_ACCESS)) {
		return undefined;
	}
	const resource = isRecord(discovery['resourceMetadata']) ? discovery['resourceMetadata'] : undefined;
	const base = [...new Set([...scopeTokens(existingScope), ...advertisedScopes(resource?.['scopes_supported'])])];
	// Nothing that would be requested anyway is known: asking for `offline_access` alone would
	// replace pi's own default with it, so the rule makes no change it cannot justify.
	if (base.length === 0 || base.includes(OFFLINE_ACCESS)) {
		return undefined;
	}
	return [...base, OFFLINE_ACCESS].join(' ');
}
