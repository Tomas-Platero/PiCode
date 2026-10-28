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
 *   node build/hotfix.mjs make   --old <dir> --new <dir> --out <dir> --from <v> --to <v> --kind hotfix|minor [--key <private.pem>] [--rebuilt-unchanged <path,...>]
 *   node build/hotfix.mjs check  --old <dir> --new <dir> --delta <dir> [--public-key <base64>] [--rebuilt-unchanged <path,...>]
 *   node build/hotfix.mjs apply  --target <dir> --delta <dir> --from <v> [--public-key <base64>]
 *   node build/hotfix.mjs keygen --out <private.pem>
 *
 * `<dir>` is an unpacked build (the folder that holds the .exe). Exit codes:
 *   0 done · 1 failed · 2 bad usage · 3 this release cannot be a small package (reasons on stderr)
 */

import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
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

/*
 * Rebuild noise.
 *
 * Every build compiles the native files again, and the build stamps every Windows binary with
 * the product version. Two builds of the same sources therefore differ in bytes that say nothing
 * about what the file does: the link time, the debug GUID, the version resource, the commit or
 * version written into a launcher, and the order of the files inside node_modules.asar. A small
 * update keeps the copy the person already has for such a file - it never ships it - so these
 * differences must not force the full download. Anything beyond them still does.
 */

/** The stamps that change with every release, from the build's own product.json. */
async function buildStamps(dir) {
	const product = JSON.parse(await readFile(join(dir, DELTA_PRODUCT_FILE), 'utf8'));
	return [product.commit, product.version, product.picodeVersion].map(value => (typeof value === 'string' ? value : ''));
}

/** The old file with the old release's stamps written as the new release's (same length only). */
export function restamp(buffer, oldStamps, newStamps) {
	const out = Buffer.from(buffer);
	oldStamps.forEach((before, index) => {
		const after = newStamps[index];
		// Too short to be a stamp rather than ordinary bytes.
		if (!before || !after || before === after || before.length !== after.length || before.length < 5) {
			return;
		}
		for (const encoding of ['latin1', 'utf16le']) {
			const from = Buffer.from(before, encoding);
			const to = Buffer.from(after, encoding);
			for (let at = out.indexOf(from); at !== -1; at = out.indexOf(from, at + from.length)) {
				to.copy(out, at);
			}
		}
	});
	return out;
}

/** A Windows binary with the fields a rebuild always changes zeroed; any other buffer as it is. */
export function maskPortableExecutable(buffer) {
	const out = Buffer.from(buffer);
	const u16 = at => (at >= 0 && at + 2 <= out.length ? out.readUInt16LE(at) : -1);
	const u32 = at => (at >= 0 && at + 4 <= out.length ? out.readUInt32LE(at) : -1);
	if (u16(0) !== 0x5a4d) {
		return out;
	}
	// The version resource: VS_FIXEDFILEINFO's file and product version numbers.
	const fixed = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
	for (let at = out.indexOf(fixed); at !== -1 && at + 24 <= out.length; at = out.indexOf(fixed, at + 4)) {
		out.fill(0, at + 8, at + 24);
	}
	const pe = u32(0x3c);
	if (pe < 0 || u32(pe) !== 0x4550) {
		return out;
	}
	const optional = pe + 24;
	const optionalSize = u16(pe + 20);
	const sections = u16(pe + 6);
	if (optionalSize < 0 || sections < 0 || optional + 68 > out.length) {
		return out;
	}
	out.fill(0, pe + 8, pe + 12); // link time
	out.fill(0, optional + 64, optional + 68); // checksum
	const directories = optional + (u16(optional) === 0x20b ? 112 : 96);
	const debugRva = u32(directories + 6 * 8);
	const debugSize = u32(directories + 6 * 8 + 4);
	if (debugRva <= 0 || debugSize <= 0) {
		return out;
	}
	let debug = -1;
	for (let index = 0; index < sections; index++) {
		const header = optional + optionalSize + index * 40;
		const address = u32(header + 12);
		const span = Math.max(u32(header + 8), u32(header + 16));
		if (address >= 0 && debugRva >= address && debugRva < address + span) {
			debug = debugRva - address + u32(header + 20);
		}
	}
	for (let entry = debug; debug > 0 && entry + 28 <= debug + debugSize && entry + 28 <= out.length; entry += 28) {
		out.fill(0, entry + 4, entry + 8);
		const type = u32(entry + 12);
		const size = u32(entry + 16);
		const pointer = u32(entry + 24);
		if (pointer <= 0 || size <= 0 || pointer + size > out.length) {
			continue;
		}
		if (type === 2 && out.toString('latin1', pointer, pointer + 4) === 'RSDS') {
			out.fill(0, pointer + 4, Math.min(pointer + 24, pointer + size)); // debug GUID and age
		} else if (type === 13 || type === 16 || type === 20) {
			out.fill(0, pointer, pointer + size); // profile-guided and reproducibility data
		}
	}
	return out;
}

/** What an asar archive holds, in a fixed order: each file's path, flags and content hash. */
function asarContents(buffer) {
	const headerSize = buffer.readUInt32LE(4);
	const header = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)).toString('utf8'));
	const base = 8 + headerSize;
	const entries = [];
	const visit = (node, prefix) => {
		for (const [name, entry] of Object.entries(node.files ?? {})) {
			const path = `${prefix}/${name}`;
			if (entry.files) {
				visit(entry, path);
			} else if (entry.link !== undefined) {
				entries.push(`${path} -> ${entry.link}`);
			} else if (entry.unpacked) {
				entries.push(`${path} unpacked${entry.executable ? ' x' : ''}`);
			} else {
				const start = base + Number(entry.offset);
				const content = buffer.subarray(start, start + entry.size);
				entries.push(`${path}${entry.executable ? ' x' : ''} ${createHash('sha256').update(content).digest('hex')}`);
			}
		}
	};
	visit(header, '');
	return entries.sort().join('\n');
}

/** Whether two builds of one file differ only in what a rebuild always changes. */
export function isRebuildNoise(path, oldBuffer, newBuffer, oldStamps, newStamps) {
	try {
		if (path.toLowerCase().endsWith('.asar')) {
			return asarContents(oldBuffer) === asarContents(newBuffer);
		}
		return maskPortableExecutable(restamp(oldBuffer, oldStamps, newStamps)).equals(maskPortableExecutable(newBuffer));
	} catch {
		return false;
	}
}

/**
 * The changed files outside what a small update may carry whose difference is rebuild noise, or
 * that the caller vouches were rebuilt from unchanged sources (`--rebuilt-unchanged`). The
 * person keeps their copy of each.
 */
async function keptFiles(diff, oldDir, newDir, rebuiltUnchanged) {
	const [oldStamps, newStamps] = await Promise.all([buildStamps(oldDir), buildStamps(newDir)]);
	const kept = [];
	for (const path of diff.changed) {
		if (isDeltaPathAllowed(path)) {
			continue;
		}
		if (rebuiltUnchanged.includes(path)) {
			kept.push(path);
			continue;
		}
		const [before, after] = await Promise.all([readFile(diff.before.get(path).absolute), readFile(diff.after.get(path).absolute)]);
		if (isRebuildNoise(path, before, after, oldStamps, newStamps)) {
			kept.push(path);
		}
	}
	return kept;
}

function rebuiltUnchangedOf(flags) {
	return (flags['rebuilt-unchanged'] ?? '').split(',').map(path => path.trim()).filter(Boolean);
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
	const kept = await keptFiles(diff, oldDir, newDir, rebuiltUnchangedOf(flags));
	diff.changed = diff.changed.filter(path => !kept.includes(path));
	if (kept.length > 0) {
		console.error(`kept as they are (${kept.length}, rebuilt from the same sources): ${kept.slice(0, 5).join(', ')}${kept.length > 5 ? ', ...' : ''}`);
	}
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
		const vouched = rebuiltUnchangedOf(flags);
		const [oldStamps, newStamps] = await Promise.all([buildStamps(oldDir), buildStamps(newDir)]);
		let kept = 0;
		for (const [path, file] of expected) {
			const got = rebuilt.get(path);
			if (!got) {
				problems.push(`missing after applying: ${path}`);
			} else if (got.sha256 !== file.sha256) {
				// A file the package keeps must be one only a rebuild changed, proven again here.
				const noise = !isDeltaPathAllowed(path) && (vouched.includes(path)
					|| isRebuildNoise(path, await readFile(got.absolute), await readFile(file.absolute), oldStamps, newStamps));
				if (noise) {
					kept++;
				} else {
					problems.push(`different after applying: ${path}`);
				}
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
		console.log(`equivalent: ${expected.size - kept} files identical, ${kept} kept (rebuilt from the same sources)`);
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
