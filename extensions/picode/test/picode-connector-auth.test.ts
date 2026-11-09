/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Connecting GitHub and Jira: the answers read, and the callback claimed only for its own attempt. */

import assert from 'assert';
import { test } from 'node:test';
import { atlassianAuthorizeUrl, parseAtlassianSites, parseDeviceCode, parseDevicePoll, readAtlassianAttemptState, readAtlassianAttemptStatus } from '../../../src/vs/workbench/contrib/picode/browser/account/issues/picodeConnectorAuth.ts';

test('a device code from GitHub is read, with its wait in milliseconds', () => {
	const code = parseDeviceCode({ device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 });
	assert.deepStrictEqual(code, { deviceCode: 'd', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', intervalMs: 5000, expiresInMs: 900_000 });
});

test('a device code pointing anywhere but GitHub is refused', () => {
	assert.strictEqual(parseDeviceCode({ device_code: 'd', user_code: 'u', verification_uri: 'https://evil.example/login/device' }), undefined);
	assert.strictEqual(parseDeviceCode({ error: 'bad' }), undefined);
});

test('each state of the wait is told apart', () => {
	assert.deepStrictEqual(parseDevicePoll({ error: 'authorization_pending' }), { kind: 'pending' });
	assert.deepStrictEqual(parseDevicePoll({ error: 'slow_down', interval: 10 }), { kind: 'slowDown', intervalMs: 10_000 });
	assert.deepStrictEqual(parseDevicePoll({ error: 'access_denied' }), { kind: 'denied' });
	assert.deepStrictEqual(parseDevicePoll({ error: 'expired_token' }), { kind: 'expired' });
	assert.deepStrictEqual(parseDevicePoll({ error: 'incorrect_client_credentials' }), { kind: 'failed' });
	assert.deepStrictEqual(parseDevicePoll('nope'), { kind: 'failed' });
});

test('the server says it is connected, and that is all the editor learns', () => {
	assert.deepStrictEqual(parseDevicePoll({ connected: true }), { kind: 'connected' });
});

test('a token in the answer is not taken for a connection, nor kept', () => {
	assert.deepStrictEqual(parseDevicePoll({ access_token: 'a', refresh_token: 'r' }), { kind: 'failed' });
});

test('the state of a Jira attempt is taken only when it is plain', () => {
	assert.strictEqual(readAtlassianAttemptState({ state: '0f8fad5b-d9cb-469f' }), '0f8fad5b-d9cb-469f');
	assert.strictEqual(readAtlassianAttemptState({ state: 'short' }), undefined);
	assert.strictEqual(readAtlassianAttemptState({ state: 'a&redirect_uri=https://evil' }), undefined);
	assert.strictEqual(readAtlassianAttemptState({}), undefined);
	assert.strictEqual(readAtlassianAttemptState(undefined), undefined);
});

test('a Jira attempt ends only when the server says so', () => {
	for (const status of ['connected', 'failed', 'notPro', 'expired'] as const) {
		assert.strictEqual(readAtlassianAttemptStatus({ status }), status);
	}
	assert.strictEqual(readAtlassianAttemptStatus({ status: 'pending' }), 'waiting');
	assert.strictEqual(readAtlassianAttemptStatus({ status: 'trading' }), 'waiting');
	assert.strictEqual(readAtlassianAttemptStatus({ status: 'other' }), 'waiting');
	assert.strictEqual(readAtlassianAttemptStatus(undefined), 'waiting');
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

test('the permission to change issues is asked only when it is wanted', () => {
	assert.ok(!atlassianAuthorizeUrl('cid', 'https://x.example/cb', 'S1').includes('write'));
	assert.ok(atlassianAuthorizeUrl('cid', 'https://x.example/cb', 'S1', { write: true }).includes('scope=read%3Ajira-work%20write%3Ajira-work%20read%3Ajira-user%20offline_access'));
	const boards = atlassianAuthorizeUrl('cid', 'https://x.example/cb', 'S1', { boards: true });
	assert.ok(boards.includes('read%3Aboard-scope%3Ajira-software%20read%3Aboard-scope.admin%3Ajira-software%20read%3Aproject%3Ajira'));
	assert.ok(!boards.includes('write'));
});

