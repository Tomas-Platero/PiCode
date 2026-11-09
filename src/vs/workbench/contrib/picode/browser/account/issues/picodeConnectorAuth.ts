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
 *   the browser comes back to the server, the person confirms the account there and the server
 *   trades the code. The editor only asks how the attempt is going, so it never sees the code and
 *   does not depend on the browser opening a `picode://` address.
 *
 * The tokens stay on the server, sealed. The editor never holds one: it asks the server to make each
 * call, and the server checks the plan every time. That is what makes the issues a Pro feature for
 * real, since anything kept on this computer could be read or changed.
 */

export type PicodeConnectorService = 'github' | 'atlassian';

/** What the editor remembers about a connection: no secret, only what decides what the screen offers. */
export interface IPicodeConnection {
	/** Jira only: the account also allowed PiCode to move issues between statuses. */
	readonly canWrite?: boolean;
	/** Jira only: the account also allowed PiCode to read boards, so the viewer can show the same columns as Jira. */
	readonly canReadBoards?: boolean;
	/** Jira only: the account also allowed PiCode to look people up, to give an issue to someone or name a reporter. */
	readonly canSearchUsers?: boolean;
	/** Jira only: the site the account chose. */
	readonly site?: { readonly cloudId: string; readonly url: string; readonly name: string };
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
	| { readonly kind: 'connected' }
	| { readonly kind: 'pending' }
	| { readonly kind: 'slowDown'; readonly intervalMs: number | undefined }
	| { readonly kind: 'denied' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'failed' };

/** GitHub answers 200 for every state of the wait; the state is in the body. */
export function parseDevicePoll(json: unknown): PicodeDevicePoll {
	const data = asRecord(json);
	if (!data) {
		return { kind: 'failed' };
	}
	if (data.connected === true) {
		return { kind: 'connected' };
	}
	switch (data.error) {
		case 'authorization_pending': return { kind: 'pending' };
		case 'slow_down': return { kind: 'slowDown', intervalMs: typeof data.interval === 'number' ? data.interval * 1000 : undefined };
		case 'access_denied': return { kind: 'denied' };
		case 'expired_token': return { kind: 'expired' };
		default: return { kind: 'failed' };
	}
}

/** The `state` the server opened a Jira attempt with; it is sent to Atlassian as it is. */
export function readAtlassianAttemptState(json: unknown): string | undefined {
	const state = asRecord(json)?.state;
	return typeof state === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(state) ? state : undefined;
}

export type PicodeAtlassianAttempt = 'waiting' | 'connected' | 'failed' | 'notPro' | 'expired';

/** How the server says a Jira attempt is going. An answer it does not give counts as still waiting: only the server ends an attempt. */
export function readAtlassianAttemptStatus(json: unknown): PicodeAtlassianAttempt {
	switch (asRecord(json)?.status) {
		case 'connected': return 'connected';
		case 'failed': return 'failed';
		case 'notPro': return 'notPro';
		case 'expired': return 'expired';
		default: return 'waiting';
	}
}

/** What reading a board's columns needs (Atlassian's own list for `GET /board` and `GET /board/{id}/configuration`). */
const BOARD_SCOPES = ['read:board-scope:jira-software', 'read:board-scope.admin:jira-software', 'read:project:jira'];

/** The page Atlassian shows the person: where to ask for permission, and for what. `write` adds changing issues (moving them between statuses, editing their fields) and looking people up; `boards` adds reading the board's columns. */
export function atlassianAuthorizeUrl(clientId: string, redirectUri: string, state: string, extra: { readonly write?: boolean; readonly boards?: boolean } = {}): string {
	const query = [
		['audience', 'api.atlassian.com'],
		['client_id', clientId],
		['scope', ['read:jira-work', ...(extra.boards ? BOARD_SCOPES : []), ...(extra.write ? ['write:jira-work', 'read:jira-user'] : []), 'offline_access'].join(' ')],
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
