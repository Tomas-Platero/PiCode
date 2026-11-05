/*
 * Tests for build/release.mjs whats-new-history: keeping a release's summary once its page is gone.
 *
 *   node --test build/release.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyUpdateSignature } from '../src/vs/platform/update/node/updateSignature.ts';

const SCRIPT = fileURLToPath(new URL('./release.mjs', import.meta.url));

const BODY = [
	'## 🧪 The experimental channel', '', 'Channel text.', '', '---', '',
	'## What changed', '', '### 🐛 Fixed', '', '- Updates no longer get stuck', '', '---', '',
	'## What\'s Changed', '* raw changelog',
].join('\n');

function withHistory(run) {
	const dir = mkdtempSync(join(tmpdir(), 'whats-new-'));
	try {
		run({ dir, history: join(dir, 'whats-new.json'), body: join(dir, 'body.md') });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function keep(history, body, version, extra = []) {
	execFileSync(process.execPath, [SCRIPT, 'whats-new-history', '--history', history, '--version', version, '--body', body, ...extra]);
}

const read = history => JSON.parse(readFileSync(history, 'utf8')).versions;

test('keeps the summary of a replaced release, without the page around it', () => {
	withHistory(({ history, body }) => {
		writeFileSync(body, BODY);
		keep(history, body, 'v0.7.4-experimental');
		assert.deepEqual(read(history), [{ version: '0.7.4-experimental', notes: '### 🐛 Fixed\n\n- Updates no longer get stuck' }]);
	});
});

test('keeps versions newest first, replaces a version kept twice, and caps the list', () => {
	withHistory(({ history, body }) => {
		writeFileSync(body, BODY);
		for (const version of ['0.7.9', '0.7.10', '0.7.3', '0.7.9']) {
			keep(history, body, version, ['--max', '2']);
		}
		assert.deepEqual(read(history).map(entry => entry.version), ['0.7.10', '0.7.9']);
	});
});

test('leaves the file alone when the page has no summary', () => {
	withHistory(({ history, body }) => {
		writeFileSync(body, '## What\'s Changed\n* raw changelog');
		keep(history, body, '0.7.4');
		assert.equal(existsSync(history), false);
	});
});

test('refuses to run without a version it can order', () => {
	withHistory(({ history, body }) => {
		writeFileSync(body, BODY);
		assert.throws(() => keep(history, body, 'latest'));
		assert.equal(existsSync(history), false);
	});
});

/* update-feed: what lets the updater trust a full download. */

function signingKey() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
		privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
	};
}

function writeFeed(out, env, extra = []) {
	return spawnSync(process.execPath, [SCRIPT, 'update-feed', '--version', '1.2.3', '--commit', 'c'.repeat(40), '--url', 'https://x.test/a.zip',
		'--sha256', 'a'.repeat(64), '--picode-version', '1.0.8-experimental', '--quality', 'experimental', '--kind', 'release',
		'--platform', 'win32', '--arch', 'x64', '--target', 'archive', '--out', out, ...extra],
		{ encoding: 'utf8', env: { ...process.env, HOTFIX_SIGNING_KEY: '', ...env } });
}

test('update-feed signs the feed, and only the same details verify', () => {
	const dir = mkdtempSync(join(tmpdir(), 'picode-feed-'));
	try {
		const { publicKey, privateKey } = signingKey();
		const run = writeFeed(dir, { HOTFIX_SIGNING_KEY: privateKey });
		assert.equal(run.status, 0, run.stderr);
		const feed = JSON.parse(readFileSync(join(dir, 'experimental', 'win32', 'x64', 'archive', 'latest.json'), 'utf8'));
		const path = 'experimental/win32/x64/archive';
		assert.equal(verifyUpdateSignature(feed, path, publicKey), true);
		assert.equal(verifyUpdateSignature({ ...feed, sha256hash: 'b'.repeat(64) }, path, publicKey), false, 'another file');
		assert.equal(verifyUpdateSignature({ ...feed, productVersion: '9.9.9' }, path, publicKey), false, 'another version');
		assert.equal(verifyUpdateSignature(feed, 'stable/win32/x64/archive', publicKey), false, 'another channel');
		assert.equal(verifyUpdateSignature(feed, path, signingKey().publicKey), false, 'another key');
		assert.equal(verifyUpdateSignature({ ...feed, signature: undefined }, path, publicKey), false, 'no signature');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('update-feed refuses to write an unsigned feed unless asked to', () => {
	const dir = mkdtempSync(join(tmpdir(), 'picode-feed-'));
	try {
		const refused = writeFeed(dir, {});
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /HOTFIX_SIGNING_KEY/);
		assert.equal(existsSync(join(dir, 'experimental')), false);

		const unsigned = writeFeed(dir, {}, ['--unsigned']);
		assert.equal(unsigned.status, 0, unsigned.stderr);
		const feed = JSON.parse(readFileSync(join(dir, 'experimental', 'win32', 'x64', 'archive', 'latest.json'), 'utf8'));
		assert.equal(feed.signature, undefined);

		const stillUnsigned = writeFeed(dir, { HOTFIX_SIGNING_KEY: signingKey().privateKey }, ['--unsigned']);
		assert.equal(stillUnsigned.status, 0, stillUnsigned.stderr);
		const asked = JSON.parse(readFileSync(join(dir, 'experimental', 'win32', 'x64', 'archive', 'latest.json'), 'utf8'));
		assert.equal(asked.signature, undefined, '--unsigned wins over a key in the environment');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the updater checks the signature before it trusts a feed', () => {
	const service = readFileSync(fileURLToPath(new URL('../src/vs/platform/update/electron-main/abstractUpdateService.ts', import.meta.url)), 'utf8');
	const check = service.indexOf('verifyUpdateSignature(update, feedPath, publicKey)');
	assert.ok(check !== -1, 'nothing checks the signature');
	assert.ok(check < service.indexOf('normalizeVersion(update.productVersion)'), 'the feed is read before it is checked');
});

test('check-signing-key says whether the key belongs to the product', () => {
	const { publicKey, privateKey } = signingKey();
	const check = (key, pub) => spawnSync(process.execPath, [SCRIPT, 'check-signing-key', '--public-key', pub], { encoding: 'utf8', env: { ...process.env, HOTFIX_SIGNING_KEY: key } });
	assert.equal(check(privateKey, publicKey).status, 0);
	assert.notEqual(check(privateKey, signingKey().publicKey).status, 0, 'another key');
	assert.notEqual(check('', publicKey).status, 0, 'no key');
});
