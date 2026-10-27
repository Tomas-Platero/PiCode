/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The small update package: only the files that differ between two releases.
 *
 * This file is shared on purpose. The editor applies a package with it, and
 * `build/hotfix.mjs` (which makes, checks and signs packages) imports the very same code, so
 * what the build produces and what the editor accepts cannot drift apart. It therefore only
 * uses `node:` modules and erasable TypeScript, so that plain `node` can run it.
 *
 * A package is a folder (shipped as a zip):
 *
 *     manifest.json      what changes, with the hash of every file before and after
 *     manifest.sig       signature of manifest.json (base64), when the product has a key
 *     files/<path>       the new content of every changed or added file
 *
 * The package is applied to a COPY of the installation, never to the running one, and every
 * step is checked: the signature, that the copy is exactly the release the package was made
 * for, that each payload matches its hash, and that the result matches it again. Any failure
 * throws a DeltaError and the caller falls back to the full download.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DELTA_SCHEMA = 1;

/** The folders a small update may change. Everything else needs a full release. */
export const DELTA_ALLOWED_PREFIXES: readonly string[] = [
	'resources/app/out/',
	'resources/app/extensions/',
	'resources/app/resources/',
	'resources/onboarding/',
];

/** Files that change in every release; only their listed fields may differ. */
export const DELTA_PRODUCT_FILE = 'resources/app/product.json';
export const DELTA_PACKAGE_FILE = 'resources/app/package.json';
export const DELTA_ALLOWED_FILES: readonly string[] = [DELTA_PRODUCT_FILE, DELTA_PACKAGE_FILE];
export const PRODUCT_JSON_VOLATILE_FIELDS: readonly string[] = ['version', 'picodeVersion', 'commit', 'date', 'checksums'];
export const PACKAGE_JSON_VOLATILE_FIELDS: readonly string[] = ['version'];

/** Native or binary files never travel in a small update, even inside an allowed folder. */
export const DELTA_BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
	'.exe', '.dll', '.node', '.asar', '.pak', '.dat', '.bin', '.so', '.dylib', '.sys', '.msi',
]);

export type DeltaKind = 'hotfix' | 'minor';

export interface IDeltaFile {
	/** Path relative to the installation folder, with forward slashes. */
	path: string;
	sha256: string;
	size: number;
	/** Hash of the file this one replaces; absent for a file that is new. */
	before?: string;
}

export interface IDeltaRemoved {
	path: string;
	sha256: string;
}

export interface IDeltaManifest {
	schema: number;
	kind: DeltaKind;
	/** The release this package applies to. */
	from: string;
	/** The release it produces. */
	to: string;
	files: IDeltaFile[];
	removed: IDeltaRemoved[];
}

export type DeltaErrorCode = 'manifest' | 'signature' | 'base' | 'payload' | 'path' | 'result';

export class DeltaError extends Error {
	readonly code: DeltaErrorCode;

	constructor(code: DeltaErrorCode, message: string) {
		super(message);
		this.name = 'DeltaError';
		this.code = code;
	}
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Returns the path in its one accepted spelling (relative, forward slashes), or `undefined`
 * when it could point outside the installation: absolute, drive letters, `..`, empty parts.
 */
export function normalizeRelative(path: string): string | undefined {
	if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
		return undefined;
	}
	const unified = path.replace(/\\/g, '/');
	if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
		return undefined;
	}
	const parts = unified.split('/');
	if (parts.some(part => part === '' || part === '.' || part === '..')) {
		return undefined;
	}
	return parts.join('/');
}

export function isDeltaPathAllowed(path: string): boolean {
	const relative = normalizeRelative(path);
	if (relative === undefined) {
		return false;
	}
	const dot = relative.lastIndexOf('.');
	if (dot > relative.lastIndexOf('/') && DELTA_BLOCKED_EXTENSIONS.has(relative.slice(dot).toLowerCase())) {
		return false;
	}
	return DELTA_ALLOWED_FILES.includes(relative) || DELTA_ALLOWED_PREFIXES.some(prefix => relative.startsWith(prefix));
}

export function hashFile(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(file)
			.on('error', reject)
			.on('data', chunk => hash.update(chunk))
			.on('end', () => resolve(hash.digest('hex')));
	});
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

/** Throws a `manifest` error unless the document has the exact shape this code understands. */
export function validateManifest(value: unknown): IDeltaManifest {
	const fail = (message: string): never => {
		throw new DeltaError('manifest', message);
	};
	if (typeof value !== 'object' || value === null) {
		return fail('the manifest is not an object');
	}
	const manifest = value as Partial<IDeltaManifest>;
	if (manifest.schema !== DELTA_SCHEMA) {
		fail(`unsupported manifest schema ${String(manifest.schema)}`);
	}
	if (manifest.kind !== 'hotfix' && manifest.kind !== 'minor') {
		fail('the manifest has no valid kind');
	}
	if (typeof manifest.from !== 'string' || !manifest.from || typeof manifest.to !== 'string' || !manifest.to) {
		fail('the manifest does not name its releases');
	}
	if (!Array.isArray(manifest.files) || !Array.isArray(manifest.removed)) {
		return fail('the manifest has no file lists');
	}

	const seen = new Set<string>();
	const check = (path: unknown, hash: unknown) => {
		if (typeof path !== 'string' || normalizeRelative(path) !== path || !isDeltaPathAllowed(path)) {
			throw new DeltaError('path', `a small update may not touch ${String(path)}`);
		}
		if (typeof hash !== 'string' || !SHA256.test(hash)) {
			throw new DeltaError('manifest', `the hash of ${path} is not valid`);
		}
		if (seen.has(path)) {
			throw new DeltaError('manifest', `${path} is listed twice`);
		}
		seen.add(path);
	};
	for (const file of manifest.files) {
		check(file?.path, file?.sha256);
		if (!Number.isSafeInteger(file.size) || file.size < 0) {
			fail(`the size of ${file.path} is not valid`);
		}
		if (file.before !== undefined && (typeof file.before !== 'string' || !SHA256.test(file.before))) {
			fail(`the previous hash of ${file.path} is not valid`);
		}
	}
	for (const removed of manifest.removed) {
		check(removed?.path, removed?.sha256);
	}
	return manifest as IDeltaManifest;
}

/**
 * Reads and checks the package's manifest. With a public key (base64 DER, as the product
 * carries it) the signature is mandatory; without one (development builds) it is skipped.
 */
export async function readManifest(deltaDir: string, publicKey?: string): Promise<IDeltaManifest> {
	const raw = await readFile(join(deltaDir, 'manifest.json')).catch(() => {
		throw new DeltaError('manifest', 'the package has no manifest');
	});
	if (publicKey) {
		const signature = await readFile(join(deltaDir, 'manifest.sig'), 'utf8').catch(() => undefined);
		let valid = false;
		try {
			const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
			valid = signature !== undefined && verify(null, raw, key, Buffer.from(signature.trim(), 'base64'));
		} catch {
			valid = false;
		}
		if (!valid) {
			throw new DeltaError('signature', 'the package is not signed by PiCode');
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString('utf8'));
	} catch {
		throw new DeltaError('manifest', 'the manifest is not valid JSON');
	}
	return validateManifest(parsed);
}

export interface IApplyDeltaOptions {
	/** A copy of the installation. The running one is never passed here. */
	targetDir: string;
	/** The unpacked package. */
	deltaDir: string;
	manifest: IDeltaManifest;
	/** The release the copy must be; anything else is refused. */
	expectedFrom: string;
}

export interface IApplyDeltaResult {
	changed: number;
	removed: number;
}

/** Applies a verified package to a copy of the installation, checking every step. */
export async function applyDelta(options: IApplyDeltaOptions): Promise<IApplyDeltaResult> {
	const { targetDir, deltaDir, manifest, expectedFrom } = options;

	if (manifest.from !== expectedFrom) {
		throw new DeltaError('base', `the package is for ${manifest.from}, not ${expectedFrom}`);
	}

	// 1. The copy is exactly the release the package was made for.
	for (const file of manifest.files) {
		const target = join(targetDir, file.path);
		if (file.before === undefined) {
			if (await exists(target)) {
				throw new DeltaError('base', `${file.path} should not exist yet`);
			}
		} else if (!await exists(target) || await hashFile(target) !== file.before) {
			throw new DeltaError('base', `${file.path} is not the file this package expects`);
		}
	}
	for (const removed of manifest.removed) {
		const target = join(targetDir, removed.path);
		if (!await exists(target) || await hashFile(target) !== removed.sha256) {
			throw new DeltaError('base', `${removed.path} is not the file this package expects`);
		}
	}

	// 2. The payload is what the manifest says, before anything is written.
	for (const file of manifest.files) {
		const payload = join(deltaDir, 'files', file.path);
		const info = await stat(payload).catch(() => undefined);
		if (!info || info.size !== file.size || await hashFile(payload) !== file.sha256) {
			throw new DeltaError('payload', `the content of ${file.path} does not match its hash`);
		}
	}

	// 3. Write.
	for (const file of manifest.files) {
		const target = join(targetDir, file.path);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(deltaDir, 'files', file.path), target);
	}
	for (const removed of manifest.removed) {
		await rm(join(targetDir, removed.path), { force: true });
	}

	// 4. The result is exactly what the manifest promised.
	for (const file of manifest.files) {
		if (await hashFile(join(targetDir, file.path)) !== file.sha256) {
			throw new DeltaError('result', `${file.path} did not come out as expected`);
		}
	}
	for (const removed of manifest.removed) {
		if (await exists(join(targetDir, removed.path))) {
			throw new DeltaError('result', `${removed.path} is still there`);
		}
	}

	return { changed: manifest.files.length, removed: manifest.removed.length };
}
