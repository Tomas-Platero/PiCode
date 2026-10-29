/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Updating the memory engine, on purpose and with a way back.
 *
 * The engine ships with PiCode, pinned. This module is the second path: the owner asks for a newer
 * one and it is downloaded into **their** profile (`~/.picode/memory/`), never into the
 * installation and never over the store. The shipped copy is left alone, so a PiCode update still
 * replaces it — and wins once it is newer (`firstEngramBinary`) — and deleting `~/.picode/memory/`
 * reverts to it. It is offered with everything else in the app's update check (`extension.ts`). Nothing here migrates `~/.engram`:
 * a newer engine may, on first run, but that is the engine's own decision and the backup of the
 * database is taken before anything is started.
 *
 * Every step that can fail is checked and, when it does, the previous engine is put back. A memory
 * update that silently half-succeeds is worse than one that says "no".
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ENGRAM_VERSION_FILE, engramBinaryName } from './engram';

const REPO = 'Gentleman-Programming/engram';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface EngineRelease {
	readonly tag: string;       // "v3.5.1"
	readonly version: string;    // "3.5.1"
	readonly asset: string;      // "engram_3.5.1_windows_amd64.zip"
	readonly url: string;       // browser download URL
	readonly checksumsUrl: string;
}

/** `~/.picode/memory` — where an updated engine lives, never the installation. */
export function userEngineDir(home: string): string {
	return path.join(home, '.picode', 'memory');
}

export function userEngineBinary(home: string): string {
	return path.join(userEngineDir(home), engramBinaryName());
}

/** Parses "3.4.0" / "v3.5.1" into comparable numbers; missing parts are zero. */
export function parseVersion(value: string): number[] {
	return value.replace(/^v/i, '').split('.').map(part => {
		const match = part.match(/^(\d+)/);
		return match === null ? 0 : Number(match[1]);
	});
}

/** -1 / 0 / 1, the way a person reads version numbers. */
export function compareVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) {
			return diff < 0 ? -1 : 1;
		}
	}
	return 0;
}

/** The asset name for this machine, or `undefined` when it is not a supported target. */
export function assetNameFor(version: string, platform: NodeJS.Platform, arch: string): string | undefined {
	const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
	const archName = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
	if (osName === undefined || archName === undefined) {
		return undefined;
	}
	const ext = osName === 'windows' ? 'zip' : 'tar.gz';
	return `engram_${version}_${osName}_${archName}.${ext}`;
}

/** Reads `checksums.txt` into a map of file name → sha256. */
export function parseChecksums(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = line.trim().match(/^([0-9a-fA-F]{64})\s+(.+)$/);
		if (match !== null) {
			map.set(match[2].trim(), match[1].toLowerCase());
		}
	}
	return map;
}

/** SHA-256 of a file, in hex. */
export function sha256File(file: string): string {
	const hash = crypto.createHash('sha256');
	hash.update(fs.readFileSync(file));
	return hash.digest('hex');
}

/**
 * Asks GitHub what the newest release is. `undefined` means "could not ask"; `report` says why.
 *
 * The API answers first. When it does not (a rate limit, a proxy that only lets pages through, a
 * network that blocks `api.github.com`), the release page's own redirect names the same tag and the
 * download address follows from it, so the update does not depend on one door being open.
 */
export async function fetchLatestRelease(report?: (reason: string) => void): Promise<EngineRelease | undefined> {
	const fromApi = await releaseFromApi(report);
	if (fromApi !== undefined) {
		return fromApi;
	}
	return releaseFromPage(report);
}

async function releaseFromApi(report?: (reason: string) => void): Promise<EngineRelease | undefined> {
	try {
		const response = await fetch(API, { headers: { 'User-Agent': 'PiCode', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) {
			report?.(`the release API answered ${response.status}`);
			return undefined;
		}
		const body = await response.json() as { tag_name?: unknown; assets?: unknown };
		const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
		const version = tag.replace(/^v/i, '');
		if (version === '') {
			report?.('the release API named no version');
			return undefined;
		}
		const assets = Array.isArray(body.assets) ? body.assets as Array<{ name?: unknown; browser_download_url?: unknown }> : [];
		const asset = assetNameFor(version, process.platform, process.arch);
		if (asset === undefined) {
			report?.('there is no memory engine download for this system');
			return undefined;
		}
		const found = assets.find(item => item.name === asset);
		const url = typeof found?.browser_download_url === 'string' ? found.browser_download_url : '';
		if (url === '') {
			report?.(`the release has no ${asset}`);
			return undefined;
		}
		return releaseFor(tag, version, asset, url);
	} catch (error) {
		report?.(`the release API could not be reached (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	}
}

/** The release page redirects `/releases/latest` to `/releases/tag/<tag>`: that names the newest tag. */
async function releaseFromPage(report?: (reason: string) => void): Promise<EngineRelease | undefined> {
	try {
		const response = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'PiCode' }, signal: AbortSignal.timeout(15_000) });
		const location = response.headers.get('location') ?? (response.url.includes('/releases/tag/') ? response.url : '');
		const tag = decodeURIComponent(location.split('/releases/tag/')[1] ?? '').split(/[?#]/)[0];
		const version = tag.replace(/^v/i, '');
		if (version === '') {
			report?.(`the release page did not name a version (it answered ${response.status})`);
			return undefined;
		}
		const asset = assetNameFor(version, process.platform, process.arch);
		if (asset === undefined) {
			report?.('there is no memory engine download for this system');
			return undefined;
		}
		return releaseFor(tag, version, asset, `https://github.com/${REPO}/releases/download/${tag}/${asset}`);
	} catch (error) {
		report?.(`the release page could not be reached (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	}
}

function releaseFor(tag: string, version: string, asset: string, url: string): EngineRelease {
	return {
		tag,
		version,
		asset,
		url,
		checksumsUrl: `https://github.com/${REPO}/releases/download/${tag}/checksums.txt`,
	};
}

/** Runs the engine and reads the version it reports. `undefined` means it did not answer. */
export function probeEngineVersion(binary: string): string | undefined {
	try {
		const result = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
		if (result.status !== 0) {
			return undefined;
		}
		const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
		const match = output.match(/(\d+\.\d+\.\d+)/);
		return match === null ? undefined : match[1];
	} catch {
		return undefined;
	}
}

/**
 * The whole flow: ask, confirm, download, verify, extract, probe, install, report.
 *
 * `confirm` is the editor's dialog; `progress` is where the owner reads what is happening. Both
 * are injected so this module never imports `vscode`.
 */
export async function updateEngine(options: {
	readonly home: string;
	readonly currentVersion: string | undefined;
	readonly confirm: (message: string) => Promise<boolean>;
	readonly progress: (line: string) => void;
}): Promise<{ readonly ok: boolean; readonly message: string }> {
	const { home, currentVersion, confirm, progress } = options;

	progress('Checking for a newer memory engine…');
	const reasons: string[] = [];
	const release = await fetchLatestRelease(reason => reasons.push(reason));
	if (release === undefined) {
		return { ok: false, message: `Could not reach the release page${reasons.length > 0 ? ` (${reasons[reasons.length - 1]})` : ''}. Nothing was changed.` };
	}
	if (currentVersion !== undefined && compareVersions(release.version, currentVersion) <= 0) {
		return { ok: true, message: `Already up to date (${currentVersion}).` };
	}

	const agreed = await confirm(
		`Memory engine ${release.version} is available (you have ${currentVersion ?? 'an unknown version'}). ` +
		`It will be downloaded into your profile and used after you restart PiCode. The store is not touched.`
	);
	if (!agreed) {
		return { ok: false, message: 'Update cancelled.' };
	}

	const tempRoot = path.join(os.tmpdir(), `picode-engram-update-${Date.now()}`);
	fs.mkdirSync(tempRoot, { recursive: true });
	try {
		progress(`Downloading ${release.asset}…`);
		const archivePath = path.join(tempRoot, release.asset);
		const response = await fetch(release.url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok || response.body === null) {
			return { ok: false, message: 'The download failed. Nothing was changed.' };
		}
		const { pipeline } = await import('node:stream/promises');
		const { createWriteStream } = await import('node:fs');
		await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(archivePath));

		progress('Verifying the download…');
		const checksumsResponse = await fetch(release.checksumsUrl, { signal: AbortSignal.timeout(30_000) });
		if (!checksumsResponse.ok) {
			return { ok: false, message: 'The checksums could not be fetched. Nothing was changed.' };
		}
		const checksums = parseChecksums(await checksumsResponse.text());
		const expected = checksums.get(release.asset);
		if (expected === undefined || sha256File(archivePath) !== expected) {
			return { ok: false, message: 'The download did not match its checksum. Nothing was changed.' };
		}

		progress('Extracting…');
		const extractDir = path.join(tempRoot, 'extracted');
		fs.mkdirSync(extractDir, { recursive: true });
		if (process.platform === 'win32') {
			const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
			if (ps.status !== 0) {
				return { ok: false, message: `Extraction failed: ${(ps.stderr ?? '').trim() || 'unknown error'}. Nothing was changed.` };
			}
		} else {
			const tar = spawnSync('tar', ['-xf', archivePath, '-C', extractDir], { encoding: 'utf8', timeout: 120_000 });
			if (tar.status !== 0) {
				return { ok: false, message: `Extraction failed: ${(tar.stderr ?? '').trim() || 'unknown error'}. Nothing was changed.` };
			}
		}

		// Find the binary wherever the archive put it.
		let found: string | undefined;
		function walk(dir: string): void {
			if (found !== undefined) {
				return;
			}
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.toLowerCase() === engramBinaryName().toLowerCase()) {
					found = full;
				}
			}
		}
		walk(extractDir);
		if (found === undefined) {
			return { ok: false, message: 'The archive did not contain the engine. Nothing was changed.' };
		}
		const newVersion = probeEngineVersion(found);
		if (newVersion === undefined || newVersion !== release.version) {
			return { ok: false, message: 'The downloaded engine did not report the expected version. Nothing was changed.' };
		}

		progress('Installing…');
		const targetDir = userEngineDir(home);
		const target = userEngineBinary(home);
		fs.mkdirSync(targetDir, { recursive: true });
		const backup = `${target}.bak`;
		let hadBackup = false;
		if (fs.existsSync(target)) {
			fs.renameSync(target, backup);
			hadBackup = true;
		}
		try {
			fs.copyFileSync(found, target);
			// On Windows the copied file keeps its mode; make it executable where that matters.
			fs.chmodSync(target, 0o755);
		} catch (error) {
			if (hadBackup) {
				fs.renameSync(backup, target);
			}
			return { ok: false, message: `The engine could not be installed: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.` };
		}
		const installedVersion = probeEngineVersion(target);
		if (installedVersion !== release.version) {
			// Roll back.
			try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
			if (hadBackup) {
				fs.renameSync(backup, target);
			}
			return { ok: false, message: 'The installed engine did not answer. The previous one was restored.' };
		}
		if (hadBackup) {
			try { fs.rmSync(backup, { force: true }); } catch { /* leave it; harmless */ }
		}
		// Says which version this is, so a newer engine shipped by a later PiCode wins over it.
		try { fs.writeFileSync(path.join(targetDir, ENGRAM_VERSION_FILE), `${release.version}\n`); } catch { /* without it, this engine keeps winning */ }

		return {
			ok: true,
			message: `Memory engine ${release.version} is installed. Restart PiCode to use it (it will be picked up automatically).`,
		};
	} finally {
		try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}
