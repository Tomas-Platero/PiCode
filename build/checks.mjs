#!/usr/bin/env node
/*
 * checks -- verifications that are neither documentation nor dependencies.
 *
 * The connector's MCP entries against pi's own rules, and the pruning of the
 * binaries of platforms this build does not target.
 *
 * Usage:
 *   node build/checks.mjs check-mcp
 *   node build/checks.mjs patch-languageserver
 *   node build/checks.mjs prune-binaries
 *
 * One file per domain: the scripts that used to sit side by side in build/ were fused
 * here, each keeping its own explanation directly above the code it runs. Commands are
 * functions, so this file can also be imported (build/checks.mjs imports resolvePack)
 * without anything running.
 */

import { pathToFileURL } from 'node:url';
	// check-mcp -- was build/check-mcp-entries.mjs
	/*
	 * Checks that what the connector writes into pi's `mcp.json` is what pi's own MCP accepts.
	 *
	 * Why this exists: pi's own MCP refuses two spellings the old adapter used — `auth: "oauth"`
	 * (`auth.provider must be a provider name`) and `oauth: false` (`oauth must be an object`) — and an
	 * entry it refuses is **skipped**, which from the owner's side looks like a server that is
	 * configured and does nothing. That happened, it was found by hand, and the point of this check is
	 * that it cannot come back unnoticed: it runs the connector's own writers through pi's own
	 * validator, so neither a refactor nor a new field can reintroduce a spelling pi rejects.
	 *
	 * It also proves the check itself is not vacuous: the two legacy spellings have to be **rejected**
	 * by the validator it just loaded. If a future pi accepts them, this script says so instead of
	 * passing quietly and meaning nothing.
	 *
	 * Usage: node build/checks.mjs check-mcp [--pack <dir>]
	 *
	 * Needs the pack (the pinned pi lives inside it, `PiCode-win32-x64[-<channel>]/resources/pi-runtime`) and Node's
	 * type stripping for the `.ts` imports, which is why `build/build.sh` runs before it in CI.
	 */
	async function cmdCheckMcp(cli) {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	const { resolvePack } = await import('./build-helpers.mjs');
	const REPO = path.resolve(import.meta.dirname, '..');
	const args = cli;
	const packFlag = args.indexOf('--pack');
	const PACK = path.resolve(packFlag === -1 ? resolvePack(REPO) : args[packFlag + 1]);

	const PI_PACKAGE = '@earendil-works/pi-coding-agent';
	const VALIDATOR = path.join(PACK, 'resources', 'pi-runtime', 'node_modules', ...PI_PACKAGE.split('/'), 'dist', 'core', 'mcp-servers.js');
	const CONNECTOR = path.join(REPO, 'extensions', 'picode', 'src');

	if (!fs.existsSync(VALIDATOR)) {
		process.stderr.write(`error: ${VALIDATOR} is missing. Build the editor first (./build/build.sh), or point --pack at a pack.\n`);
		process.exit(1);
	}

	const { validateMcpServerConfig } = await import(pathToFileURL(VALIDATOR).href);
	const { mcpServerEntry, normalizedServerEntry } = await import(pathToFileURL(path.join(CONNECTOR, 'mcpServers.ts')).href);
	const { serverFileEntry } = await import(pathToFileURL(path.join(CONNECTOR, 'mcp-add.ts')).href);

	/** The settings row, as the form fills it. */
	const row = key => ({ name: 'vercel', transport: 'http', target: 'https://mcp.vercel.com', args: '', key });

	/**
	 * What the connector writes, and what pi has to say about it.
	 *
	 * `must` is the whole check: `accept` for every entry the connector produces, because an entry pi
	 * refuses is a server the owner configured that will never run.
	 */
	const cases = [
		{ what: 'the settings row: a remote server with a token', entry: mcpServerEntry(row('tok_123')), must: 'accept' },
		{ what: 'the settings row: a remote server that signs in', entry: mcpServerEntry(row('')), must: 'accept' },
		{ what: 'the settings row: a local server', entry: mcpServerEntry({ name: 'files', transport: 'stdio', target: 'npx', args: '-y @modelcontextprotocol/server-filesystem .', key: '' }), must: 'accept' },
		{ what: 'Add Server: a remote server with no headers', entry: serverFileEntry({ name: 'vercel', transport: 'http', url: 'https://mcp.vercel.com' }), must: 'accept' },
		{ what: 'Add Server: a remote server with headers', entry: serverFileEntry({ name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } }), must: 'accept' },
		{ what: 'Add Server: a local server with an environment', entry: serverFileEntry({ name: 'tools', transport: 'stdio', command: 'uvx', args: ['tools-mcp'], env: { API_KEY: '${TOOLS_KEY}' } }), must: 'accept' },
		{ what: 'the repair: a legacy entry that asked for OAuth', entry: normalizedServerEntry({ type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2', auth: 'oauth', oauth: {} }), must: 'accept' },
		{ what: 'the repair: a legacy entry with only `auth`', entry: normalizedServerEntry({ url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' }), must: 'accept' },
		{ what: 'the repair: a legacy entry that refused OAuth', entry: normalizedServerEntry({ url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t' }, auth: false, oauth: false }), must: 'accept' },
		{ what: 'a repair leaves a provider token alone', entry: normalizedServerEntry({ url: 'https://example.test/mcp', auth: { provider: 'vercel' } }), must: 'accept' },
		// The positive control: if the validator accepted these, everything above would pass for the
		// wrong reason and this check would be worth nothing.
		{ what: 'control: the legacy `auth: \"oauth\"` pi refuses', entry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', oauth: {} }, must: 'reject' },
		{ what: 'control: the legacy `oauth: false` pi refuses', entry: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t' }, auth: false, oauth: false }, must: 'reject' },
	];

	let failed = 0;
	for (const { what, entry, must } of cases) {
		const verdict = validateMcpServerConfig('check', entry);
		const rejected = typeof verdict === 'string';
		const ok = must === 'reject' ? rejected : !rejected;
		if (!ok) {
			failed += 1;
		}
		const said = rejected ? `pi refuses it: ${verdict}` : 'pi accepts it';
		process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${what} — ${said}\n`);
		if (ok) {
			process.stdout.write(`      ${JSON.stringify(entry)}\n`);
		}
	}

	process.stdout.write(failed === 0
		? `\n${cases.length} entries checked against ${PI_PACKAGE}'s own validator: all as expected.\n`
		: `\n${failed} of ${cases.length} entries are not what pi expects.\n`);
	process.exit(failed === 0 ? 0 : 1);
	}

	// patch-languageserver -- was build/patch-vscode-languageserver.mjs
	/*---------------------------------------------------------------------------------------------
	 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
	 *--------------------------------------------------------------------------------------------*/
	//
	/**
	 * Patches `vscode-languageserver`'s `uriToFilePath` to use the WHATWG URL instead of the
	 * legacy `url.parse` (DEP0169). The markdown language server calls it on every startup and
	 * its deprecation warning surfaced in the editor's console under the extension host's name,
	 * because the server's stderr is forwarded through the extension host process.
	 *
	 * The dependency tree owns this file, so an `npm install` restores the old text: the build
	 * runs this patch before compiling the extensions, and every patch here is idempotent —
	 * running it twice is a no-op, and a restored file is patched again.
	 *
	 * The same shape as build/branding.mjs patch-inno-updater: a build-time patch for a file that no
	 * toolchain rewrite touches, kept where the rest of the build's patches live.
	 */
	async function cmdPatchLanguageserver(cli) {
	const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
	const path = (await import('node:path')).default;
	const { fileURLToPath } = await import('node:url');
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

	const FILES = [
		'extensions/markdown-language-features/node_modules/vscode-languageserver/lib/node/files.js',
		'extensions/markdown-language-features/node_modules/vscode-markdown-languageserver/dist/node/workerMain.js',
		'node_modules/@vscode/proxy-agent/out/index.js',
	];

	// The old call, in the two spellings the two files use (spaces and minified quotes differ).
	const PATTERNS = [
		{
			name: 'vscode-languageserver/lib/node/files.js uriToFilePath',
			old: `function uriToFilePath(uri) {
    let parsed = url.parse(uri);
    if (parsed.protocol !== 'file:' || !parsed.path) {
        return undefined;
    }
    let segments = parsed.path.split('/');`,
			replacement: `function uriToFilePath(uri) {
    let parsed;
    try {
        parsed = new URL(uri);
    } catch (e) {
        return undefined;
    }
    if (parsed.protocol !== 'file:' || !parsed.pathname) {
        return undefined;
    }
    let segments = parsed.pathname.split('/');`,
		},
		{
			name: 'vscode-markdown-languageserver workerMain uriToFilePath',
			old: `    function uriToFilePath(uri2) {
      let parsed = url.parse(uri2);
      if (parsed.protocol !== "file:" || !parsed.path) {
        return void 0;
      }
      let segments = parsed.path.split("/");`,
			replacement: `    function uriToFilePath(uri2) {
      let parsed;
      try {
        parsed = new URL(uri2);
      } catch (e) {
        return void 0;
      }
      if (parsed.protocol !== "file:" || !parsed.pathname) {
        return void 0;
      }
      let segments = parsed.pathname.split("/");`,
		},
		{
			name: '@vscode/proxy-agent useProxySettings',
			old: `        const parsedUrl = nodeurl.parse(url); // Coming from Node's URL, sticking with that.`,
			replacement: `        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            // A request URL that is not absolute still goes through the legacy parser;
            // it is the rare path, so the deprecation warning stays out of the common one.
            parsedUrl = nodeurl.parse(url);
        }`,
		},
	];

	let patched = 0;
	let already = 0;

	for (const relative of FILES) {
		const file = path.join(root, relative);
		if (!existsSync(file)) {
			continue;
		}
		const text = readFileSync(file, 'utf8');
		if (!/url\.parse\(/.test(text)) {
			// The legacy call is gone: patched earlier, by hand, or by a newer dependency.
			already++;
			continue;
		}
		for (const pattern of PATTERNS) {
			if (text.includes(pattern.old)) {
				writeFileSync(file, text.replace(pattern.old, pattern.replacement));
				console.log(`  -- patched ${relative} (${pattern.name}): url.parse -> WHATWG URL`);
				patched++;
				break;
			}
		}
	}

	console.log(`  vscode-languageserver DEP0169 patch: ${patched} patched, ${already} already current`);
	}

	// prune-binaries -- was build/prune-platform-binaries.mjs
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
	 * Usage: node build/checks.mjs prune-binaries <node_modules> [<platform>] [<arch>]
	 */
	async function cmdPruneBinaries(cli) {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const [directory, platformArg, archArg] = cli;
	if (!directory) {
		process.stderr.write('usage: node build/checks.mjs prune-binaries <node_modules> [platform] [arch]\n');
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
	}


const USAGE = `usage: node build/checks.mjs <check-mcp|patch-languageserver|prune-binaries>\n`;
const cli = process.argv.slice(2);

async function dispatch() {
	switch (cli[0]) {
		case 'check-mcp':
			return cmdCheckMcp(cli.slice(1));
		case 'patch-languageserver':
			return cmdPatchLanguageserver(cli.slice(1));
		case 'prune-binaries':
			return cmdPruneBinaries(cli.slice(1));
		default:
			process.stderr.write(USAGE);
			return process.exit(2);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await dispatch();
}
