#!/usr/bin/env node
/*
 * PiCode's name, on the editor's own copy.
 *
 * The editor is built from VS Code's source, and its text says so: measured, 196 of its 24,697
 * user-facing strings name "VS Code", "VSCode" or "VSCodium". The product's own strings (this
 * repository's patches, the connector, the settings) already say PiCode; these are the ones that
 * come from upstream, and they are the ones a person reads in the settings, in the panels and in
 * the extension list of a product that is not called that.
 *
 * ## What it touches, and what it must not
 *
 * Only **copy**: the editor's message table (`out/nls.messages.json`, which is what every screen
 * reads from) and the built-in extensions' manifests (`package.json` / `package.nls.json`, where
 * descriptions live). The bundles hold indices into that table, so nothing else needs rewriting.
 *
 * It replaces the brand **as written for a person** — `VS Code`, `VSCode`, `VSCodium`, `Visual
 * Studio Code` — and leaves everything that would break by being renamed:
 *
 *   - identifiers and packages: `@vscode/…`, `vscode-…`, `microsoft/vscode`, `.vscode`, and the
 *     `vscode:` URI scheme (all lower case, so the capitalised forms never match them anyway);
 *   - URLs (`code.visualstudio.com`, `aka.ms/vscode…`): renaming one would break the link and be a
 *     lie about where it goes;
 *   - the licensing and attribution files (`LICENSE*`, `ThirdPartyNotices*`): the lineage is
 *     upstream's and stating otherwise would be false.
 *
 * Usage: node dev/brand-copy.mjs [pack-dir] [--check]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const packArg = args.find(argument => !argument.startsWith('--'));
const PACK = path.resolve(packArg ?? path.join(REPO, 'PiCode-Win32-x64'));
const APP = path.join(PACK, 'resources', 'app');

/** The brand, as a person writes it. Lower-case identifiers never match these. */
const BRAND = [
	[/\bVisual Studio Code\b/g, 'PiCode'],
	[/\bVS Code\b/g, 'PiCode'],
	[/\bVSCode\b/g, 'PiCode'],
	[/\bVSCodium\b/g, 'PiCode'],
];

/** Files whose text is a promise about where something came from, and must not be rewritten. */
const DO_NOT_TOUCH = /(^|[\\/])(LICENSE|ThirdPartyNotices|LICENSES)/i;

/** Where PiCode's own copy lives: the extension the editor shows as built in. */
const OURS = /picode/i;

let rewritten = 0;
let strings = 0;
const samples = [];

function brand(text) {
	let out = text;
	for (const [pattern, replacement] of BRAND) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

function rewriteText(file) {
	const before = fs.readFileSync(file, 'utf8');
	const after = brand(before);
	if (after === before) {
		return;
	}
	const changed = before.split('\n').length === after.split('\n').length;
	rewritten += 1;
	// One sample per file is enough to see what it did, and the count says how much.
	const line = before.split('\n').find(line => brand(line) !== line) ?? '';
	const clean = line.replace(/\\u001b\[[0-9;]*m/g, '').trim();
	if (clean.length > 0 && samples.length < 12) {
		samples.push(`  ${path.relative(PACK, file)}\n    - ${clean.slice(0, 120)}\n    + ${brand(clean).slice(0, 120)}`);
	}
	if (changed && !checkOnly) {
		fs.writeFileSync(file, after);
	}
}

/** Every string value in a JSON document, rewritten in place, keys left alone. */
function rewriteJsonStrings(value, insidePackages = false) {
	if (typeof value === 'string') {
		strings += 1;
		return brand(value);
	}
	if (Array.isArray(value)) {
		return value.map(entry => rewriteJsonStrings(entry, insidePackages));
	}
	if (typeof value === 'object' && value !== null) {
		const out = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = rewriteJsonStrings(entry, insidePackages);
		}
		return out;
	}
	return value;
}

function rewriteJson(file) {
	let document;
	const before = fs.readFileSync(file, 'utf8');
	try {
		document = JSON.parse(before);
	} catch {
		// A manifest that cannot be read is left as it is: this rewrites copy, it does not repair files.
		return;
	}
	const after = rewriteJsonStrings(document);
	const text = `${JSON.stringify(after, null, '\t')}\n`;
	if (text !== before) {
		rewritten += 1;
		if (!checkOnly) {
			fs.writeFileSync(file, text);
		}
	}
}

if (!fs.existsSync(APP)) {
	process.stderr.write(`No editor to rewrite at ${APP}\n`);
	process.exit(2);
}

// 1. The editor's message table: every screen reads its text from here.
const table = path.join(APP, 'out', 'nls.messages.json');
if (fs.existsSync(table)) {
	let before;
	try {
		before = JSON.parse(fs.readFileSync(table, 'utf8'));
	} catch (error) {
		process.stderr.write(`the message table could not be read: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
	const branded = rewriteJsonStrings(before);
	const changed = branded.filter((message, index) => message !== before[index]).length;
	rewritten += changed;
	strings += before.length;
	if (changed > 0 && !checkOnly) {
		fs.writeFileSync(table, JSON.stringify(branded));
	}
	process.stdout.write(`message table: ${changed} of ${before.length} strings named the other editor\n`);
}

// 2. The built-in extensions' manifests: their own descriptions, which the Extensions view shows.
const extensionsDir = path.join(APP, 'extensions');
if (fs.existsSync(extensionsDir)) {
	for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || OURS.test(entry.name)) {
			// PiCode's own extension is written by us and already says PiCode everywhere.
			continue;
		}
		const directory = path.join(extensionsDir, entry.name);
		for (const name of fs.readdirSync(directory)) {
			if (!/^(package\.nls|package)\.json$|^package\.nls\.[a-z-]+\.json$/.test(name)) {
				continue;
			}
			const file = path.join(directory, name);
			if (DO_NOT_TOUCH.test(file)) {
				continue;
			}
			rewriteJson(file);
		}
	}
	process.stdout.write(`extension manifests: ${rewritten} file(s) rewritten\n`);
}

if (samples.length > 0) {
	process.stdout.write('\nwhat it changed, a sample:\n');
	process.stdout.write(samples.join('\n') + '\n');
}

process.stdout.write(`\n${checkOnly ? 'would rewrite' : 'rewrote'} ${rewritten} place(s) over ${strings} string(s)\n`);
