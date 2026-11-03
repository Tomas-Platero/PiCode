/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Putting the dictation engine on the machine, and knowing whether it is there.
 *
 * What matters: nothing counts as installed until a marker, written last, says so and every file is
 * still at its pinned size; a file that does not match its published signature is thrown away and
 * never used; a cancelled or cut download resumes from what it already has; and a download is never
 * handed to a host the pins do not name.
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { downloadVerified, isAllowedHost, readVoiceState, removeVoice, voiceDir, voiceDownloadSize, voiceManifestFor } from '../src/voice-install.ts';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const digest = async (f: string) => sha(fs.readFileSync(f));
const anyHost = () => true;

function scratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'picode-voice-'));
}

async function serve(body: Buffer, opts: { ignoreRange?: boolean; cutAfter?: number } = {}): Promise<{ url: string; close: () => void; ranges: string[] }> {
	const ranges: string[] = [];
	const server = http.createServer((req, res) => {
		const range = req.headers.range;
		if (range) {
			ranges.push(range);
		}
		const start = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
		const slice = body.subarray(start, opts.cutAfter !== undefined ? start + opts.cutAfter : undefined);
		res.writeHead(range && !opts.ignoreRange ? 206 : 200, { 'Content-Length': slice.length });
		res.end(slice);
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/f`, close: () => server.close(), ranges };
}

test('this system has pins only where they were tried', () => {
	assert.ok(voiceManifestFor('win32', 'x64'));
	assert.equal(voiceManifestFor('linux', 'x64'), undefined);
	assert.equal(voiceManifestFor('win32', 'arm64'), undefined);
	assert.deepEqual(readVoiceState(os.tmpdir(), undefined), { kind: 'unsupported' });
});

test('the download adds up to the roughly 700 MB the owner is told about', () => {
	const manifest = voiceManifestFor('win32', 'x64');
	assert.ok(manifest);
	const mb = voiceDownloadSize(manifest) / 1_000_000;
	assert.ok(mb > 650 && mb < 720, `${mb} MB`);
});

test('a marker with files of the wrong size is not an install, and remove clears it', () => {
	const home = scratch();
	const manifest = voiceManifestFor('win32', 'x64');
	assert.ok(manifest);
	try {
		assert.equal(readVoiceState(home, manifest).kind, 'not-installed');

		const dir = voiceDir(home);
		for (const f of manifest.modelFiles) {
			fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'model', f.name), Buffer.alloc(f.size > 1_000_000 ? 1 : f.size));
		}
		for (const p of manifest.packages) {
			for (const r of p.requiredFiles) {
				fs.mkdirSync(path.dirname(path.join(dir, 'node_modules', p.name, r)), { recursive: true });
				fs.writeFileSync(path.join(dir, 'node_modules', p.name, r), 'x');
			}
		}
		fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ id: manifest.id }));
		assert.equal(readVoiceState(home, manifest).kind, 'not-installed');

		removeVoice(home);
		assert.equal(fs.existsSync(dir), false);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('a marker from other pins is not an install', () => {
	const home = scratch();
	try {
		fs.mkdirSync(voiceDir(home), { recursive: true });
		fs.writeFileSync(path.join(voiceDir(home), 'installed.json'), JSON.stringify({ id: 'older-pins' }));
		assert.equal(readVoiceState(home, voiceManifestFor('win32', 'x64')).kind, 'not-installed');
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('a file that matches its signature lands under its final name', async () => {
	const dir = scratch();
	const body = crypto.randomBytes(50_000);
	const srv = await serve(body);
	try {
		const dest = path.join(dir, 'out', 'a.bin');
		let moved = 0;
		await downloadVerified(srv.url, dest, { size: body.length, digest, want: sha(body) }, d => { moved += d; }, new AbortController().signal, anyHost);
		assert.deepEqual(fs.readFileSync(dest), body);
		assert.equal(fs.existsSync(`${dest}.part`), false);
		assert.equal(moved, body.length);
	} finally {
		srv.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a file that does not match is discarded and never appears', async () => {
	const dir = scratch();
	const body = crypto.randomBytes(10_000);
	const srv = await serve(body);
	try {
		const dest = path.join(dir, 'a.bin');
		await assert.rejects(downloadVerified(srv.url, dest, { size: body.length, digest, want: 'f'.repeat(64) }, () => undefined, new AbortController().signal, anyHost), /signature/);
		assert.equal(fs.existsSync(dest), false);
		assert.equal(fs.existsSync(`${dest}.part`), false);
	} finally {
		srv.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a cut download resumes from what it already has', async () => {
	const dir = scratch();
	const body = crypto.randomBytes(40_000);
	const srv = await serve(body);
	try {
		const dest = path.join(dir, 'a.bin');
		fs.writeFileSync(`${dest}.part`, body.subarray(0, 15_000));
		let moved = 0;
		await downloadVerified(srv.url, dest, { size: body.length, digest, want: sha(body) }, d => { moved += d; }, new AbortController().signal, anyHost);
		assert.deepEqual(srv.ranges, ['bytes=15000-']);
		assert.deepEqual(fs.readFileSync(dest), body);
		assert.equal(moved, body.length);
	} finally {
		srv.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a server that ignores the range does not corrupt the file', async () => {
	const dir = scratch();
	const body = crypto.randomBytes(20_000);
	const srv = await serve(body, { ignoreRange: true });
	try {
		const dest = path.join(dir, 'a.bin');
		fs.writeFileSync(`${dest}.part`, body.subarray(0, 5_000));
		let moved = 0;
		await downloadVerified(srv.url, dest, { size: body.length, digest, want: sha(body) }, d => { moved += d; }, new AbortController().signal, anyHost);
		assert.deepEqual(fs.readFileSync(dest), body);
		assert.equal(moved, body.length);
	} finally {
		srv.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('cancelling keeps the partial file for next time', async () => {
	const dir = scratch();
	const body = crypto.randomBytes(30_000);
	const srv = await serve(body, { cutAfter: 10_000 });
	try {
		const dest = path.join(dir, 'a.bin');
		const controller = new AbortController();
		await assert.rejects(downloadVerified(srv.url, dest, { size: body.length, digest, want: sha(body) }, () => controller.abort(), controller.signal, anyHost));
		assert.equal(fs.existsSync(dest), false);
		assert.ok(fs.existsSync(`${dest}.part`));
	} finally {
		srv.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('only the hosts the pins name are followed', () => {
	assert.equal(isAllowedHost(new URL('https://huggingface.co/x')), true);
	assert.equal(isAllowedHost(new URL('https://us.aws.cdn.hf.co/xet-bridge-us/x')), true);
	assert.equal(isAllowedHost(new URL('https://registry.npmjs.org/a/-/a-1.tgz')), true);
	assert.equal(isAllowedHost(new URL('http://huggingface.co/x')), false);
	assert.equal(isAllowedHost(new URL('https://evil.example/x')), false);
	assert.equal(isAllowedHost(new URL('https://huggingface.co.evil.example/x')), false);
});
