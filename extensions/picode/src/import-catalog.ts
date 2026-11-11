/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isLeftBehindPackage, packageNameOf } from './left-behind-packages';
import { importProfile, type ImportSelection } from './profile-import';
import { readEditorSettings, stripJsonComments, writeEditorSettings, type SetupPaths } from './onboarding-settings';

/**
 * What the Import window can bring across, down to the single item.
 *
 * Two sources, one shape: `scanPiProfile()` and `scanVsCode()` answer a catalog — categories
 * with the items inside them — so the window can draw a checklist, and `applyPiImport()` /
 * `applyVsCodeImport()` receive exactly the item ids that were ticked.
 *
 * Three rules hold for everything in here:
 *
 * - **Read-only on the source.** Every read happens under the source; every write happens in
 *   PiCode's own profile or editor settings.
 * - **Yours wins.** A key, shortcut, snippet or login that PiCode already has is kept and
 *   reported as skipped; an import never overwrites what the person set up here.
 * - **Nothing throws on a bad source.** A missing or half-written profile is an empty catalog.
 */

export type SourceId = 'pi' | 'vscode';

export interface CatalogItem {
	/** Stable id the window sends back when the item is ticked. */
	readonly id: string;
	/** What the row says. */
	readonly label: string;
	/** A second, quieter line (a version, a kind), when there is one. */
	readonly detail?: string;
}

export interface CatalogCategory {
	readonly id: string;
	/** How many things the category holds; may exceed `items.length` for bulk categories. */
	readonly count: number;
	/** The rows. Empty for a bulk category that is brought across as a whole. */
	readonly items: readonly CatalogItem[];
	/** True when the category is chosen as a whole (conversations, memory, logins). */
	readonly bulk?: boolean;
	/** True for logins and similar: the window keeps these off until asked. */
	readonly sensitive?: boolean;
}

export interface SourceCatalog {
	readonly source: SourceId;
	/** Which installation, when a source can have several (VS Code, Insiders, VSCodium). */
	readonly product: string;
	readonly name: string;
	readonly found: boolean;
	readonly categories: readonly CatalogCategory[];
}

/** The ticked ids per category; `'all'` is the whole of a bulk category. */
export type ImportChoice = Readonly<Record<string, readonly string[] | 'all'>>;

export type OutcomeStatus = 'done' | 'partial' | 'nothing' | 'failed';

export interface CategoryOutcome {
	readonly category: string;
	readonly status: OutcomeStatus;
	/** Items that arrived. */
	readonly added: number;
	/** Items PiCode already had, kept as they were. */
	readonly skipped: number;
	readonly reason?: string;
}

export interface ImportOutcome {
	readonly categories: readonly CategoryOutcome[];
	/** Extensions queued to install the next time the editor window is in front. */
	readonly queuedExtensions: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Small, tolerant readers
 * ------------------------------------------------------------------ */

function readJsonValue(file: string): unknown {
	try {
		return JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
	} catch {
		return undefined;
	}
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
	const value = readJsonValue(file);
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function listDirectory(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function countFiles(dir: string): number {
	try {
		let total = 0;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : entry.isFile() ? 1 : 0;
		}
		return total;
	} catch {
		return 0;
	}
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, undefined, '\t')}\n`);
}

function chosenIds(choice: ImportChoice, category: string): readonly string[] {
	const picked = choice[category];
	return Array.isArray(picked) ? picked : [];
}

function isWhole(choice: ImportChoice, category: string): boolean {
	return choice[category] === 'all';
}

/** Merges `patch` into `target` without replacing a key `target` already has. */
function addMissing(target: Record<string, unknown>, patch: Record<string, unknown>): { added: number; skipped: number } {
	let added = 0;
	let skipped = 0;
	for (const [key, value] of Object.entries(patch)) {
		if (Object.prototype.hasOwnProperty.call(target, key)) {
			skipped += 1;
		} else {
			target[key] = value;
			added += 1;
		}
	}
	return { added, skipped };
}

function outcome(category: string, added: number, skipped: number, reason?: string): CategoryOutcome {
	const status: OutcomeStatus = added === 0 && skipped === 0 ? 'nothing' : skipped > 0 && added > 0 ? 'partial' : added > 0 ? 'done' : 'nothing';
	return { category, status, added, skipped, ...(reason !== undefined ? { reason } : {}) };
}

function failed(category: string, reason: string): CategoryOutcome {
	return { category, status: 'failed', added: 0, skipped: 0, reason };
}

/* ------------------------------------------------------------------ *
 * pi: the external profile
 * ------------------------------------------------------------------ */

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === 'string') {
		return entry;
	}
	if (typeof entry === 'object' && entry !== null) {
		const source = (entry as { source?: unknown })['source'];
		return typeof source === 'string' ? source : undefined;
	}
	return undefined;
}

/** A friendly row for a package source: `npm:@scope/name@1.2.3` reads as `@scope/name`. */
function packageLabel(source: string): { label: string; detail?: string } {
	let value = source;
	let kind: string | undefined;
	for (const prefix of ['npm:', 'git:'] as const) {
		if (value.toLowerCase().startsWith(prefix)) {
			kind = prefix.slice(0, -1);
			value = value.slice(prefix.length);
			break;
		}
	}
	const at = value.indexOf('@', 1);
	if (at > 0) {
		return { label: value.slice(0, at), detail: value.slice(at + 1) };
	}
	return kind === undefined ? { label: value } : { label: value, detail: kind };
}

/** What the external pi profile holds, item by item. Read-only. */
export function scanPiProfile(profile: string): SourceCatalog {
	const found = isDirectory(profile);
	const settings = found ? readJsonObject(path.join(profile, 'settings.json')) : undefined;
	const packageEntries = settings !== undefined && Array.isArray(settings['packages']) ? settings['packages'] : [];
	const packages: CatalogItem[] = [];
	for (const entry of packageEntries) {
		const source = packageSource(entry);
		if (source !== undefined && !isLeftBehindPackage(entry)) {
			packages.push({ id: source, ...packageLabel(source) });
		}
	}
	const preferences = settings === undefined ? 0 : Object.keys(settings).filter(key => key !== 'packages').length;
	const models = found ? readJsonObject(path.join(profile, 'models.json')) : undefined;
	const providers = typeof models?.['providers'] === 'object' && models['providers'] !== null ? Object.keys(models['providers'] as object) : [];
	const mcp = found ? readJsonObject(path.join(profile, 'mcp.json')) : undefined;
	const servers = typeof mcp?.['mcpServers'] === 'object' && mcp['mcpServers'] !== null ? Object.keys(mcp['mcpServers'] as object) : [];
	const skillsDir = path.join(profile, 'skills');
	const skills = found ? listDirectory(skillsDir).filter(name => isDirectory(path.join(skillsDir, name))) : [];
	const memory = found ? countFiles(path.join(profile, 'memory')) : 0;
	const sessions = found ? countFiles(path.join(profile, 'sessions')) : 0;
	const credentials = found && existsSync(path.join(profile, 'auth.json'));

	const categories: CatalogCategory[] = [
		{ id: 'packages', count: packages.length, items: packages },
		{ id: 'preferences', count: preferences, items: preferences > 0 ? [{ id: 'settings', label: 'settings' }] : [], bulk: true },
		{ id: 'providers', count: providers.length, items: providers.map(id => ({ id, label: id })) },
		{ id: 'mcp', count: servers.length, items: servers.map(id => ({ id, label: id })) },
		{ id: 'skills', count: skills.length, items: skills.map(id => ({ id, label: id })) },
		{ id: 'memory', count: memory, items: [], bulk: true },
		{ id: 'sessions', count: sessions, items: [], bulk: true },
		{ id: 'logins', count: credentials ? 1 : 0, items: [], bulk: true, sensitive: true },
	];
	return { source: 'pi', product: 'pi', name: 'pi', found, categories: categories.filter(category => category.count > 0) };
}

/** Merges chosen entries of a JSON map (`providers`, `mcpServers`) into the target file. */
function mergeMapEntries(from: string, to: string, mapKey: string, ids: readonly string[], category: string): CategoryOutcome {
	if (ids.length === 0) {
		return outcome(category, 0, 0);
	}
	const source = readJsonObject(from);
	const map = source?.[mapKey];
	if (typeof map !== 'object' || map === null) {
		return failed(category, 'the source file could not be read');
	}
	const patch: Record<string, unknown> = {};
	for (const id of ids) {
		if (Object.prototype.hasOwnProperty.call(map, id)) {
			patch[id] = (map as Record<string, unknown>)[id];
		}
	}
	const target = readJsonObject(to) ?? {};
	const existing = typeof target[mapKey] === 'object' && target[mapKey] !== null ? { ...(target[mapKey] as Record<string, unknown>) } : {};
	const result = addMissing(existing, patch);
	try {
		writeJson(to, { ...target, [mapKey]: existing });
	} catch {
		return failed(category, 'the target could not be written');
	}
	return outcome(category, result.added, result.skipped);
}

/** Copies the chosen skill folders without replacing a folder PiCode already has. */
function copySkills(from: string, to: string, ids: readonly string[]): CategoryOutcome {
	let added = 0;
	let skipped = 0;
	try {
		for (const id of ids) {
			const source = path.join(from, id);
			const target = path.join(to, id);
			// An id is a folder name, never a path: nothing that climbs out of `skills` is copied.
			if (id !== path.basename(id) || !isDirectory(source)) {
				continue;
			}
			if (existsSync(target)) {
				skipped += 1;
				continue;
			}
			copyTree(source, target);
			added += 1;
		}
	} catch {
		return failed('skills', 'the skills could not be copied');
	}
	return outcome('skills', added, skipped);
}

function copyTree(source: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(target, entry.name);
		if (entry.isDirectory()) {
			copyTree(from, to);
		} else if (entry.isFile()) {
			copyFileSync(from, to);
		}
	}
}

/**
 * Brings the chosen pi items into PiCode's own profile.
 *
 * Packages are *declared* in the profile's `settings.json` (a string or an object entry, kept
 * as the source wrote it, de-duplicated by source); the caller installs them afterwards.
 */
export function applyPiImport(options: { from: string; to: string; choice: ImportChoice }): ImportOutcome {
	const from = path.resolve(options.from);
	const to = path.resolve(options.to);
	if (from === to) {
		throw new Error('the source and target profiles cannot be the same directory');
	}
	const { choice } = options;
	const results: CategoryOutcome[] = [];

	const packageIds = chosenIds(choice, 'packages');
	if (packageIds.length > 0) {
		const source = readJsonObject(path.join(from, 'settings.json'));
		const target = readJsonObject(path.join(to, 'settings.json')) ?? {};
		const declared: unknown[] = Array.isArray(target['packages']) ? [...target['packages']] : [];
		// Same package at another version is the same package: PiCode's own declaration stays.
		const nameOf = (entry: unknown): string | undefined => { const source = packageSource(entry); return source === undefined ? undefined : packageNameOf(source); };
		const have = new Set(declared.map(nameOf));
		let added = 0;
		let skipped = 0;
		for (const entry of Array.isArray(source?.['packages']) ? source['packages'] : []) {
			const id = packageSource(entry);
			if (id === undefined || !packageIds.includes(id) || isLeftBehindPackage(entry)) {
				continue;
			}
			const name = nameOf(entry);
			if (have.has(name)) {
				skipped += 1;
			} else {
				declared.push(entry);
				have.add(name);
				added += 1;
			}
		}
		try {
			writeJson(path.join(to, 'settings.json'), { ...target, packages: declared });
			results.push(outcome('packages', added, skipped));
		} catch {
			results.push(failed('packages', 'the target could not be written'));
		}
	}

	if (isWhole(choice, 'preferences') || chosenIds(choice, 'preferences').length > 0) {
		const source = readJsonObject(path.join(from, 'settings.json'));
		if (source === undefined) {
			results.push(failed('preferences', 'the source file could not be read'));
		} else {
			const { packages: _packages, ...rest } = source;
			const target = readJsonObject(path.join(to, 'settings.json')) ?? {};
			const merged = addMissing(target, rest);
			try {
				writeJson(path.join(to, 'settings.json'), target);
				results.push(outcome('preferences', merged.added, merged.skipped));
			} catch {
				results.push(failed('preferences', 'the target could not be written'));
			}
		}
	}

	results.push(...[
		mergeMapEntries(path.join(from, 'models.json'), path.join(to, 'models.json'), 'providers', chosenIds(choice, 'providers'), 'providers'),
		mergeMapEntries(path.join(from, 'mcp.json'), path.join(to, 'mcp.json'), 'mcpServers', chosenIds(choice, 'mcp'), 'mcp'),
	].filter(result => result.status !== 'nothing' || result.reason !== undefined));

	const skills = chosenIds(choice, 'skills');
	if (skills.length > 0) {
		results.push(copySkills(path.join(from, 'skills'), path.join(to, 'skills'), skills));
	}

	// Whole-folder categories reuse the profile copier, which merges and never clears.
	const selection: Record<string, boolean> = {};
	if (isWhole(choice, 'memory')) { selection['memory'] = true; }
	if (isWhole(choice, 'sessions')) { selection['sessions'] = true; }
	if (isWhole(choice, 'logins')) { selection['credentials'] = true; }
	if (Object.keys(selection).length > 0) {
		const report = importProfile({ from, to, selection: selection as ImportSelection });
		for (const item of report.items) {
			if (item.status === 'declined') { continue; }
			const category = item.item === 'credentials' ? 'logins' : item.item;
			results.push(item.status === 'failed'
				? failed(category, item.reason ?? 'the copy failed')
				: outcome(category, item.status === 'absent' ? 0 : item.files ?? 1, 0));
		}
	}
	return { categories: results, queuedExtensions: [] };
}

/* ------------------------------------------------------------------ *
 * VS Code
 * ------------------------------------------------------------------ */

interface VsCodeProduct {
	readonly id: string;
	readonly name: string;
	/** The folder under the per-user application-data root. */
	readonly dataDir: string;
	/** The dot-folder under the home directory that holds `extensions/`. */
	readonly homeDir: string;
}

const VSCODE_PRODUCTS: readonly VsCodeProduct[] = [
	{ id: 'code', name: 'Visual Studio Code', dataDir: 'Code', homeDir: '.vscode' },
	{ id: 'insiders', name: 'VS Code Insiders', dataDir: 'Code - Insiders', homeDir: '.vscode-insiders' },
	{ id: 'vscodium', name: 'VSCodium', dataDir: 'VSCodium', homeDir: '.vscode-oss' },
];

/** Extensions that make no sense outside the editor that ships them, or PiCode already replaces. */
const SKIPPED_EXTENSION = /^(github\.copilot|github\.copilot-chat|ms-vscode-remote\.|ms-vsliveshare\.|ms-vscode\.remote-)/i;

/** Settings that describe the machine or the product, not the person. */
const SKIPPED_SETTING = /^(update\.|telemetry\.|settingsSync\.|github\.copilot|chat\.|workbench\.settings\.)/;

export interface VsCodeRoots {
	readonly home: string;
	/** The per-user application-data root (`%APPDATA%`, `~/Library/Application Support`, `~/.config`). */
	readonly appData: string;
}

export function defaultVsCodeRoots(): VsCodeRoots {
	const home = os.homedir();
	const appData = process.platform === 'win32'
		? process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming')
		: process.platform === 'darwin'
			? path.join(home, 'Library', 'Application Support')
			: process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
	return { home, appData };
}

interface InstalledExtension {
	readonly id: string;
	readonly version?: string;
	readonly folder?: string;
}

function installedExtensions(extensionsDir: string): InstalledExtension[] {
	const listed = readJsonValue(path.join(extensionsDir, 'extensions.json'));
	const result: InstalledExtension[] = [];
	if (Array.isArray(listed)) {
		for (const entry of listed) {
			const id = (entry as { identifier?: { id?: unknown } } | undefined)?.identifier?.id;
			if (typeof id !== 'string') { continue; }
			const version = (entry as { version?: unknown }).version;
			const relative = (entry as { relativeLocation?: unknown }).relativeLocation;
			result.push({
				id,
				...(typeof version === 'string' ? { version } : {}),
				...(typeof relative === 'string' ? { folder: path.join(extensionsDir, relative) } : {}),
			});
		}
		return result;
	}
	// No index: fall back to the `publisher.name-version` folders.
	for (const name of listDirectory(extensionsDir)) {
		const match = /^([a-z0-9][\w-]*\.[a-z0-9][\w-]*)-(\d+\.\d+\.\d+.*)$/i.exec(name);
		if (match !== null && isDirectory(path.join(extensionsDir, name))) {
			result.push({ id: match[1], version: match[2], folder: path.join(extensionsDir, name) });
		}
	}
	return result;
}

function contributesTheme(folder: string | undefined): boolean {
	if (folder === undefined) { return false; }
	const contributes = readJsonObject(path.join(folder, 'package.json'))?.['contributes'];
	if (typeof contributes !== 'object' || contributes === null) { return false; }
	const record = contributes as Record<string, unknown>;
	return ['themes', 'iconThemes', 'productIconThemes'].some(key => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0);
}

/** The ids of what the person already has installed in PiCode, lower-cased. */
function installedHere(extensionsPath: string | undefined): Set<string> {
	if (extensionsPath === undefined) { return new Set(); }
	return new Set(installedExtensions(extensionsPath).map(extension => extension.id.toLowerCase()));
}

/** Every VS Code installation found on this machine, with what each holds. Read-only. */
export function scanVsCode(roots: VsCodeRoots = defaultVsCodeRoots(), paths?: Pick<SetupPaths, 'extensionsPath'>): SourceCatalog[] {
	const have = installedHere(paths?.extensionsPath);
	const catalogs: SourceCatalog[] = [];
	for (const product of VSCODE_PRODUCTS) {
		const userDir = path.join(roots.appData, product.dataDir, 'User');
		const extensionsDir = path.join(roots.home, product.homeDir, 'extensions');
		if (!isDirectory(userDir) && !isDirectory(extensionsDir)) { continue; }

		const themes: CatalogItem[] = [];
		const others: CatalogItem[] = [];
		for (const extension of installedExtensions(extensionsDir)) {
			if (SKIPPED_EXTENSION.test(extension.id) || have.has(extension.id.toLowerCase())) { continue; }
			const row: CatalogItem = { id: extension.id, label: extension.id, ...(extension.version !== undefined ? { detail: extension.version } : {}) };
			(contributesTheme(extension.folder) ? themes : others).push(row);
		}
		const settings = readJsonObject(path.join(userDir, 'settings.json'));
		const settingKeys = settings === undefined ? [] : Object.keys(settings).filter(key => !SKIPPED_SETTING.test(key));
		const keybindings = readJsonValue(path.join(userDir, 'keybindings.json'));
		const snippetsDir = path.join(userDir, 'snippets');
		const snippets = listDirectory(snippetsDir).filter(name => /\.(code-snippets|json)$/i.test(name));

		const categories: CatalogCategory[] = [
			{ id: 'themes', count: themes.length, items: themes },
			{ id: 'extensions', count: others.length, items: others },
			{ id: 'editorSettings', count: settingKeys.length, items: settingKeys.map(id => ({ id, label: id })) },
			{ id: 'keybindings', count: Array.isArray(keybindings) ? keybindings.length : 0, items: [], bulk: true },
			{ id: 'snippets', count: snippets.length, items: snippets.map(id => ({ id, label: id.replace(/\.(code-snippets|json)$/i, '') })) },
		];
		catalogs.push({
			source: 'vscode',
			product: product.id,
			name: product.name,
			found: true,
			categories: categories.filter(category => category.count > 0),
		});
	}
	return catalogs;
}

/** Where the extensions waiting for an install are kept until the editor window picks them up. */
export function pendingExtensionsFile(userDataPath: string): string {
	return path.join(userDataPath, 'picode-import', 'pending-extensions.json');
}

/** The ids waiting to be installed, or none. */
export function readPendingExtensions(userDataPath: string): string[] {
	const value = readJsonValue(pendingExtensionsFile(userDataPath));
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

export function clearPendingExtensions(userDataPath: string): void {
	try {
		writeJson(pendingExtensionsFile(userDataPath), []);
	} catch {
		// Nothing to clear is the same as cleared.
	}
}

/** Brings the chosen VS Code items into PiCode's editor settings; extensions are queued. */
export function applyVsCodeImport(options: {
	product: string;
	choice: ImportChoice;
	paths: SetupPaths;
	roots?: VsCodeRoots;
}): ImportOutcome {
	const product = VSCODE_PRODUCTS.find(entry => entry.id === options.product);
	if (product === undefined) {
		throw new Error('unknown VS Code installation');
	}
	const roots = options.roots ?? defaultVsCodeRoots();
	const userDir = path.join(roots.appData, product.dataDir, 'User');
	const targetUser = path.join(options.paths.userDataPath, 'User');
	const { choice } = options;
	const results: CategoryOutcome[] = [];

	const keys = chosenIds(choice, 'editorSettings');
	if (keys.length > 0) {
		const source = readJsonObject(path.join(userDir, 'settings.json'));
		if (source === undefined) {
			results.push(failed('editorSettings', 'the source file could not be read'));
		} else {
			const here = readEditorSettings(options.paths);
			if (!here.readable) {
				results.push(failed('editorSettings', 'the editor settings could not be read, so they were left untouched'));
			} else {
				const patch: Record<string, unknown> = {};
				for (const key of keys) {
					if (Object.prototype.hasOwnProperty.call(source, key) && !SKIPPED_SETTING.test(key)) {
						patch[key] = source[key];
					}
				}
				const fresh: Record<string, unknown> = {};
				const merged = addMissing({ ...here.value }, patch);
				for (const [key, value] of Object.entries(patch)) {
					if (!Object.prototype.hasOwnProperty.call(here.value, key)) { fresh[key] = value; }
				}
				const written = writeEditorSettings(options.paths, fresh);
				results.push(written.written ? outcome('editorSettings', merged.added, merged.skipped) : failed('editorSettings', written.reason ?? 'the target could not be written'));
			}
		}
	}

	if (isWhole(choice, 'keybindings')) {
		const source = readJsonValue(path.join(userDir, 'keybindings.json'));
		const targetFile = path.join(targetUser, 'keybindings.json');
		const existing = readJsonValue(targetFile);
		const base: unknown[] = Array.isArray(existing) ? existing : [];
		if (!Array.isArray(source)) {
			results.push(failed('keybindings', 'the source file could not be read'));
		} else if (existsSync(targetFile) && !Array.isArray(existing)) {
			results.push(failed('keybindings', 'the keyboard shortcuts could not be read, so they were left untouched'));
		} else {
			const seen = new Set(base.map(entry => JSON.stringify(entry)));
			let added = 0;
			let skipped = 0;
			for (const entry of source) {
				const key = JSON.stringify(entry);
				if (seen.has(key)) {
					skipped += 1;
				} else {
					seen.add(key);
					base.push(entry);
					added += 1;
				}
			}
			try {
				writeJson(targetFile, base);
				results.push(outcome('keybindings', added, skipped));
			} catch {
				results.push(failed('keybindings', 'the target could not be written'));
			}
		}
	}

	const snippetIds = chosenIds(choice, 'snippets');
	if (snippetIds.length > 0) {
		let added = 0;
		let skipped = 0;
		try {
			for (const id of snippetIds) {
				const source = path.join(userDir, 'snippets', id);
				const target = path.join(targetUser, 'snippets', id);
				if (id !== path.basename(id) || !existsSync(source)) { continue; }
				if (existsSync(target)) {
					skipped += 1;
				} else {
					mkdirSync(path.dirname(target), { recursive: true });
					copyFileSync(source, target);
					added += 1;
				}
			}
			results.push(outcome('snippets', added, skipped));
		} catch {
			results.push(failed('snippets', 'the snippets could not be copied'));
		}
	}

	// Themes and extensions install through the editor, which is not running in this process:
	// the ids wait in a small file and the editor window installs them when it is in front.
	const wanted = [...new Set([...chosenIds(choice, 'themes'), ...chosenIds(choice, 'extensions')])]
		.filter(id => /^[a-z0-9][\w-]*\.[a-z0-9][\w-]*$/i.test(id));
	if (wanted.length > 0) {
		try {
			const queue = new Set(readPendingExtensions(options.paths.userDataPath));
			for (const id of wanted) { queue.add(id); }
			writeJson(pendingExtensionsFile(options.paths.userDataPath), [...queue]);
			if (chosenIds(choice, 'themes').length > 0) {
				results.push(outcome('themes', chosenIds(choice, 'themes').length, 0));
			}
			if (chosenIds(choice, 'extensions').length > 0) {
				results.push(outcome('extensions', chosenIds(choice, 'extensions').length, 0));
			}
		} catch {
			results.push(failed('extensions', 'the extensions could not be queued'));
		}
	}
	return { categories: results, queuedExtensions: wanted };
}
