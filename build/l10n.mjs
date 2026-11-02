#!/usr/bin/env node
/*
 * l10n -- PiCode's own translations.
 *
 * Marketplace language packs only know VS Code's strings, so everything PiCode adds or
 * rewrites stays English unless we ship the translation ourselves.
 * src/vs/base/node/nls.ts merges `l10n/<language>.json` over the installed pack; this
 * file keeps those JSON files honest.
 *
 * What counts as "ours":
 *   - any localize() whose key starts with `picode`  -> stored under that key;
 *   - any other localize() that is new or has different text than upstream VS Code
 *     (the rebranded Copilot/VS Code wording)       -> stored under `<module>#<key>`,
 *     because a plain key can mean different things in different modules.
 *
 * Four surfaces hold those words, and `--surface` picks which one:
 *   editor (the default)  src/vs/workbench/contrib/picode/l10n/<language>.json, merged in at runtime
 *   window                resources/onboarding/l10n/<language>.js, the setup window's own tables
 *   extension             extensions/picode/l10n/bundle.l10n.<language>.json, what `vscode.l10n.t`
 *                         looks up by the English sentence, so there the key is the text
 *   manifest              extensions/picode/package.nls.<language>.json, the `%key%` the connector's
 *                         package.json asks for before any code runs
 *
 * Usage:
 *   node build/l10n.mjs extract [--upstream <vscode checkout>]     rewrite l10n/source.json (editor)
 *   node build/l10n.mjs extract --surface extension                rewrite bundle.l10n.json
 *   node build/l10n.mjs split <language> [--surface s] [--size n]   hand out what a language is missing
 *   node build/l10n.mjs merge <language> [--surface s]              take the finished chunks back
 *   node build/l10n.mjs check [--upstream <vscode checkout>]        the 13 languages, all four surfaces
 *
 * Without --upstream, `check` trusts the `<module>#<key>` entries already in source.json;
 * with it, it also reports patched strings source.json does not know yet.
 *
 * `split` writes the strings a language has not got yet as numbered chunks under
 * `<surface>/.work/<language>/`; each chunk is a list of `{ key, text }`. Translating a chunk means
 * writing `<number>.out.json` beside it with `{ "<key>": "<text>", ... }`, and `merge` puts every
 * finished chunk back into the language file, keeping the source order, checking the `{0}`
 * placeholders and starting over if one of them moved. Chunks are never deleted, so a run that
 * stops half way resumes where it left off and nothing that was already translated is done twice.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const L10N = join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'picode', 'l10n');
const WINDOW = join(ROOT, 'resources', 'onboarding', 'l10n');
const EXTENSION = join(ROOT, 'extensions', 'picode');
const BUNDLE = join(EXTENSION, 'l10n');
const WORK = '.work';
const PREFIX = 'picode';

/**
 * The languages PiCode ships, in the same set the editor's own translation tooling knows
 * (`defaultLanguages` plus `extraLanguages` in build/lib/i18n.ts). A language file that is not
 * here is not checked and not loaded, so this is the list the product promises.
 */
const SHIPPED = ['cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'zh-cn', 'zh-tw'];

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name !== 'test' && name !== 'node_modules') {
				yield* walk(path);
			}
		} else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
			yield path;
		}
	}
}

/** Literal text of a node, or undefined when it is computed. */
function literal(node) {
	return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/**
 * Every `localize('key', "text")` / `localize2(...)` under `<root>/vs`, as
 * Map<"module#key", { key, module, text, file }>. Computed keys or texts are reported
 * in `problems` because nothing can translate them.
 */
export function collect(root) {
	const found = new Map();
	const problems = [];
	for (const file of walk(join(root, 'vs'))) {
		const text = readFileSync(file, 'utf8');
		if (!text.includes('localize')) {
			continue;
		}
		const module = relative(root, file).split(sep).join('/').replace(/\.ts$/, '');
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const visit = node => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^localize2?$/.test(node.expression.text)) {
				const [first, second] = node.arguments;
				const key = literal(first) ?? (first && ts.isObjectLiteralExpression(first)
					? literal(first.properties.find(p => p.name?.text === 'key')?.initializer)
					: undefined);
				const message = literal(second);
				if (key !== undefined && message !== undefined) {
					found.set(`${module}#${key}`, { key, module, text: message, file: module });
				} else if (key?.startsWith(PREFIX)) {
					problems.push(`${module}: "${key}" has a message that is not a plain string`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return { found, problems };
}

/** Name a string is stored under in source.json and in each language file. */
function storedKey({ key, module }) {
	return key.startsWith(PREFIX) ? key : `${module}#${key}`;
}

/** Strings PiCode owns: its own keys plus everything that differs from upstream VS Code. */
export function ours(upstreamRoot) {
	const { found, problems } = collect(join(ROOT, 'src'));
	const upstream = upstreamRoot ? collect(join(resolve(upstreamRoot), 'src')).found : undefined;
	const result = {};
	const seen = new Map();
	for (const [id, entry] of found) {
		const own = entry.key.startsWith(PREFIX) || (upstream && upstream.get(id)?.text !== entry.text);
		if (!own || entry.module.includes('/picode/l10n')) {
			continue;
		}
		const name = storedKey(entry);
		if (seen.has(name) && result[name] !== entry.text) {
			problems.push(`${entry.module}: "${entry.key}" is already used with different text in ${seen.get(name)}`);
			continue;
		}
		seen.set(name, entry.module);
		result[name] = entry.text;
	}
	return { result, problems };
}

function placeholders(text) {
	return [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort().join(',');
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function option(name) {
	const index = process.argv.indexOf(`--${name}`);
	return index > 0 ? process.argv[index + 1] : undefined;
}

/**
 * Every `l10n.t("text")` / `vscode.l10n.t("text")` in the connector, as Map<text, file>.
 * The connector's bundle is keyed by the English sentence itself, which is the key
 * `vscode.l10n.t` looks up at runtime, so the sentence is both name and text.
 */
export function connectorStrings() {
	const found = new Map();
	const problems = [];
	for (const file of walk(join(EXTENSION, 'src'))) {
		const text = readFileSync(file, 'utf8');
		if (!text.includes('l10n')) {
			continue;
		}
		const where = relative(ROOT, file).split(sep).join('/');
		const visit = node => {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't') {
				const owner = node.expression.expression;
				const called = ts.isPropertyAccessExpression(owner) ? owner.name.text : ts.isIdentifier(owner) ? owner.text : '';
				if (called === 'l10n') {
					const message = literal(node.arguments[0]);
					// Three modules that `node --test` loads by their own path carry their own
					// `t(message, ...args)` fallback instead of importing `./l10n` (a sibling import
					// without an extension does not resolve there). That call is plumbing, not a string.
					if (message === undefined && !isFallbackCall(node)) {
						problems.push(`${where}: ${node.getText().replace(/\s+/g, ' ').slice(0, 70)} is not a plain string`);
					} else if (message !== undefined && !found.has(message)) {
						found.set(message, where);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
	}
	return { found, problems };
}

/** `l10n.t(message, ...args)`: the module's own fallback helper handing its one message through. */
function isFallbackCall(node) {
	const [first, ...rest] = node.arguments;
	return ts.isIdentifier(first) && first.text === 'message' && rest.some(argument => ts.isSpreadElement(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === 'args');
}

/** Rewrite the connector's bundle from its code: `{ "<english>": "<english>" }`. */
function extractBundle() {
	const { found, problems } = connectorStrings();
	const entries = {};
	for (const text of found.keys()) {
		entries[text] = text;
	}
	mkdirSync(BUNDLE, { recursive: true });
	writeFileSync(join(BUNDLE, 'bundle.l10n.json'), JSON.stringify(sorted(entries), null, '\t') + '\n');
	console.log(`extension: ${Object.keys(entries).length} string(s) in ${relative(ROOT, join(BUNDLE, 'bundle.l10n.json'))}`);
	problems.forEach(problem => console.error(problem));
	return problems.length ? 1 : 0;
}

function sorted(entries) {
	const result = {};
	for (const key of Object.keys(entries).sort()) {
		result[key] = entries[key];
	}
	return result;
}

/* ------------------------------------------------------------------ *
 * The surfaces
 * ------------------------------------------------------------------ */

/** Editor strings: one flat JSON object, `<key>: <text>`. */
function editorSurface() {
	return {
		name: 'editor',
		dir: L10N,
		file(language) { return join(L10N, `${language}.json`); },
		source() { return readJson(join(L10N, 'source.json')); },
		existing(language) { return existsSync(this.file(language)) ? readJson(this.file(language)) : {}; },
		write(language, entries) { writeFileSync(this.file(language), JSON.stringify(entries, null, '\t') + '\n'); },
	};
}

/** `{ 'steps.welcome': 'Welcome' }`: the window's file has `steps` nested, everything else flat. */
function flatten(table, prefix = '', into = {}) {
	for (const [key, value] of Object.entries(table)) {
		if (value !== null && typeof value === 'object') {
			flatten(value, `${prefix}${key}.`, into);
		} else {
			into[`${prefix}${key}`] = String(value);
		}
	}
	return into;
}

function jsString(text) {
	return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
}

function jsName(language) {
	return /^[A-Za-z_$][\w$]*$/.test(language) ? `.${language}` : `['${language}']`;
}

/** The window's file back from flattened entries, in the English order, with `steps` and the lists kept as they are. */
function windowFile(language, source, entries) {
	const lines = [];
	const emit = (node, prefix, depth) => {
		const pad = '\t'.repeat(depth);
		for (const [key, value] of Object.entries(node)) {
			const path = prefix === '' ? key : `${prefix}.${key}`;
			if (Array.isArray(value)) {
				const items = value.map((item, index) => jsString(entries[`${path}.${index}`] ?? String(item)));
				lines.push(`${pad}${key}: [${items.join(', ')}],`);
			} else if (value !== null && typeof value === 'object') {
				lines.push(`${pad}${key}: {`);
				emit(value, path, depth + 1);
				lines.push(`${pad}},`);
			} else {
				lines.push(`${pad}${key}: ${jsString(entries[path] ?? String(value))},`);
			}
		}
	};
	emit(source, '', 1);
	return `/* The setup window's own words, ${language}. English is the source, and the fallback for any key a language leaves out. */\n(window.PICODE_L10N = window.PICODE_L10N || {})${jsName(language)} = {\n${lines.join('\n')}\n};\n`;
}

/** The table a window file fills, read without trusting it: it is a script, not JSON. */
function windowTable(path) {
	const sandbox = { window: {} };
	runInNewContext(readFileSync(path, 'utf8'), sandbox);
	const tables = sandbox.window.PICODE_L10N ?? {};
	const first = Object.keys(tables)[0];
	return first === undefined ? {} : tables[first];
}

/** Setup window strings: `<code>.js`, one `window.PICODE_L10N[<code>]` table each, English is the source. */
function windowSurface() {
	return {
		name: 'window',
		dir: WINDOW,
		file(language) { return join(WINDOW, `${language}.js`); },
		source() { return flatten(this.sourceTable()); },
		sourceTable() { return windowTable(join(WINDOW, 'en.js')); },
		existing(language) { return existsSync(this.file(language)) ? flatten(windowTable(this.file(language))) : {}; },
		write(language, entries) { writeFileSync(this.file(language), windowFile(language, this.sourceTable(), entries)); },
	};
}

function surfaceFor(name) {
	if (name === undefined || name === 'editor') { return editorSurface(); }
	if (name === 'window') { return windowSurface(); }
	if (name === 'extension') { return extensionSurface(); }
	if (name === 'manifest') { return manifestSurface(); }
	throw new Error(`--surface has to be "editor", "window", "extension" or "manifest", not "${name}"`);
}

/** The connector's runtime bundle: `<english>: <translation>`, one file per language. */
function extensionSurface() {
	return {
		name: 'extension',
		dir: BUNDLE,
		file(language) { return join(BUNDLE, `bundle.l10n.${language}.json`); },
		source() { return readJson(join(BUNDLE, 'bundle.l10n.json')); },
		existing(language) { return existsSync(this.file(language)) ? readJson(this.file(language)) : {}; },
		write(language, entries) { writeFileSync(this.file(language), JSON.stringify(sorted(entries), null, '\t') + '\n'); },
	};
}

/** The connector's `package.json` titles: `package.nls.json` holds the `%key%` the manifest asks for. */
function manifestSurface() {
	return {
		name: 'manifest',
		dir: EXTENSION,
		file(language) { return join(EXTENSION, `package.nls.${language}.json`); },
		source() { return readJson(join(EXTENSION, 'package.nls.json')); },
		existing(language) { return existsSync(this.file(language)) ? readJson(this.file(language)) : {}; },
		write(language, entries) { writeFileSync(this.file(language), JSON.stringify(sorted(entries), null, '\t') + '\n'); },
	};
}

function targetLanguage() {
	const language = process.argv[3];
	if (!language || language.startsWith('--')) {
		throw new Error('which language? node build/l10n.mjs split|merge <language>');
	}
	return language;
}

/** How many `{0}` placeholders a text has, so a translation cannot quietly lose or invent one. */
function samePlaceholders(translated, original) {
	return placeholders(translated) === placeholders(original);
}

/* ------------------------------------------------------------------ *
 * Handing work out and taking it back
 * ------------------------------------------------------------------ */

function split() {
	const surface = surfaceFor(option('surface'));
	const language = targetLanguage();
	const size = Number(option('size') ?? 120);
	const source = surface.source();
	const existing = surface.existing(language);
	const missing = Object.keys(source).filter(key => !existing[key]);
	const dir = join(surface.dir, WORK, language);
	mkdirSync(dir, { recursive: true });

	const chunks = [];
	for (let index = 0; index < missing.length; index += size) { chunks.push(missing.slice(index, index + size)); }
	chunks.forEach((keys, index) => {
		const name = String(index + 1).padStart(2, '0');
		const items = keys.map(key => ({ key, text: source[key] }));
		writeFileSync(join(dir, `${name}.json`), JSON.stringify(items, null, '\t') + '\n');
	});

	console.log(`${surface.name} / ${language}: ${missing.length} string(s) missing, ${chunks.length} chunk(s) in ${relative(ROOT, dir) || '.'}`);
	console.log('Each chunk is a list of { key, text }. Answer a chunk with <number>.out.json holding { "<key>": "<text>" }, then run merge.');
	return missing.length === 0 ? 0 : 0;
}

function merge() {
	const surface = surfaceFor(option('surface'));
	const language = targetLanguage();
	const source = surface.source();
	const dir = join(surface.dir, WORK, language);
	const problems = [];
	let accepted = 0;
	let merged = {};
	try {
		merged = { ...surface.existing(language) };
	} catch (error) {
		// A hand-broken language file must not hide the chunks: they are the work of record.
		problems.push(`${surface.name}/${language}: the current file could not be read (${error.message}), starting from the chunks`);
	}

	const chunks = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.out.json')).sort() : [];
	for (const name of chunks) {
		let data;
		try {
			data = readJson(join(dir, name));
		} catch (error) {
			problems.push(`${name}: not JSON — ${error.message}`);
			continue;
		}
		const entries = Array.isArray(data) ? data.map(item => [item.key, item.text]) : Object.entries(data);
		for (const [key, text] of entries) {
			if (typeof key !== 'string' || typeof text !== 'string') {
				problems.push(`${name}: every entry needs a key and a text`);
				continue;
			}
			if (!(key in source)) {
				problems.push(`${name}: "${key}" is not a string of the ${surface.name}`);
				continue;
			}
			if (!text.trim()) { continue; }
			if (!samePlaceholders(text, source[key])) {
				problems.push(`${name}: "${key}" changes the {n} placeholders of "${source[key]}"`);
				continue;
			}
			merged[key] = text;
			accepted++;
		}
	}

	const ordered = {};
	for (const key of Object.keys(source)) { if (merged[key]) { ordered[key] = merged[key]; } }
	surface.write(language, ordered);

	const total = Object.keys(source).length;
	const done = Object.keys(ordered).length;
	console.log(`${surface.name} / ${language}: ${done}/${total} translated, ${accepted} taken from ${chunks.length} chunk(s)`);
	if (done < total) { console.log(`${total - done} still missing — run split again for the rest.`); }
	problems.forEach(problem => console.error(problem));
	return done === total && problems.length === 0 ? 0 : 1;
}

function languages() {
	return readdirSync(L10N).filter(f => f.endsWith('.json') && f !== 'source.json').map(f => f.slice(0, -5)).sort();
}

function extract() {
	const upstream = option('upstream');
	if (!upstream) {
		console.error('extract needs --upstream <path to a VS Code checkout of the version PiCode is built on>');
		return 2;
	}
	const { result, problems } = ours(upstream);
	const sorted = Object.fromEntries(Object.keys(result).sort().map(key => [key, result[key]]));
	writeFileSync(join(L10N, 'source.json'), JSON.stringify(sorted, null, '\t') + '\n');
	console.log(`source.json: ${Object.keys(sorted).length} strings`);
	problems.forEach(p => console.error(p));
	return problems.length ? 1 : 0;
}

function check() {
	const { found } = collect(join(ROOT, 'src'));
	const upstreamPath = option('upstream');
	const { result, problems } = ours(upstreamPath);
	const errors = [...problems];
	const source = readJson(join(L10N, 'source.json'));
	for (const [name, text] of Object.entries(source)) {
		if (name.includes('#')) {
			const [module, key] = [name.slice(0, name.indexOf('#')), name.slice(name.indexOf('#') + 1)];
			const entry = found.get(`${module}#${key}`);
			if (!entry || entry.text !== text) {
				errors.push(`source.json "${name}" no longer matches the code (run extract)`);
			}
		} else if (result[name] !== text) {
			errors.push(`source.json "${name}" no longer matches the code (run extract)`);
		}
	}
	for (const name of Object.keys(result)) {
		if (!(name in source)) {
			errors.push(`source.json does not know "${name}" yet (run extract)`);
		}
	}
	for (const language of SHIPPED) {
		checkLanguage(editorSurface(), language, source, errors);
	}
	const windowSource = windowSurface().source();
	for (const language of SHIPPED) {
		checkLanguage(windowSurface(), language, windowSource, errors);
	}
	// The connector's bundle is generated from its code, so a stale one is an error too.
	const { found: connector, problems: connectorProblems } = connectorStrings();
	errors.push(...connectorProblems);
	const bundle = extensionSurface().source();
	for (const text of connector.keys()) {
		if (!(text in bundle)) { errors.push(`extensions/picode/l10n/bundle.l10n.json does not know "${text}" yet (run extract --surface extension)`); }
	}
	for (const text of Object.keys(bundle)) {
		if (!connector.has(text)) { errors.push(`extensions/picode/l10n/bundle.l10n.json still has "${text}", which no code asks for`); }
	}
	for (const language of SHIPPED) {
		checkLanguage(extensionSurface(), language, bundle, errors);
		checkLanguage(manifestSurface(), language, manifestSurface().source(), errors);
	}
	const loaded = [...readFileSync(join(ROOT, 'resources', 'onboarding', 'index.html'), 'utf8').matchAll(/<script src="l10n\/([\w-]+)\.js">/g)].map(match => match[1]);	const absent = SHIPPED.filter(language => !loaded.includes(language));
	if (absent.length) {
		errors.push(`resources/onboarding/index.html does not load the setup window words of ${absent.join(', ')}`);
	}
	// `en` is the source table, not a translation: it always travels with the window.
	const unknown = loaded.filter(language => language !== 'en' && !SHIPPED.includes(language));
	if (unknown.length) {
		errors.push(`resources/onboarding/index.html loads ${unknown.join(', ')}, which is not a language PiCode ships`);
	}
	checkWindowKeys(errors);
	errors.forEach(e => console.error(e));
	return errors.length ? 1 : 0;
}

/**
 * Every word the setup page asks for by name has to exist in `en.js`: a key it invented shows the
 * key itself on screen, in every language at once, and nothing else notices.
 */
function checkWindowKeys(errors) {
	const present = new Set();
	const collect = (node, prefix) => {
		for (const [key, value] of Object.entries(node)) {
			const path = prefix === '' ? key : `${prefix}.${key}`;
			if (Array.isArray(value)) {
				value.forEach((item, index) => present.add(`${path}.${index}`));
			} else if (value !== null && typeof value === 'object') {
				present.add(path);
				collect(value, path);
			} else {
				present.add(path);
			}
		}
	};
	collect(windowSurface().sourceTable(), '');
	const page = readFileSync(join(ROOT, 'resources', 'onboarding', 'onboarding.js'), 'utf8');
	for (const match of page.matchAll(/(?:^|[^\w.$])t\('([\w.]+)'/g)) {
		if (!present.has(match[1])) {
			errors.push(`resources/onboarding/onboarding.js asks for "${match[1]}", which en.js does not have`);
		}
	}
}

/** One language of one surface: every key there, nothing extra, and the `{n}` placeholders intact. */
function checkLanguage(surface, language, source, errors) {
	const total = Object.keys(source).length;
	const translations = surface.existing(language);
	let missing = 0;
	for (const [key, text] of Object.entries(source)) {
		const translated = translations[key];
		if (!translated) {
			missing++;
		} else if (!samePlaceholders(translated, text)) {
			errors.push(`${surface.name}/${language}: "${key}" changes the {n} placeholders`);
		}
	}
	for (const key of Object.keys(translations)) {
		if (!(key in source)) {
			errors.push(`${surface.name}/${language}: "${key}" does not exist in the source`);
		}
	}
	if (missing) {
		errors.push(`${surface.name}/${language}: ${missing} of ${total} strings are not translated`);
	}
	console.log(`${surface.name}/${language}: ${total - missing}/${total}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const command = process.argv[2];
	if (command === 'extract') {
		process.exit(option('surface') === 'extension' ? extractBundle() : extract());
	} else if (command === 'check') {
		process.exit(check());
	} else if (command === 'split') {
		process.exit(split());
	} else if (command === 'merge') {
		process.exit(merge());
	} else {
		console.error('Usage: node build/l10n.mjs extract [--surface extension] [--upstream <dir>]');
		console.error('       node build/l10n.mjs split|merge <language> [--surface editor|window|extension|manifest] [--size n]');
		console.error('       node build/l10n.mjs check [--upstream <dir>]');
		process.exit(2);
	}
}
