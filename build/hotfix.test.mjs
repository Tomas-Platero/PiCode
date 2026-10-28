/*
 * Tests for the small update package and for the script that swaps a build into place.
 *
 *   node --test build/hotfix.test.mjs
 *
 * They run the real tools on small throwaway trees: nothing here is mocked, so what passes
 * is what the release pipeline and the editor will do.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isDeltaPathAllowed, validateManifest } from '../src/vs/platform/update/node/deltaPackage.ts';
import { archiveSwapScript } from '../src/vs/platform/update/electron-main/archiveSwapScript.ts';

const HOTFIX = join(dirname(fileURLToPath(import.meta.url)), 'hotfix.mjs');
const root = mkdtempSync(join(tmpdir(), 'picode-hotfix-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(base, file, content) {
	const target = join(base, file);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function hotfix(...args) {
	return spawnSync(process.execPath, [HOTFIX, ...args], { encoding: 'utf8' });
}

/** A tiny build with the same shape as a real one: allowed folders plus things that never travel. */
function makeBuild(name, overrides = {}) {
	const dir = join(root, name);
	const files = {
		'PiCode.exe': 'engine',
		'resources/app/product.json': JSON.stringify({ nameShort: 'PiCode', version: '1.0.0', picodeVersion: '0.4.0', commit: 'a', date: 'd1', checksums: { x: '1' } }),
		'resources/app/package.json': JSON.stringify({ name: 'picode', version: '1.0.0' }),
		'resources/app/out/main.js': 'main v1',
		'resources/app/out/vs/workbench.css': 'css v1',
		'resources/app/extensions/picode/out/a.js': 'ext v1',
		'resources/app/node_modules.asar': 'asar v1',
		'resources/pi-runtime/pi.js': 'pi v1',
		...overrides,
	};
	for (const [file, content] of Object.entries(files)) {
		if (content !== null) {
			write(dir, file, content);
		}
	}
	return dir;
}

describe('which paths a small update may touch', () => {
	test('allows the editor, extensions, media and onboarding', () => {
		for (const path of ['resources/app/out/a.js', 'resources/app/extensions/x/y.js', 'resources/app/resources/icon.png', 'resources/onboarding/index.html', 'resources/app/product.json']) {
			assert.equal(isDeltaPathAllowed(path), true, path);
		}
	});

	test('refuses the engine, dependencies, pi and anything that could escape', () => {
		for (const path of ['PiCode.exe', 'ffmpeg.dll', 'resources/app/node_modules.asar', 'resources/app/node_modules/x.js', 'resources/pi-runtime/pi.js', 'resources/memory/engram.exe',
			'../x.js', 'resources/app/out/../../x.js', '/etc/passwd', 'C:/Windows/x.js', 'resources/app/out/native.node', 'resources/app/out/x.dll', '']) {
			assert.equal(isDeltaPathAllowed(path), false, path);
		}
	});

	test('a manifest that names a forbidden path is refused whole', () => {
		const hash = 'a'.repeat(64);
		assert.throws(() => validateManifest({ schema: 1, kind: 'hotfix', from: 'a', to: 'b', files: [{ path: 'PiCode.exe', sha256: hash, size: 1 }], removed: [] }), { code: 'path' });
		assert.throws(() => validateManifest({ schema: 2, kind: 'hotfix', from: 'a', to: 'b', files: [], removed: [] }), { code: 'manifest' });
		assert.throws(() => validateManifest({ schema: 1, kind: 'weird', from: 'a', to: 'b', files: [], removed: [] }), { code: 'manifest' });
	});
});

describe('making and applying a package', () => {
	const oldDir = makeBuild('old');
	const newDir = makeBuild('new', {
		'resources/app/product.json': JSON.stringify({ nameShort: 'PiCode', version: '1.0.1', picodeVersion: '0.4.1', commit: 'b', date: 'd2', checksums: { x: '2' } }),
		'resources/app/package.json': JSON.stringify({ name: 'picode', version: '1.0.1' }),
		'resources/app/out/main.js': 'main v2',
		'resources/app/out/vs/workbench.css': null,
		'resources/app/out/vs/new.css': 'brand new',
	});
	const pair = (extra = []) => ['--old', oldDir, '--new', newDir, '--from', '0.4.0', '--to', '0.4.1', '--kind', 'hotfix', ...extra];

	test('a package holds only what changed, and old + package equals new', () => {
		const out = join(root, 'delta-ok');
		const made = hotfix('make', ...pair(), '--out', out);
		assert.equal(made.status, 0, made.stderr);
		const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
		assert.deepEqual(manifest.files.map(file => file.path).sort(), ['resources/app/out/main.js', 'resources/app/out/vs/new.css', 'resources/app/package.json', 'resources/app/product.json']);
		assert.deepEqual(manifest.removed.map(file => file.path), ['resources/app/out/vs/workbench.css']);
		assert.equal(existsSync(join(out, 'files', 'resources/app/extensions/picode/out/a.js')), false, 'unchanged files do not travel');

		const check = hotfix('check', '--old', oldDir, '--new', newDir, '--delta', out);
		assert.equal(check.status, 0, check.stderr);
	});

	test('a release that changes the engine, dependencies or pi is not offered as a package', () => {
		for (const [file, content] of [['PiCode.exe', 'engine v2'], ['resources/app/node_modules.asar', 'asar v2'], ['resources/pi-runtime/pi.js', 'pi v2']]) {
			const changed = makeBuild(`new-${file.replaceAll('/', '_')}`, { [file]: content });
			const made = hotfix('make', '--old', oldDir, '--new', changed, '--from', '0.4.0', '--to', '0.4.1', '--kind', 'hotfix', '--out', join(root, 'delta-no'));
			assert.equal(made.status, 3, `${file}: ${made.stderr}`);
			assert.match(made.stderr, /full download/);
		}
	});

	test('a change to the product identity is refused, a version bump is not', () => {
		const changed = makeBuild('new-identity', { 'resources/app/product.json': JSON.stringify({ nameShort: 'Other', version: '1.0.1', picodeVersion: '0.4.1', commit: 'b', date: 'd2', checksums: { x: '2' } }) });
		const made = hotfix('make', '--old', oldDir, '--new', changed, '--from', '0.4.0', '--to', '0.4.1', '--kind', 'hotfix', '--out', join(root, 'delta-id'));
		assert.equal(made.status, 3, made.stderr);
	});

	test('a payload that was altered after the package was made is refused', () => {
		const out = join(root, 'delta-tamper');
		assert.equal(hotfix('make', ...pair(), '--out', out).status, 0);
		writeFileSync(join(out, 'files', 'resources/app/out/main.js'), 'main EVIL');
		const applied = hotfix('apply', '--target', cpTree(oldDir, 'target-tamper'), '--delta', out, '--from', '0.4.0');
		assert.equal(applied.status, 1);
		assert.match(applied.stderr, /does not match its hash/);
	});

	test('a copy that is not the release the package expects is refused, and left untouched', () => {
		const out = join(root, 'delta-base');
		assert.equal(hotfix('make', ...pair(), '--out', out).status, 0);
		const target = cpTree(oldDir, 'target-base');
		writeFileSync(join(target, 'resources/app/out/main.js'), 'edited by the user');
		const applied = hotfix('apply', '--target', target, '--delta', out, '--from', '0.4.0');
		assert.equal(applied.status, 1);
		assert.equal(readFileSync(join(target, 'resources/app/out/main.js'), 'utf8'), 'edited by the user');
		assert.equal(hotfix('apply', '--target', cpTree(oldDir, 'target-ver'), '--delta', out, '--from', '0.3.0').status, 1, 'wrong release');
	});

	test('the signature is required when the product has a key, and a changed manifest breaks it', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const keyFile = join(root, 'test-key.pem');
		writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
		const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

		const signed = join(root, 'delta-signed');
		assert.equal(hotfix('make', ...pair(['--key', keyFile]), '--out', signed).status, 0);
		assert.equal(hotfix('check', '--old', oldDir, '--new', newDir, '--delta', signed, '--public-key', publicKeyB64).status, 0);

		const unsigned = join(root, 'delta-unsigned');
		assert.equal(hotfix('make', ...pair(), '--out', unsigned).status, 0);
		assert.equal(hotfix('check', '--old', oldDir, '--new', newDir, '--delta', unsigned, '--public-key', publicKeyB64).status, 1, 'unsigned');

		const tampered = join(root, 'delta-signed-tampered');
		cpSync(signed, tampered, { recursive: true });
		writeFileSync(join(tampered, 'manifest.json'), readFileSync(join(tampered, 'manifest.json'), 'utf8').replace('0.4.1', '0.4.2'));
		assert.equal(hotfix('check', '--old', oldDir, '--new', newDir, '--delta', tampered, '--public-key', publicKeyB64).status, 1, 'tampered manifest');

		const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
		assert.equal(hotfix('check', '--old', oldDir, '--new', newDir, '--delta', signed, '--public-key', other).status, 1, 'someone else\'s key');
	});

	function cpTree(from, name) {
		const to = join(root, name);
		cpSync(from, to, { recursive: true });
		return to;
	}
});

describe('files a rebuild changes without changing what they do', () => {
	/** A minimal Windows binary: a link time, a checksum and a version string, nothing else. */
	function binary(linkTime, checksum, version) {
		const buffer = Buffer.alloc(512);
		buffer.write('MZ', 0, 'latin1');
		buffer.writeUInt32LE(0x80, 0x3c);
		buffer.write('PE\0\0', 0x80, 'latin1');
		buffer.writeUInt32LE(linkTime, 0x80 + 8);
		buffer.writeUInt16LE(240, 0x80 + 20);
		buffer.writeUInt16LE(0x20b, 0x80 + 24);
		buffer.writeUInt32LE(checksum, 0x80 + 24 + 64);
		buffer.write(`FileVersion ${version}`, 0x180, 'utf16le');
		return buffer;
	}
	/** An asar archive holding the given files, in the given order. */
	function asar(files) {
		let offset = 0;
		const entries = {};
		for (const [name, content] of files) {
			entries[name] = { size: content.length, offset: String(offset) };
			offset += content.length;
		}
		const json = Buffer.from(JSON.stringify({ files: entries }));
		const headerSize = 8 + json.length;
		const head = Buffer.alloc(16);
		head.writeUInt32LE(4, 0);
		head.writeUInt32LE(headerSize, 4);
		head.writeUInt32LE(headerSize - 4, 8);
		head.writeUInt32LE(json.length, 12);
		return Buffer.concat([head, json, ...files.map(([, content]) => Buffer.from(content))]);
	}
	const product = (version, commit) => JSON.stringify({ nameShort: 'PiCode', version, picodeVersion: '0.4.0', commit, date: 'd', checksums: {} });
	const launcher = (version, commit) => `COMMIT="${commit}"\nVERSION="${version}"\nexec app "$@"\n`;
	const oldDir = makeBuild('noise-old', {
		'resources/app/product.json': product('1.0.7', 'aaaaaaaa'),
		'PiCode.exe': binary(1000, 11, '1.0.7'),
		'bin/picode': launcher('1.0.7', 'aaaaaaaa'),
		'bin/picode-cli.exe': 'cli built once',
		'resources/app/node_modules.asar': asar([['a.js', 'one'], ['b.js', 'two']]),
	});
	const rebuilt = {
		'resources/app/product.json': product('1.0.8', 'bbbbbbbb'),
		'PiCode.exe': binary(2000, 22, '1.0.8'),
		'bin/picode': launcher('1.0.8', 'bbbbbbbb'),
		'bin/picode-cli.exe': 'cli built twice',
		'resources/app/node_modules.asar': asar([['b.js', 'two'], ['a.js', 'one']]),
	};
	const args = (newDir, out, extra = []) => ['--old', oldDir, '--new', newDir, '--from', '0.4.0', '--to', '0.4.1', '--kind', 'hotfix', '--out', out, ...extra];

	test('a rebuild of the same sources is a small package that keeps the person\'s copies', () => {
		const newDir = makeBuild('noise-new', rebuilt);
		const out = join(root, 'delta-noise');
		const vouch = ['--rebuilt-unchanged', 'bin/picode-cli.exe'];
		const made = hotfix('make', ...args(newDir, out, vouch));
		assert.equal(made.status, 0, made.stderr);
		const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
		assert.deepEqual(manifest.files.map(file => file.path), ['resources/app/product.json'], 'the binaries never travel');
		const check = hotfix('check', '--old', oldDir, '--new', newDir, '--delta', out, ...vouch);
		assert.equal(check.status, 0, check.stderr);
		assert.match(check.stdout, /4 kept/);
	});

	test('a real change hidden among the stamps still needs the full download', () => {
		for (const [file, content] of [
			['PiCode.exe', Buffer.concat([binary(2000, 22, '1.0.8').subarray(0, 500), Buffer.from('new code!!!!')])],
			['bin/picode', `${launcher('1.0.8', 'bbbbbbbb')}echo more\n`],
			['resources/app/node_modules.asar', asar([['b.js', 'two'], ['a.js', 'ONE']])],
			['bin/picode-cli.exe', 'cli built twice'],
		]) {
			const newDir = makeBuild(`noise-real-${file.replaceAll('/', '_')}`, { ...rebuilt, [file]: content });
			const made = hotfix('make', ...args(newDir, join(root, 'delta-noise-real'), file === 'bin/picode-cli.exe' ? [] : ['--rebuilt-unchanged', 'bin/picode-cli.exe']));
			assert.equal(made.status, 3, `${file}: ${made.stderr}`);
		}
	});
});

describe('the release kind', () => {
	const kind = (...args) => execFileSync(process.execPath, [join(dirname(HOTFIX), 'release.mjs'), 'kind', ...args], { encoding: 'utf8' }).trim();

	test('no small package means a release; an override always wins', () => {
		assert.equal(kind('--delta', 'no'), 'release');
		assert.equal(kind('--delta', 'yes', '--override', 'hotfix'), 'hotfix');
		assert.equal(kind('--delta', 'no', '--override', 'minor'), 'minor');
	});
});

// The script starts the build with `start`, which opens a console window per run: on a desktop
// that is a window popping up mid-work, so these run in CI only (set CI=1 to run them here).
describe('the swap script (Windows)', { skip: process.platform !== 'win32' || !process.env.CI }, () => {
	let counter = 0;

	/** A fake installation: `PiCode.cmd` stands in for the executable. */
	function scenario(newBuildIsHealthy) {
		const base = join(root, `swap-${counter++}`);
		const app = join(base, 'app');
		const staging = join(base, 'app.update');
		write(app, 'PiCode.cmd', '@echo off\r\necho old> "%~dp0old-started.txt"\r\n');
		write(app, 'version.txt', 'old');
		write(app, 'data/profile.txt', 'the owner\'s settings');
		write(staging, 'version.txt', 'new');
		write(staging, 'PiCode.cmd', newBuildIsHealthy
			? '@echo off\r\nif exist "%~dp0update-verify" (\r\n  if not exist "%~dp0data" mkdir "%~dp0data"\r\n  echo ok> "%~dp0data\\.update-ok"\r\n  del "%~dp0update-verify"\r\n)\r\n'
			: '@echo off\r\nrem a build that never comes up\r\n');
		const script = join(base, 'update.cmd');
		writeFileSync(script, archiveSwapScript(app, staging, 'PiCode.cmd', 4999999, 2));
		return { base, app, script };
	}

	const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

	test('a build that comes up replaces the old one and keeps the profile', () => {
		const { app, script, base } = scenario(true);
		const result = spawnSync('cmd.exe', ['/c', script], { encoding: 'utf8', timeout: 90000 });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(readFileSync(join(app, 'version.txt'), 'utf8'), 'new');
		assert.equal(readFileSync(join(app, 'data/profile.txt'), 'utf8'), 'the owner\'s settings');
		assert.equal(existsSync(`${app}.old`), false, 'the old build is cleaned up once the new one proved itself');
		assert.equal(existsSync(join(app, 'update-verify')), false);
		assert.equal(existsSync(base), true);
	});

	test('a build that never comes up is replaced by the old one, profile included', () => {
		const { app, script } = scenario(false);
		const result = spawnSync('cmd.exe', ['/c', script], { encoding: 'utf8', timeout: 90000 });
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.equal(readFileSync(join(app, 'version.txt'), 'utf8'), 'old', 'the old build is back');
		assert.equal(readFileSync(join(app, 'data/profile.txt'), 'utf8'), 'the owner\'s settings');
		sleep(1500); // the old build is started again by the script
		assert.equal(existsSync(join(app, 'old-started.txt')), true, 'and it was started');
		assert.equal(existsSync(`${app}.bad`), false);
		assert.equal(existsSync(`${app}.old`), false);
	});
});

before(() => { });
