/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Connecting GitHub and Jira: the answers read, and the callback claimed only for its own attempt. */

import assert from 'assert';
import { test } from 'node:test';
import { atlassianAuthorizeUrl, connectorCodeFromCallback, needsRefresh, parseAtlassianSites, parseDeviceCode, parseDevicePoll } from '../../../src/vs/workbench/contrib/picode/browser/account/issues/picodeConnectorAuth.ts';

const NOW = 1_000_000;
const callback = (query: string, path = '/connect/callback', scheme = 'picode') => ({ scheme, path, query });

test('a device code from GitHub is read, with its wait in milliseconds', () => {
	const code = parseDeviceCode({ device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 });
	assert.deepStrictEqual(code, { deviceCode: 'd', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', intervalMs: 5000, expiresInMs: 900_000 });
});

test('a device code pointing anywhere but GitHub is refused', () => {
	assert.strictEqual(parseDeviceCode({ device_code: 'd', user_code: 'u', verification_uri: 'https://evil.example/login/device' }), undefined);
	assert.strictEqual(parseDeviceCode({ error: 'bad' }), undefined);
});

test('each state of the wait is told apart', () => {
	assert.deepStrictEqual(parseDevicePoll({ error: 'authorization_pending' }, NOW), { kind: 'pending' });
	assert.deepStrictEqual(parseDevicePoll({ error: 'slow_down', interval: 10 }, NOW), { kind: 'slowDown', intervalMs: 10_000 });
	assert.deepStrictEqual(parseDevicePoll({ error: 'access_denied' }, NOW), { kind: 'denied' });
	assert.deepStrictEqual(parseDevicePoll({ error: 'expired_token' }, NOW), { kind: 'expired' });
	assert.deepStrictEqual(parseDevicePoll({ error: 'incorrect_client_credentials' }, NOW), { kind: 'failed' });
	assert.deepStrictEqual(parseDevicePoll('nope', NOW), { kind: 'failed' });
});

test('the token comes with when it dies', () => {
	const result = parseDevicePoll({ access_token: 'a', refresh_token: 'r', expires_in: 28800 }, NOW);
	assert.deepStrictEqual(result, { kind: 'tokens', tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 28_800_000 } });
});

test('a token that never expires has no deadline', () => {
	const result = parseDevicePoll({ access_token: 'a' }, NOW);
	assert.ok(result.kind === 'tokens' && result.tokens.expiresAt === undefined && result.tokens.refreshToken === undefined);
});

test('a token is renewed a minute before it dies', () => {
	assert.strictEqual(needsRefresh({ accessToken: 'a', expiresAt: NOW + 120_000 }, NOW), false);
	assert.strictEqual(needsRefresh({ accessToken: 'a', expiresAt: NOW + 30_000 }, NOW), true);
	assert.strictEqual(needsRefresh({ accessToken: 'a' }, NOW), false);
});

test('the callback of this attempt gives its code', () => {
	assert.strictEqual(connectorCodeFromCallback(callback('service=atlassian&state=S1&code=abc'), 'picode', 'atlassian', 'S1'), 'abc');
});

test('the address the cloud page really sends (connect as host, /callback as path) gives its code', () => {
	const real = { scheme: 'picode', authority: 'connect', path: '/callback', query: 'service=atlassian&state=S1&code=abc' };
	assert.strictEqual(connectorCodeFromCallback(real, 'picode', 'atlassian', 'S1'), 'abc');
	assert.strictEqual(connectorCodeFromCallback({ ...real, authority: 'other' }, 'picode', 'atlassian', 'S1'), undefined);
});

test('a callback with another state, service, path or scheme is left alone', () => {
	assert.strictEqual(connectorCodeFromCallback(callback('service=atlassian&state=OTHER&code=abc'), 'picode', 'atlassian', 'S1'), undefined);
	assert.strictEqual(connectorCodeFromCallback(callback('service=github&state=S1&code=abc'), 'picode', 'atlassian', 'S1'), undefined);
	assert.strictEqual(connectorCodeFromCallback(callback('service=atlassian&state=S1&code=abc', '/auth/callback'), 'picode', 'atlassian', 'S1'), undefined);
	assert.strictEqual(connectorCodeFromCallback(callback('service=atlassian&state=S1&code=abc', '/connect/callback', 'other'), 'picode', 'atlassian', 'S1'), undefined);
});

test('a callback without a code, or with no state expected, is not claimed', () => {
	assert.strictEqual(connectorCodeFromCallback(callback('service=atlassian&state=S1'), 'picode', 'atlassian', 'S1'), undefined);
	assert.strictEqual(connectorCodeFromCallback(callback('service=atlassian&state=&code=abc'), 'picode', 'atlassian', ''), undefined);
});

test('the permission page asks only to read issues, and renews itself', () => {
	const url = atlassianAuthorizeUrl('cid', 'https://x.example/cb', 'S1');
	assert.ok(url.startsWith('https://auth.atlassian.com/authorize?'));
	assert.ok(url.includes('scope=read%3Ajira-work%20offline_access'));
	assert.ok(url.includes('state=S1'));
	assert.ok(url.includes('redirect_uri=https%3A%2F%2Fx.example%2Fcb'));
});

test('only Jira sites with a plain https address are offered', () => {
	const sites = parseAtlassianSites([
		{ id: '1', url: 'https://acme.atlassian.net', name: 'Acme', scopes: ['read:jira-work'] },
		{ id: '2', url: 'https://acme.atlassian.net/x"onload=1', name: 'Bad', scopes: ['read:jira-work'] },
		{ id: '3', url: 'https://other.atlassian.net', name: 'Wiki only', scopes: ['read:confluence-content.all'] },
	]);
	assert.deepStrictEqual(sites, [{ cloudId: '1', url: 'https://acme.atlassian.net', name: 'Acme' }]);
});
