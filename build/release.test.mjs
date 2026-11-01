/*
 * Tests for build/release.mjs whats-new-history: keeping a release's summary once its page is gone.
 *
 *   node --test build/release.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
