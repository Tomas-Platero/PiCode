/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the Dictation card is told, from "never downloaded" to "ready".
 *
 * What matters: the size is known before anything is fetched; pressing Download twice joins the
 * running download instead of starting a second; progress is a whole percent that never passes 100;
 * a cancel is not shown as a failure; and a real failure is remembered so the card can say so.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { shouldDownloadOnStart, VoiceController } from '../src/voice-controller.ts';
import { readVoiceState, removeVoice, voiceDownloadSize, voiceManifestFor, type VoiceInstallResult, type VoiceManifest, type VoiceProgress } from '../src/voice-install.ts';

const real = { install: undefined as never, readState: readVoiceState, remove: removeVoice, downloadSize: voiceDownloadSize };

const manifest = voiceManifestFor('win32', 'x64') as VoiceManifest;

function home(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'picode-voice-ctl-'));
}

/** An install the test finishes by hand. */
function manual() {
	let finish!: (r: VoiceInstallResult) => void;
	let report!: (p: VoiceProgress) => void;
	let signal!: AbortSignal;
	let calls = 0;
	const install = (_h: string, _m: VoiceManifest, onProgress: (p: VoiceProgress) => void, s: AbortSignal) => {
		calls++;
		report = onProgress;
		signal = s;
		return new Promise<VoiceInstallResult>(resolve => { finish = resolve; });
	};
	return { install, finish: (r: VoiceInstallResult) => finish(r), report: (p: VoiceProgress) => report(p), signal: () => signal, calls: () => calls };
}

test('where nothing was tried, the card says it is not available', () => {
	assert.deepEqual(new VoiceController(home(), undefined, real).status(), { state: 'unsupported' });
});

test('before any download the size is already known', () => {
	const status = new VoiceController(home(), manifest, real).status();
	assert.equal(status.state, 'not-installed');
	assert.ok(status.state === 'not-installed' && status.sizeMb > 650 && status.sizeMb < 720);
});

test('pressing Download twice joins the running one, and progress is a whole percent', async () => {
	const m = manual();
	const ctl = new VoiceController(home(), manifest, { ...real, install: m.install });
	const first = ctl.start();
	const second = ctl.start();
	assert.equal(m.calls(), 1);

	m.report({ done: 333, total: 1000, label: 'x' });
	assert.deepEqual(ctl.status(), { state: 'downloading', sizeMb: (ctl.status() as { sizeMb: number }).sizeMb, percent: 33 });
	m.report({ done: 5000, total: 1000, label: 'x' });
	assert.equal((ctl.status() as { percent: number }).percent, 100);

	m.finish({ ok: true });
	assert.equal((await first).ok, true);
	assert.equal((await second).ok, true);
	assert.equal(ctl.status().state, 'not-installed'); // the fake wrote nothing, so disk still says no
});

test('a cancel is not a failure, and the signal reaches the download', async () => {
	const m = manual();
	const ctl = new VoiceController(home(), manifest, { ...real, install: m.install });
	const run = ctl.start();
	ctl.cancel();
	assert.equal(m.signal().aborted, true);
	m.finish({ ok: false, cancelled: true, message: 'cancelled' });
	await run;
	const status = ctl.status();
	assert.equal(status.state, 'not-installed');
	assert.equal(status.state === 'not-installed' ? status.error : 'x', undefined);
});

test('a real failure is remembered, and the next try clears it', async () => {
	const m = manual();
	const ctl = new VoiceController(home(), manifest, { ...real, install: m.install });
	const run = ctl.start();
	m.finish({ ok: false, cancelled: false, message: 'No connection' });
	await run;
	const failed = ctl.status();
	assert.equal(failed.state === 'not-installed' ? failed.error : undefined, 'No connection');

	void ctl.start();
	assert.equal(ctl.status().state, 'downloading');
});

test('the setup window asking for dictation starts a download only when there is something to fetch', () => {
	assert.equal(shouldDownloadOnStart(true, { state: 'not-installed', sizeMb: 700 }), true);
	assert.equal(shouldDownloadOnStart(false, { state: 'not-installed', sizeMb: 700 }), false);
	assert.equal(shouldDownloadOnStart(true, { state: 'downloading', sizeMb: 700, percent: 3 }), false);
	assert.equal(shouldDownloadOnStart(true, { state: 'ready' }), false);
	assert.equal(shouldDownloadOnStart(true, { state: 'unsupported' }), false);
});

test('remove refuses while a download is running', async () => {
	const m = manual();
	const ctl = new VoiceController(home(), manifest, { ...real, install: m.install });
	void ctl.start();
	assert.equal(await ctl.remove(), false);
});
