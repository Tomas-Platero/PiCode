/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskLedger } from '../picodeAgentBridgeLedger.js';
import { folderKeyOf, hashPrompt, parseRequest } from '../picodeAgentBridgeProtocol.js';

/**
 * One task reaches pi once: a repeat waits for, or reuses, the first; a different folder or
 * assignment under the same task id is a conflict; a task left pending is recovered, never re-sent
 * by the ledger itself.
 */
suite('PiCode agent bridge: task ledger', () => {

	let dir: string;
	let file: string;
	const folder = folderKeyOf('D:\\work\\shop', 'win32');
	const hash = hashPrompt('Fix the login');

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'picode-ledger-'));
		file = join(dir, 'agent-bridge-tasks.json');
	});

	teardown(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('two simultaneous requests for one task run it once', async () => {
		const ledger = new TaskLedger<string>(file);
		let runs = 0;
		let release!: (value: string) => void;
		const run = () => { runs++; return new Promise<string>(resolve => { release = resolve; }); };
		const first = ledger.claim('T-1', folder, hash, run);
		const second = ledger.claim('T-1', folder, hash, run);
		assert.strictEqual(first.kind, 'start');
		assert.strictEqual(second.kind, 'wait');
		await new Promise(resolve => setTimeout(resolve, 0));
		release('session-1');
		assert.strictEqual(first.kind === 'start' && await first.outcome, 'session-1');
		assert.strictEqual(second.kind === 'wait' && await second.outcome, 'session-1');
		assert.strictEqual(runs, 1);
	});

	test('a started task is reused and nothing runs again', () => {
		const ledger = new TaskLedger<string>(file);
		ledger.markStarted('T-1', folder, hash, 'session-1');
		let runs = 0;
		const decision = ledger.claim('T-1', folder, hash, async () => { runs++; return ''; });
		assert.deepStrictEqual(decision, { kind: 'reuse', sessionId: 'session-1' });
		assert.strictEqual(runs, 0);
	});

	test('the same task id with another folder or assignment is a conflict', () => {
		const ledger = new TaskLedger<string>(file);
		ledger.markStarted('T-1', folder, hash, 'session-1');
		assert.strictEqual(ledger.claim('T-1', folderKeyOf('D:\\work\\other', 'win32'), hash, async () => '').kind, 'conflict');
		assert.strictEqual(ledger.claim('T-1', folder, hashPrompt('Something else'), async () => '').kind, 'conflict');
	});

	test('a conflict is also caught while the first request is still running', () => {
		const ledger = new TaskLedger<string>(file);
		ledger.claim('T-1', folder, hash, () => new Promise<string>(() => { }));
		assert.strictEqual(ledger.claim('T-1', folder, hashPrompt('Something else'), async () => '').kind, 'conflict');
	});

	test('a pending task nobody is running is recovered, and survives a restart', () => {
		new TaskLedger<string>(file).markPending('T-1', folder, hash);
		const reopened = new TaskLedger<string>(file);
		assert.strictEqual(reopened.get('T-1')?.state, 'pending');
		assert.strictEqual(reopened.claim('T-1', folder, hash, async () => '').kind, 'recover');
	});

	test('a task that provably never reached pi can start again', () => {
		const ledger = new TaskLedger<string>(file);
		ledger.markPending('T-1', folder, hash);
		ledger.forget('T-1');
		assert.strictEqual(new TaskLedger<string>(file).claim('T-1', folder, hash, async () => '').kind, 'start');
	});

	test('a ledger that cannot be read starts nothing, and is left as it is', () => {
		writeFileSync(file, '{ not json');
		let runs = 0;
		const ledger = new TaskLedger<string>(file);
		assert.strictEqual(ledger.claim('T-1', folder, hash, async () => { runs++; return ''; }).kind, 'unavailable');
		assert.strictEqual(runs, 0);
		assert.strictEqual(readFileSync(file, 'utf8'), '{ not json');
	});
});

suite('PiCode agent bridge: requests', () => {

	const token = 'secret-token';
	const request = (overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => JSON.stringify({
		token, id: '1', method: 'session.start',
		params: { folder: 'D:\\work\\shop', taskId: 'T-1', prompt: 'Fix the login', ...params },
		...overrides,
	});

	test('a valid request carries a folder identity and the assignment hash', () => {
		const parsed = parseRequest(request(), token);
		assert.strictEqual(parsed.kind, 'session.start');
		if (parsed.kind === 'session.start') {
			assert.strictEqual(parsed.id, '1');
			assert.strictEqual(parsed.params.promptHash, hashPrompt('Fix the login'));
			assert.strictEqual(parsed.params.resendUncertain, false);
		}
	});

	test('a wrong or missing token is refused before anything else is read', () => {
		assert.deepStrictEqual(parseRequest(request({ token: 'nope', method: 'other' }), token), { kind: 'error', id: '1', code: 'unauthorized', message: 'The token is missing or wrong.' });
		assert.strictEqual((parseRequest(request({ token: undefined }), token) as { code?: string }).code, 'unauthorized');
	});

	test('broken JSON, unknown methods and bad params are errors with the caller id', () => {
		assert.strictEqual((parseRequest('{ nope', token) as { code?: string }).code, 'invalid_request');
		assert.strictEqual((parseRequest(request({ method: 'session.kill' }), token) as { code?: string }).code, 'unknown_method');
		assert.strictEqual((parseRequest(request({}, { folder: 'relative\\path' }), token) as { code?: string }).code, 'invalid_request');
		assert.strictEqual((parseRequest(request({}, { taskId: '' }), token) as { code?: string }).code, 'invalid_request');
		assert.strictEqual((parseRequest(request({}, { prompt: '  ' }), token) as { code?: string }).code, 'invalid_request');
		assert.strictEqual((parseRequest(request({}, { resendUncertain: 'yes' }), token) as { code?: string }).code, 'invalid_request');
		assert.strictEqual((parseRequest(request({ id: undefined }), token) as { code?: string }).code, 'invalid_request');
	});

	test('a prompt the chat would read as a command or another participant is refused', () => {
		assert.strictEqual((parseRequest(request({}, { prompt: '/compact' }), token) as { code?: string }).code, 'invalid_request');
		assert.strictEqual((parseRequest(request({}, { prompt: '  @workspace fix it' }), token) as { code?: string }).code, 'invalid_request');
		assert.strictEqual(parseRequest(request({}, { prompt: 'Fix the /login route for @admin users' }), token).kind, 'session.start');
	});

	test('network shares are not accepted as folders', () => {
		assert.strictEqual((parseRequest(request({}, { folder: String.raw`\\server\share\repo` }), token) as { code?: string }).code, 'invalid_request');
	});

	test('two spellings of one Windows folder are the same folder', () => {
		assert.strictEqual(folderKeyOf('D:\\Work\\Shop\\', 'win32'), folderKeyOf('d:\\work\\shop', 'win32'));
	});
});
