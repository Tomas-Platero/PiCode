/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor side of connecting GitHub and Jira, as pure logic (`node --test` runs it directly:
 * `extensions/picode/test/picode-connector-auth.test.ts`).
 *
 * - GitHub uses the one-time-code ("device") flow: no secret is needed to start it.
 * - Jira uses the browser flow. Atlassian demands a client secret, so PiCode's server holds it:
 *   the browser comes back to the server, which hands the editor a `picode://` address carrying
 *   the code; the editor trades that code for tokens through the server.
 *
 * Any web page can open a `picode://` address, so a code alone proves nothing: the callback is
 * claimed only when it carries the `state` this attempt generated (same rule as the sign-in, ADR-040).
 */

export type PicodeConnectorService = 'github' | 'atlassian';

/** The path on the `picode` scheme that carries a connector callback. */
export const CONNECT_CALLBACK_PATH = '/connect/callback';

/** What is kept (encrypted) for a connected service. */
export interface IPicodeConnectorTokens {
	readonly accessToken: string;
	readonly refreshToken?: string;
	/** Milliseconds since the epoch; absent when the token does not expire. */
	readonly expiresAt?: number;
	/** Jira only: the account also allowed PiCode to move issues between statuses. */
	readonly canWrite?: boolean;
	/** Jira only: the account also allowed PiCode to read boards, so the viewer can show the same columns as Jira. */
	readonly canReadBoards?: boolean;
	/** Jira only: the site the account chose. */
	readonly site?: { readonly cloudId: string; readonly url: string; readonly name: string };
}

/** Refresh a little early, so a request never leaves with a token that dies on the way. */
const EXPIRY_MARGIN_MS = 60_000;

export function needsRefresh(tokens: IPicodeConnectorTokens, now: number): boolean {
	return tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_MARGIN_MS <= now;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface IPicodeDeviceCode {
	readonly deviceCode: string;
	/** What the person types on the GitHub page. */
	readonly userCode: string;
	readonly verificationUri: string;
	readonly intervalMs: number;
	readonly expiresInMs: number;
}

/** GitHub's answer to "give me a code": the shape is checked, and the page must be GitHub's own. */
export function parseDeviceCode(json: unknown): IPicodeDeviceCode | undefined {
	const data = asRecord(json);
	if (!data || typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || typeof data.verification_uri !== 'string') {
		return undefined;
	}
	if (!data.verification_uri.startsWith('https://github.com/')) {
		return undefined;
	}
	const interval = typeof data.interval === 'number' && data.interval > 0 ? data.interval : 5;
	const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 900;
	return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri, intervalMs: interval * 1000, expiresInMs: expiresIn * 1000 };
}

export type PicodeDevicePoll =
	| { readonly kind: 'tokens'; readonly tokens: IPicodeConnectorTokens }
	| { readonly kind: 'pending' }
	| { readonly kind: 'slowDown'; readonly intervalMs: number | undefined }
	| { readonly kind: 'denied' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'failed' };

/** GitHub answers 200 for every state of the wait; the state is in the body. */
export function parseDevicePoll(json: unknown, now: number): PicodeDevicePoll {
	const data = asRecord(json);
	if (!data) {
		return { kind: 'failed' };
	}
	if (typeof data.access_token === 'string' && data.access_token.length > 0) {
		return { kind: 'tokens', tokens: tokensFromResponse(data, now) };
	}
	switch (data.error) {
		case 'authorization_pending': return { kind: 'pending' };
		case 'slow_down': return { kind: 'slowDown', intervalMs: typeof data.interval === 'number' ? data.interval * 1000 : undefined };
		case 'access_denied': return { kind: 'denied' };
		case 'expired_token': return { kind: 'expired' };
		default: return { kind: 'failed' };
	}
}

/** The token answer of GitHub (`snake_case`) and of PiCode's server (`camelCase`) both end up here. */
export function tokensFromResponse(data: Record<string, unknown>, now: number): IPicodeConnectorTokens {
	const access = data.access_token ?? data.accessToken;
	const refresh = data.refresh_token ?? data.refreshToken;
	const expires = data.expires_in ?? data.expiresIn;
	return {
		accessToken: typeof access === 'string' ? access : '',
		refreshToken: typeof refresh === 'string' && refresh.length > 0 ? refresh : undefined,
		expiresAt: typeof expires === 'number' && expires > 0 ? now + expires * 1000 : undefined,
	};
}

/**
 * The code in a connector callback, or `undefined` when the address is not the one this attempt is
 * waiting for. The query is read by hand for the reason given in `picodeAuthCallback.ts`: the URI
 * was already percent-decoded once on the way in.
 */
export function connectorCodeFromCallback(
	uri: { readonly scheme: string; readonly authority?: string; readonly path: string; readonly query: string },
	expectedScheme: string,
	service: PicodeConnectorService,
	expectedState: string,
): string | undefined {
	// The cloud page sends `scheme://connect/callback`: `connect` arrives as the authority and `/callback` as the path.
	const isConnectAddress = uri.path === CONNECT_CALLBACK_PATH || (uri.authority === 'connect' && uri.path === '/callback');
	if (uri.scheme.toLowerCase() !== expectedScheme.toLowerCase() || !isConnectAddress || expectedState.length === 0) {
		return undefined;
	}
	let code: string | undefined;
	let state: string | undefined;
	let from: string | undefined;
	for (const pair of uri.query.split('&')) {
		const eq = pair.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const name = pair.slice(0, eq);
		const value = pair.slice(eq + 1);
		if (name === 'code') {
			code ??= value;
		} else if (name === 'state') {
			state ??= value;
		} else if (name === 'service') {
			from ??= value;
		}
	}
	return code && state === expectedState && from === service ? code : undefined;
}

/** What reading a board's columns needs (Atlassian's own list for `GET /board` and `GET /board/{id}/configuration`). */
const BOARD_SCOPES = ['read:board-scope:jira-software', 'read:board-scope.admin:jira-software', 'read:project:jira'];

/** The page Atlassian shows the person: where to ask for permission, and for what. `write` adds moving issues between statuses; `boards` adds reading the board's columns. */
export function atlassianAuthorizeUrl(clientId: string, redirectUri: string, state: string, extra: { readonly write?: boolean; readonly boards?: boolean } = {}): string {
	const query = [
		['audience', 'api.atlassian.com'],
		['client_id', clientId],
		['scope', ['read:jira-work', ...(extra.boards ? BOARD_SCOPES : []), ...(extra.write ? ['write:jira-work'] : []), 'offline_access'].join(' ')],
		['redirect_uri', redirectUri],
		['state', state],
		['response_type', 'code'],
		['prompt', 'consent'],
	].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
	return `https://auth.atlassian.com/authorize?${query}`;
}

/** One Atlassian site the account can reach, from `GET /oauth/token/accessible-resources`. */
export interface IPicodeAtlassianSite {
	readonly cloudId: string;
	readonly url: string;
	readonly name: string;
}

/** Only sites that can read Jira, and only plain `https` hosts (the address is later put in a link). */
export function parseAtlassianSites(json: unknown): IPicodeAtlassianSite[] {
	if (!Array.isArray(json)) {
		return [];
	}
	const sites: IPicodeAtlassianSite[] = [];
	for (const item of json) {
		const site = asRecord(item);
		if (!site || typeof site.id !== 'string' || typeof site.url !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+$/.test(site.url)) {
			continue;
		}
		const scopes = Array.isArray(site.scopes) ? site.scopes : [];
		if (scopes.length > 0 && !scopes.includes('read:jira-work')) {
			continue;
		}
		sites.push({ cloudId: site.id, url: site.url, name: typeof site.name === 'string' ? site.name : site.url });
	}
	return sites;
}
