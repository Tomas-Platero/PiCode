#!/usr/bin/env node
/*
 * Throws away the binaries of the platforms this build is not for.
 *
 * Installing a package that ships a native binary installs **one per platform**: esbuild alone puts
 * 284 MB inside pi's install, of which one directory (a few megabytes) is the one this machine
 * runs. The rest is weight a Windows product carries to be able to run on macOS and Linux, which it
 * will never do — measured, that is a quarter of the distribution.
 *
 * What it keeps is the platform and architecture this build targets, plus the host's own, because a
 * cross-build (an arm64 pack made on x64) needs both. Everything else named for a platform goes.
 *
 * Names are matched, not listed: `<name>-<platform>-<arch>[…]` where the platform is one of
 * darwin, win32, linux, freebsd, android, netbsd, openbsd, sunos and the architecture is x64, arm64,
 * arm, ia32, ppc64, riscv64, s390x, loong64 or wasm32. A package that is not named that way is never
 * touched, and neither is the platform directory that was kept.
 *
 * Usage: node dev/prune-platform-binaries.mjs <node_modules> [<platform>] [<arch>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const [directory, platformArg, archArg] = process.argv.slice(2);
if (!directory) {
	process.stderr.write('usage: node dev/prune-platform-binaries.mjs <node_modules> [platform] [arch]\n');
	process.exit(2);
}

const KEEP_PLATFORMS = new Set([platformArg ?? process.platform, process.platform]);
const KEEP_ARCHITECTURES = new Set([archArg ?? process.arch, process.arch]);

/** The platform and architecture words a native package can be named with. */
const PLATFORM_WORDS = ['darwin', 'win32', 'linux', 'freebsd', 'android', 'netbsd', 'openbsd', 'sunos'];
const ARCHITECTURE_WORDS = ['x64', 'arm64', 'arm', 'ia32', 'ppc64', 'riscv64', 's390x', 'loong64', 'wasm32'];

// A word counts when it stands on its own inside the name: `darwin-arm64`, `esbuild-linux-x64`,
// `lightningcss-win32-x64-msvc`. Looking for `-darwin-` misses the first of those, which is how the
// first version of this pruned nothing at all.
const PLATFORM_PATTERN = new RegExp(`(^|[-_])(${PLATFORM_WORDS.join('|')})([-_]|$)`, 'i');
const ARCHITECTURE_PATTERN = new RegExp(`(^|[-_])(${ARCHITECTURE_WORDS.join('|')})([-_]|$)`, 'i');

/**
 * Whether a package name says which platform it is for, and not one of the ones we keep.
 *
 * Deliberately conservative: a name with no platform word, or with no architecture word beside it,
 * is left alone, so a package whose name happens to contain a word like `arm` is never guessed at.
 */
function isForeignPlatform(name) {
	const match = name.match(PLATFORM_PATTERN);
	if (match === null) {
		return false;
	}
	if (KEEP_PLATFORMS.has(match[2].toLowerCase())) {
		return false;
	}
	return ARCHITECTURE_PATTERN.test(name);
}

function sizeOf(target) {
	let total = 0;
	const walk = current => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			try {
				if (entry.isDirectory()) {
					walk(full);
				} else {
					total += fs.statSync(full).size;
				}
			} catch {
				// A file that vanished mid-walk is one we are deleting; its size does not matter.
			}
		}
	};
	try {
		walk(target);
	} catch {
		return 0;
	}
	return total;
}

/** Every `node_modules` in the tree, so a nested dependency is pruned too. */
function nodeModulesDirectories(root) {
	const found = [root];
	const walk = current => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			const full = path.join(current, entry.name);
			if (entry.name === 'node_modules') {
				found.push(full);
			}
			walk(full);
		}
	};
	walk(root);
	return found;
}

let removed = 0;
let megabytes = 0;
const kept = [];

for (const modules of nodeModulesDirectories(path.resolve(directory))) {
	for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const full = path.join(modules, entry.name);
		const candidates = entry.name.startsWith('@')
			? fs.readdirSync(full, { withFileTypes: true }).filter(inner => inner.isDirectory()).map(inner => path.join(full, inner.name))
			: [full];
		for (const candidate of candidates) {
			const name = path.basename(candidate);
			if (!isForeignPlatform(name)) {
				continue;
			}
			const size = sizeOf(candidate);
			fs.rmSync(candidate, { recursive: true, force: true });
			removed += 1;
			megabytes += size / (1024 * 1024);
			if (kept.length < 8) {
				kept.push(`${name} (${Math.round(size / (1024 * 1024))} MB)`);
			}
		}
	}
}

process.stdout.write(`pruned ${removed} package(s) for other platforms: ${Math.round(megabytes)} MB\n`);
if (kept.length > 0) {
	process.stdout.write(`  ${kept.join(', ')}\n`);
}
process.stdout.write(`kept: ${[...KEEP_PLATFORMS].join(', ')} on ${[...KEEP_ARCHITECTURES].join(', ')}\n`);
