/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('build cache identity distinguishes minification and optional CLI', () => {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const run = (minify, cli) => {
		const script = 'node() { printf "%s|" "$@"; }; source <(sed -n "/^PICODE_CACHE_ENV=(/,/^KEY_PACK=/p" build/build.sh); printf "%s\\n%s\\n%s\\n" "$KEY_APP" "$KEY_EXT" "$KEY_PACK"';
		const result = spawnSync('bash', ['-c', script], {
			cwd: root,
			env: { ...process.env, VSCODE_ARCH: 'x64', PACK_DIR: 'pack', PICODE_MINIFY: minify, PICODE_BUILD_CLI: cli },
			encoding: 'utf8',
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim().split('\n');
	};
	const regular = run('yes', 'yes');
	const unminified = run('0', 'yes');
	assert.notEqual(unminified[0], regular[0]);
	assert.notEqual(unminified[1], regular[1]);
	assert.notEqual(unminified[2], regular[2]);
	const withoutCli = run('yes', 'no');
	assert.equal(withoutCli[0], regular[0]);
	assert.equal(withoutCli[1], regular[1]);
	assert.notEqual(withoutCli[2], regular[2]);
});

test('a new source commit invalidates only the packed build cache', () => {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const run = commit => {
		const script = 'node() { printf "%s|" "$@"; }; source <(sed -n "/^PICODE_CACHE_ENV=(/,/^KEY_PACK=/p" build/build.sh); printf "%s\\n%s\\n%s\\n" "$KEY_APP" "$KEY_EXT" "$KEY_PACK"';
		const result = spawnSync('bash', ['-c', script], {
			cwd: root,
			env: { ...process.env, VSCODE_ARCH: 'x64', PACK_DIR: 'pack', PICODE_MINIFY: 'yes', BUILD_SOURCEVERSION: commit },
			encoding: 'utf8',
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim().split('\n');
	};
	const first = run('first-commit');
	const second = run('second-commit');
	assert.equal(first[0], second[0]);
	assert.equal(first[1], second[1]);
	assert.notEqual(first[2], second[2]);
});

test('a cached portable never skips an explicitly requested installer', () => {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const source = fs.readFileSync(path.join(root, 'build/build.sh'), 'utf8');
	const block = source.match(/^if \[\[ "\$\{PICODE_FULL_BUILD:-0\}" != "1" [^\n]*\]\] && pack_intact[\s\S]*?^fi$/m)?.[0];
	assert.ok(block, 'expected cached-pack early return');
	const script = `pack_intact() { return 0; }\nnode() { return 0; }\npicode_phase_end() { :; }\nPACK_DIR=pack KEY_PACK=key\n${block}\nprintf 'installer step remains\\n'\n`;
	const run = skip => spawnSync('bash', ['-s'], { cwd: root, env: { ...process.env, PICODE_SKIP_INSTALLER: skip, PICODE_FULL_BUILD: '0' }, input: script, encoding: 'utf8' });
	const portable = run('yes');
	assert.equal(portable.status, 0, portable.stderr);
	assert.doesNotMatch(portable.stdout, /installer step remains/);
	const installer = run('no');
	assert.equal(installer.status, 0, installer.stderr);
	assert.match(installer.stdout, /installer step remains/);
});

test('a cached pack requires its memory engine and a required CLI', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-pack-check-test-'));
	try {
		fs.mkdirSync(path.join(fixture, 'build'));
		fs.copyFileSync(fileURLToPath(new URL('./build.sh', import.meta.url)), path.join(fixture, 'build', 'build.sh'));
		for (const name of ['pack/resources/app/out', 'pack/resources/pi-runtime/node_modules/fake/dist', 'pack/resources/memory', 'pack/bin']) {
			fs.mkdirSync(path.join(fixture, name), { recursive: true });
		}
		for (const name of ['pack/PiCode.exe', 'pack/resources/app/out/cli.js', 'pack/resources/pi-runtime/node_modules/fake/dist/index.js']) {
			fs.writeFileSync(path.join(fixture, name), '');
		}
		const script = 'node() { if [[ "$1" == "-p" ]]; then printf fake; fi; }; source <(sed -n "/^pack_intact() {/,/^}/p" build/build.sh); PACK_DIR=pack VSCODE_ARCH=x64 PICODE_REQUIRE_CLI=1; pack_intact';
		const check = () => spawnSync('bash', ['-c', script], { cwd: fixture, encoding: 'utf8' });
		assert.equal(check().status, 1);
		fs.writeFileSync(path.join(fixture, 'pack/bin/picode-cli.exe'), '');
		assert.equal(check().status, 1);
		fs.writeFileSync(path.join(fixture, 'pack/resources/memory/fake'), '');
		assert.equal(check().status, 0);
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

test('CLI identity tracks product contents, not modification times', () => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-cli-build-test-'));
	try {
		const bin = path.join(fixture, 'bin');
		fs.mkdirSync(bin);
		fs.mkdirSync(path.join(fixture, 'cli'));
		fs.mkdirSync(path.join(fixture, 'build'));
		fs.writeFileSync(path.join(fixture, 'cli', 'Cargo.toml'), '[package]\nname = "test"\n');
		fs.copyFileSync(fileURLToPath(new URL('./build-cli.sh', import.meta.url)), path.join(fixture, 'build', 'build-cli.sh'));
		fs.writeFileSync(path.join(bin, 'perl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
		fs.writeFileSync(path.join(bin, 'cargo'), '#!/usr/bin/env bash\nmkdir -p target/release\nprintf "%s" "${PICODE_CLI_IDENTITY_HASH-unset}" > ../hash.txt\ntouch target/release/code\n', { mode: 0o755 });
		const product = path.join(fixture, 'product.json');
		fs.writeFileSync(product, '{"quality":"experimental"}');
		const run = (extra = {}) => {
			const result = spawnSync('bash', ['build/build-cli.sh', '--build-only'], {
				cwd: fixture,
				env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PICODE_REQUIRE_CLI: '1', PICODE_BUILD_CLI: 'yes', ...extra },
				encoding: 'utf8',
			});
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			return fs.readFileSync(path.join(fixture, 'hash.txt'), 'utf8');
		};
		const initial = run();
		assert.match(initial, /^[a-f0-9]{64}$/);
		fs.utimesSync(product, new Date(), new Date());
		assert.equal(run(), initial);
		fs.writeFileSync(path.join(fixture, 'product.overrides.json'), '{"nameLong":"Changed"}');
		assert.notEqual(run(), initial);
		assert.equal(run({ VSCODE_CLI_PRODUCT_JSON: 'custom.json' }), 'unset');
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});
