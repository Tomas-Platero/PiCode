#!/usr/bin/env node
/*
 * hotfix -- the small update package: make it, check it, sign it.
 *
 * A release can reach people two ways: the full build, or a small package holding only the
 * files that differ from the previous release. This tool makes the small one. It never
 * decides what is safe by itself: the rules (which folders may change, which files never
 * travel, how a package is applied) live in
 * `src/vs/platform/update/node/deltaPackage.ts`, the same file the editor uses to apply it.
 *
 * Usage:
 *   node build/hotfix.mjs make   --old <dir> --new <dir> --out <dir> --from <v> --to <v> --kind hotfix|minor [--key <private.pem>]
 *   node build/hotfix.mjs check  --old <dir> --new <dir> --delta <dir> [--public-key <base64>]
 *   node build/hotfix.mjs apply  --target <dir> --delta <dir> --from <v> [--public-key <base64>]
 *   node build/hotfix.mjs keygen --out <private.pem>
 *
 * `<dir>` is an unpacked build (the folder that holds the .exe). Exit codes:
 *   0 done · 1 failed · 2 bad usage · 3 this release cannot be a small package (reasons on stderr)
 */

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	DELTA_PACKAGE_FILE,
	DELTA_PRODUCT_FILE,
	DELTA_SCHEMA,
	PACKAGE_JSON_VOLATILE_FIELDS,
	PRODUCT_JSON_VOLATILE_FIELDS,
	applyDelta,
	hashFile,
	isDeltaPathAllowed,
	readManifest,
} from '../src/vs/platform/update/node/deltaPackage.ts';

/** The portable profile belongs to the person, never to the product. */
const SKIP_TOP_LEVEL = new Set(['data']);

function usage(message) {
	if (message) {
		console.error(`error: ${message}`);
	}
	console.error('usage: node build/hotfix.mjs <make|check|apply|keygen> [--flag value ...]');
	process.exit(2);
}

function parseFlags(argv) {
	const flags = {};
	for (let index = 0; index < argv.length; index += 2) {
		const token = argv[index];
		if (!token.startsWith('--') || argv[index + 1] === undefined) {
			usage(`unexpected argument "${token}"`);
		}
		flags[token.slice(2)] = argv[index + 1];
	}
	return flags;
}

function need(flags, name) {
	if (!flags[name]) {
		usage(`--${name} is required`);
	}
	return flags[name];
}

/** Every file of a build as { relative path -> { absolute path, size } }, hashed on demand. */
async function walk(root) {
	const files = new Map();
	async function visit(directory, prefix) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (prefix === '' && SKIP_TOP_LEVEL.has(entry.name)) {
				continue;
			}
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute, relative);
			} else if (entry.isFile()) {
				files.set(relative, { absolute, size: (await stat(absolute)).size });
			}
		}
	}
	await visit(resolve(root), '');
	return files;
}

async function hashAll(files) {
	const queue = [...files.entries()];
	const workers = Array.from({ length: 8 }, async () => {
		for (let item = queue.pop(); item; item = queue.pop()) {
			item[1].sha256 = await hashFile(item[1].absolute);
		}
	});
	await Promise.all(workers);
}

/** A JSON file may differ between two releases only in the fields that always change. */
async function sameExceptVolatile(oldFile, newFile, fields) {
	const [before, after] = await Promise.all([oldFile, newFile].map(async file => JSON.parse(await readFile(file.absolute, 'utf8'))));
	const strip = value => JSON.stringify(sortKeys(value, fields));
	return strip(before) === strip(after);
}

function sortKeys(value, drop) {
	const copy = { ...value };
	for (const field of drop) {
		delete copy[field];
	}
	return Object.fromEntries(Object.entries(copy).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export async function diffBuilds(oldDir, newDir) {
	const [before, after] = [await walk(oldDir), await walk(newDir)];
	await Promise.all([hashAll(before), hashAll(after)]);

	const changed = [];
	const added = [];
	const removed = [];
	for (const [path, file] of after) {
		const previous = before.get(path);
		if (!previous) {
			added.push(path);
		} else if (previous.sha256 !== file.sha256) {
			changed.push(path);
		}
	}
	for (const path of before.keys()) {
		if (!after.has(path)) {
			removed.push(path);
		}
	}
	return { before, after, changed, added, removed };
}

/** Why this release cannot be a small package. Empty means it can. */
export async function reasonsAgainst(diff) {
	const reasons = [];
	for (const path of [...diff.added, ...diff.changed, ...diff.removed]) {
		if (!isDeltaPathAllowed(path)) {
			reasons.push(`${path} is outside what a small update may change`);
		}
	}
	for (const [path, fields] of [[DELTA_PRODUCT_FILE, PRODUCT_JSON_VOLATILE_FIELDS], [DELTA_PACKAGE_FILE, PACKAGE_JSON_VOLATILE_FIELDS]]) {
		if (diff.changed.includes(path) && !await sameExceptVolatile(diff.before.get(path), diff.after.get(path), fields)) {
			reasons.push(`${path} changed in more than ${fields.join(', ')}`);
		}
	}
	return reasons;
}

async function cmdMake(flags) {
	const [oldDir, newDir, out] = ['old', 'new', 'out'].map(name => need(flags, name));
	const kind = need(flags, 'kind');
	if (kind !== 'hotfix' && kind !== 'minor') {
		usage('--kind must be hotfix or minor');
	}

	const diff = await diffBuilds(oldDir, newDir);
	const reasons = await reasonsAgainst(diff);
	if (reasons.length > 0) {
		console.error('this release needs the full download:');
		for (const reason of reasons.slice(0, 20)) {
			console.error(`  - ${reason}`);
		}
		if (reasons.length > 20) {
			console.error(`  ... and ${reasons.length - 20} more`);
		}
		process.exit(3);
	}

	await rm(out, { recursive: true, force: true });
	const files = [];
	let bytes = 0;
	for (const path of [...diff.added, ...diff.changed].sort()) {
		const file = diff.after.get(path);
		await mkdir(dirname(join(out, 'files', path)), { recursive: true });
		await copyFile(file.absolute, join(out, 'files', path));
		const before = diff.before.get(path);
		files.push({ path, sha256: file.sha256, size: file.size, ...(before ? { before: before.sha256 } : {}) });
		bytes += file.size;
	}
	const removed = diff.removed.sort().map(path => ({ path, sha256: diff.before.get(path).sha256 }));

	const manifest = { schema: DELTA_SCHEMA, kind, from: need(flags, 'from'), to: need(flags, 'to'), files, removed };
	const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(join(out, 'manifest.json'), raw);

	const keyFile = flags.key ?? process.env.HOTFIX_SIGNING_KEY_FILE;
	if (keyFile) {
		const key = createPrivateKey(await readFile(keyFile));
		await writeFile(join(out, 'manifest.sig'), `${sign(null, raw, key).toString('base64')}\n`);
	}

	console.log(JSON.stringify({ files: files.length, removed: removed.length, bytes, signed: Boolean(keyFile) }));
}

/** Copies a build the way the editor stages one: everything but the portable profile. */
async function copyBuild(from, to) {
	await cp(from, to, { recursive: true, filter: source => resolve(source) !== resolve(from, 'data') });
}

/**
 * The equivalence test: old build + package must give back exactly the new build, file
 * by file. If this fails the release does not ship the package.
 */
async function cmdCheck(flags) {
	const [oldDir, newDir, deltaDir] = ['old', 'new', 'delta'].map(name => need(flags, name));
	const work = await mkdtemp(join(tmpdir(), 'picode-delta-'));
	try {
		const manifest = await readManifest(deltaDir, flags['public-key']);
		await copyBuild(oldDir, work);
		await applyDelta({ targetDir: work, deltaDir, manifest, expectedFrom: manifest.from });

		const [rebuilt, expected] = [await walk(work), await walk(newDir)];
		await Promise.all([hashAll(rebuilt), hashAll(expected)]);
		const problems = [];
		for (const [path, file] of expected) {
			const got = rebuilt.get(path);
			if (!got) {
				problems.push(`missing after applying: ${path}`);
			} else if (got.sha256 !== file.sha256) {
				problems.push(`different after applying: ${path}`);
			}
		}
		for (const path of rebuilt.keys()) {
			if (!expected.has(path)) {
				problems.push(`left over after applying: ${path}`);
			}
		}
		if (problems.length > 0) {
			console.error(`old build + package is NOT the new build (${problems.length} differences):`);
			problems.slice(0, 20).forEach(problem => console.error(`  - ${problem}`));
			process.exit(1);
		}
		console.log(`equivalent: ${expected.size} files identical`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function cmdApply(flags) {
	const [targetDir, deltaDir, from] = ['target', 'delta', 'from'].map(name => need(flags, name));
	const manifest = await readManifest(deltaDir, flags['public-key']);
	const result = await applyDelta({ targetDir, deltaDir, manifest, expectedFrom: from });
	console.log(JSON.stringify(result));
}

async function cmdKeygen(flags) {
	const out = need(flags, 'out');
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	await mkdir(dirname(resolve(out)), { recursive: true });
	await writeFile(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
	// The product carries the public half as base64 of its DER form.
	console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
}

const COMMANDS = { make: cmdMake, check: cmdCheck, apply: cmdApply, keygen: cmdKeygen };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const command = COMMANDS[process.argv[2]];
	if (!command) {
		usage();
	}
	try {
		await command(parseFlags(process.argv.slice(3)));
	} catch (error) {
		console.error(`error: ${error?.message ?? error}`);
		process.exit(1);
	}
}
