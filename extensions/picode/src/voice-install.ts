/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Getting the dictation engine onto the machine, on purpose and without trusting the network.
 *
 * Dictation runs a speech model (NVIDIA Parakeet v3) through sherpa-onnx, and records with
 * node-cpal. Gentle AI already pinned every piece (gentle-pi 4.5.1, `lib/voice-artifacts.ts`) with
 * version, size and digest; this file carries the same pins for Windows x64, the one system tried
 * so far. Nothing is downloaded until the owner asks, every file is checked against its pin before
 * it is used, a cancelled download keeps what it already fetched, and the files live in PiCode's own
 * folder (`~/.picode/voice`), never in `~/.pi`.
 *
 * The engine itself (loading the model, recording) is a later phase; this one only puts the right
 * bytes in the right place and says whether they are there.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const PARAKEET_REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const PARAKEET_REVISION = '2bda32ec70b097a55adaa07d9a7173915b43cc78';
const SHERPA_VERSION = '1.13.8';

export interface VoiceModelFile {
	readonly name: string;
	readonly size: number;
	readonly sha256: string;
}

export interface VoiceNpmPackage {
	readonly name: string;
	readonly version: string;
	readonly size: number;
	/** The registry's `dist.integrity`: `sha512-<base64>`. */
	readonly integrity: string;
	readonly requiredFiles: readonly string[];
}

export interface VoiceManifest {
	/** Changes whenever any pin changes, so an old install is never taken for a current one. */
	readonly id: string;
	readonly modelBaseUrl: string;
	readonly modelFiles: readonly VoiceModelFile[];
	readonly packages: readonly VoiceNpmPackage[];
}

export const VOICE_MODEL_FILES: readonly VoiceModelFile[] = [
	{ name: 'encoder.int8.onnx', size: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
	{ name: 'decoder.int8.onnx', size: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
	{ name: 'joiner.int8.onnx', size: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
	{ name: 'tokens.txt', size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
];

const WINDOWS_X64_PACKAGES: readonly VoiceNpmPackage[] = [
	{
		name: 'sherpa-onnx-node', version: SHERPA_VERSION, size: 11954,
		integrity: 'sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==',
		requiredFiles: ['package.json', 'sherpa-onnx.js', 'addon.js', 'addon-static-import.js', 'non-streaming-asr.js'],
	},
	{
		name: 'sherpa-onnx-win-x64', version: SHERPA_VERSION, size: 8894875,
		integrity: 'sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==',
		requiredFiles: ['package.json', 'sherpa-onnx.node'],
	},
	{
		name: 'node-cpal', version: '1.0.0', size: 7723259,
		integrity: 'sha512-d71jIzKDjw1HepqaJQMPd+/k3ZLqYZWhLAv6a8aafIGnYoA1QWlShA5iB5CgijIJtQxq9PdQAk99JQKspqlnTA==',
		requiredFiles: ['package.json', 'index.js', 'facade.js', 'cpal-values.js'],
	},
];

/** The pins for this system, or `undefined` when none have been tried here. */
export function voiceManifestFor(platform: NodeJS.Platform, arch: string): VoiceManifest | undefined {
	if (platform !== 'win32' || arch !== 'x64') {
		return undefined;
	}
	return {
		id: `parakeet-v3-int8-${PARAKEET_REVISION.slice(0, 12)}+sherpa-${SHERPA_VERSION}+win32-x64`,
		modelBaseUrl: `https://huggingface.co/${PARAKEET_REPO}/resolve/${PARAKEET_REVISION}`,
		modelFiles: VOICE_MODEL_FILES,
		packages: WINDOWS_X64_PACKAGES,
	};
}

/** Bytes the whole download moves: the model plus the packed libraries. */
export function voiceDownloadSize(manifest: VoiceManifest): number {
	return manifest.modelFiles.reduce((sum, f) => sum + f.size, 0) + manifest.packages.reduce((sum, p) => sum + p.size, 0);
}

/** `~/.picode/voice` — PiCode's own folder for dictation, never `~/.pi`. */
export function voiceDir(home: string): string {
	return path.join(home, '.picode', 'voice');
}

const MARKER = 'installed.json';

export type VoiceState =
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'not-installed' }
	| { readonly kind: 'ready' };

/**
 * Whether dictation is on this machine: the marker written after a complete, verified install names
 * the current pins, and every file it promises is still there at its pinned size. A file removed or
 * cut short by hand turns "ready" back into "not installed" instead of failing later at dictation.
 */
export function readVoiceState(home: string, manifest: VoiceManifest | undefined): VoiceState {
	if (manifest === undefined) {
		return { kind: 'unsupported' };
	}
	const dir = voiceDir(home);
	try {
		const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as { id?: unknown };
		if (marker.id !== manifest.id) {
			return { kind: 'not-installed' };
		}
		for (const file of manifest.modelFiles) {
			if (fs.statSync(path.join(dir, 'model', file.name)).size !== file.size) {
				return { kind: 'not-installed' };
			}
		}
		for (const pkg of manifest.packages) {
			for (const required of pkg.requiredFiles) {
				if (!fs.existsSync(path.join(dir, 'node_modules', pkg.name, required))) {
					return { kind: 'not-installed' };
				}
			}
		}
		return { kind: 'ready' };
	} catch {
		return { kind: 'not-installed' };
	}
}

export interface VoiceProgress {
	/** Bytes of the whole download that are on disk, including what an earlier try fetched. */
	readonly done: number;
	readonly total: number;
	/** Which piece is moving, in words for the owner. */
	readonly label: string;
}

export type VoiceInstallResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly cancelled: boolean; readonly message: string };

/** Hosts a download may be handed off to. Anything else is refused rather than followed. */
const ALLOWED_HOSTS: readonly RegExp[] = [
	/^huggingface\.co$/,
	/^[a-z0-9-]+\.aws\.cdn\.hf\.co$/,
	/^cdn-lfs[a-z0-9.-]*\.hf\.co$/,
	/^registry\.npmjs\.org$/,
];

export function isAllowedHost(url: URL): boolean {
	return url.protocol === 'https:' && ALLOWED_HOSTS.some(rule => rule.test(url.hostname));
}

async function openStream(url: string, offset: number, signal: AbortSignal, allow: (url: URL) => boolean): Promise<Response> {
	let current = new URL(url);
	for (let hop = 0; hop < 5; hop++) {
		if (!allow(current)) {
			throw new Error(`Refused to download from ${current.hostname}.`);
		}
		const headers: Record<string, string> = { 'User-Agent': 'PiCode' };
		if (offset > 0) {
			headers['Range'] = `bytes=${offset}-`;
		}
		const response = await fetch(current, { redirect: 'manual', headers, signal });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (location === null) {
				throw new Error('The server sent a redirect without a destination.');
			}
			current = new URL(location, current);
			continue;
		}
		return response;
	}
	throw new Error('Too many redirects.');
}

/**
 * Fetches `url` into `dest`, resuming a `.part` file, and checks size and digest before the final
 * name exists. A file that fails the check is deleted so the next try starts clean.
 */
export async function downloadVerified(
	url: string,
	dest: string,
	expected: { readonly size: number; readonly digest: (file: string) => Promise<string>; readonly want: string },
	onBytes: (delta: number) => void,
	signal: AbortSignal,
	allow: (url: URL) => boolean = isAllowedHost,
): Promise<void> {
	const part = `${dest}.part`;
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
	if (have > expected.size) {
		fs.rmSync(part, { force: true });
		have = 0;
	}
	if (have > 0) {
		onBytes(have);
	}
	if (have < expected.size) {
		const response = await openStream(url, have, signal, allow);
		if (response.status === 200 && have > 0) {
			// The server ignored the range: start over rather than glue two copies together.
			onBytes(-have);
			fs.rmSync(part, { force: true });
			have = 0;
		} else if (response.status !== 200 && response.status !== 206) {
			throw new Error(`The download failed (${response.status}).`);
		}
		if (response.body === null) {
			throw new Error('The download came back empty.');
		}
		const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
		try {
			const reader = response.body.getReader();
			for (; ;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (!out.write(value)) {
					await new Promise<void>(resolve => out.once('drain', resolve));
				}
				onBytes(value.byteLength);
			}
		} finally {
			await new Promise<void>(resolve => out.end(resolve));
		}
	}
	if (fs.statSync(part).size !== expected.size || (await expected.digest(part)) !== expected.want) {
		fs.rmSync(part, { force: true });
		throw new Error('A downloaded file did not match its published signature and was discarded.');
	}
	fs.renameSync(part, dest);
}

function hashFile(file: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash(algorithm);
		fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest(encoding)));
	});
}

function extractTarball(tarball: string, into: string): void {
	fs.rmSync(into, { recursive: true, force: true });
	fs.mkdirSync(into, { recursive: true });
	// Relative paths from the tarball's own folder: GNU tar (the one Git for Windows puts first on
	// the PATH) reads `C:\...` as "a file on a machine called C" and refuses.
	const cwd = path.dirname(tarball);
	const result = spawnSync('tar', ['-xzf', path.basename(tarball), '-C', path.relative(cwd, into).split(path.sep).join('/'), '--strip-components=1'], { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
	if (result.status !== 0) {
		throw new Error(`Could not unpack a library: ${(result.stderr ?? '').trim() || 'unknown error'}`);
	}
}

/**
 * Downloads and installs everything the manifest names. Safe to call again after a cancel or a
 * failure: verified files are kept, partial ones are resumed. The marker is written last, so a
 * half-finished install never reads as ready.
 */
export async function installVoice(
	home: string,
	manifest: VoiceManifest,
	onProgress: (progress: VoiceProgress) => void,
	signal: AbortSignal,
): Promise<VoiceInstallResult> {
	const dir = voiceDir(home);
	const total = voiceDownloadSize(manifest);
	let done = 0;
	let label = '';
	const bump = (delta: number): void => {
		done += delta;
		onProgress({ done, total, label });
	};
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.rmSync(path.join(dir, MARKER), { force: true });

		for (const file of manifest.modelFiles) {
			label = 'Speech model';
			const dest = path.join(dir, 'model', file.name);
			if (fs.existsSync(dest) && fs.statSync(dest).size === file.size && (await hashFile(dest, 'sha256', 'hex')) === file.sha256) {
				bump(file.size);
				continue;
			}
			await downloadVerified(`${manifest.modelBaseUrl}/${file.name}`, dest,
				{ size: file.size, digest: f => hashFile(f, 'sha256', 'hex'), want: file.sha256 }, bump, signal);
		}

		for (const pkg of manifest.packages) {
			label = 'Speech engine';
			const tarball = path.join(dir, 'downloads', `${pkg.name}-${pkg.version}.tgz`);
			const want = pkg.integrity.replace(/^sha512-/, '');
			await downloadVerified(`https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`, tarball,
				{ size: pkg.size, digest: f => hashFile(f, 'sha512', 'base64'), want }, bump, signal);
			extractTarball(tarball, path.join(dir, 'node_modules', pkg.name));
			for (const required of pkg.requiredFiles) {
				if (!fs.existsSync(path.join(dir, 'node_modules', pkg.name, required))) {
					throw new Error('A downloaded library is incomplete.');
				}
			}
		}

		fs.rmSync(path.join(dir, 'downloads'), { recursive: true, force: true });
		fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ id: manifest.id, installedAt: new Date().toISOString() }));
		return { ok: true };
	} catch (err) {
		if (signal.aborted) {
			return { ok: false, cancelled: true, message: 'Download cancelled. What was fetched is kept.' };
		}
		return { ok: false, cancelled: false, message: err instanceof Error ? err.message : 'The download failed.' };
	}
}

/** Removes everything dictation put on the machine. The next download starts from nothing. */
export function removeVoice(home: string): void {
	fs.rmSync(voiceDir(home), { recursive: true, force: true });
}
