/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

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
 * The same shape as dev/patch-inno-updater.mjs: a build-time patch for a file that no
 * toolchain rewrite touches, kept where the rest of the build's patches live.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
	'picode-source/extensions/markdown-language-features/node_modules/vscode-languageserver/lib/node/files.js',
	'picode-source/extensions/markdown-language-features/node_modules/vscode-markdown-languageserver/dist/node/workerMain.js',
	'picode-source/node_modules/@vscode/proxy-agent/out/index.js',
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
