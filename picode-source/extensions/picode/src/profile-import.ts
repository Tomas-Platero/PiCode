/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The one-shot copy of a profile, and the scan that previews it.
 *
 * `scanExternalProfile()` reads the machine's pi profile — the external pi's own — and
 * answers only counts, so the welcome page can show what an import would bring before
 * anything moves. `importProfile()` copies a chosen subset into PiCode's own profile under
 * one rule: every read happens under `from`, every write happens under `to`, and there is
 * no code path that opens anything under `from` for writing.
 *
 * - The caller chooses the items one flag at a time; an unselected item is reported as
 *   `declined` and never opened. Credentials are a flag like any other, and the welcome
 *   page keeps it off unless the owner asks for it explicitly.
 * - Nothing is replaced silently: an item landing on content reports `overwritten`, and a
 *   directory copy merges into the target instead of clearing it.
 * - A missing source item is `absent`; an unreadable one is `failed`. Neither throws —
 *   the scan runs against a profile that may be half-written or absent.
 */

/** One thing the caller may bring across; each maps to a file or a directory. */
export type ImportItem =
	| 'settings'
	| 'models'
	| 'mcp'
	| 'skills'
	| 'memory'
	| 'sessions'
	| 'credentials';

/** What comes across, one flag each. A falsy flag is a decision, not an omission. */
export interface ImportSelection {
	settings?: boolean;
	models?: boolean;
	mcp?: boolean;
	skills?: boolean;
	memory?: boolean;
	sessions?: boolean;
	credentials?: boolean;
}

export type ImportItemStatus = 'copied' | 'overwritten' | 'absent' | 'declined' | 'failed';

export interface ImportItemReport {
	readonly item: ImportItem;
	readonly status: ImportItemStatus;
	/** The target path the item was written to, or would have been. */
	readonly path: string;
	/** For directory items only: how many files the copy moved. */
	readonly files?: number;
	/** Why it failed. Owner-facing. */
	readonly reason?: string;
}

export interface ImportReport {
	readonly from: string;
	readonly to: string;
	readonly items: readonly ImportItemReport[];
	readonly copied: number;
	readonly overwritten: number;
	readonly absent: number;
	readonly declined: number;
	readonly failed: number;
}

export interface ImportOptions {
	readonly from: string;
	readonly to: string;
	readonly selection: ImportSelection;
}

/** The item list, in the order they are copied. Credentials last: the deliberate decision. */
const ITEMS: ReadonlyArray<{ item: ImportItem; kind: 'file' | 'directory'; name: string }> = [
	{ item: 'settings', kind: 'file', name: 'settings.json' },
	{ item: 'models', kind: 'file', name: 'models.json' },
	{ item: 'mcp', kind: 'file', name: 'mcp.json' },
	{ item: 'skills', kind: 'directory', name: 'skills' },
	{ item: 'memory', kind: 'directory', name: 'memory' },
	{ item: 'sessions', kind: 'directory', name: 'sessions' },
	{ item: 'credentials', kind: 'file', name: 'auth.json' },
];

/** The machine's pi profile — where the external pi keeps everything. */
export function externalProfileDir(): string {
	return path.join(os.homedir(), '.pi', 'agent');
}

/* ------------------------------------------------------------------ *
 * The preview: counts only, nothing moves
 * ------------------------------------------------------------------ */

/** What an import would bring, counted without copying anything. */
export interface ProfilePreview {
	readonly exists: boolean;
	readonly packages: number;
	/** The providers declared in the profile's models.json — what the owner would call logins. */
	readonly providers: number;
	readonly mcpServers: number;
	readonly skills: number;
	readonly sessions: number;
	readonly hasCredentials: boolean;
}

/** Reads the profile's JSON object, or `undefined` when it is missing or malformed. */
function readJsonObjectFile(file: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function countDirectories(dir: string): number {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
	} catch {
		return 0;
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

/** Counts what the external profile holds. Read-only, always. */
export function scanExternalProfile(profile: string = externalProfileDir()): ProfilePreview {
	const exists = existsSync(profile);
	const settings = exists ? readJsonObjectFile(path.join(profile, 'settings.json')) : undefined;
	const packages = settings !== undefined && Array.isArray(settings['packages']) ? settings['packages'].length : 0;
	const modelsFile = exists ? readJsonObjectFile(path.join(profile, 'models.json')) : undefined;
	const providers = modelsFile !== undefined && typeof modelsFile['providers'] === 'object' && modelsFile['providers'] !== null
		? Object.keys(modelsFile['providers'] as Record<string, unknown>).length
		: 0;
	const mcpFile = exists ? readJsonObjectFile(path.join(profile, 'mcp.json')) : undefined;
	const mcpServers = mcpFile !== undefined && typeof mcpFile['mcpServers'] === 'object' && mcpFile['mcpServers'] !== null
		? Object.keys(mcpFile['mcpServers'] as Record<string, unknown>).length
		: 0;
	return {
		exists,
		packages,
		providers,
		mcpServers,
		skills: exists ? countDirectories(path.join(profile, 'skills')) : 0,
		sessions: exists ? countFiles(path.join(profile, 'sessions')) : 0,
		hasCredentials: exists ? existsSync(path.join(profile, 'auth.json')) : false,
	};
}

/* ------------------------------------------------------------------ *
 * The copy
 * ------------------------------------------------------------------ */

function isFile(target: string): boolean {
	try {
		return statSync(target).isFile();
	} catch {
		return false;
	}
}

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function hasContent(directory: string): boolean {
	try {
		return readdirSync(directory).length > 0;
	} catch {
		return false;
	}
}

/**
 * Copies every file under `source` into `target`, merging rather than mirroring: nothing
 * already in `target` that the import does not name is removed. Only `copyFileSync`
 * writes, and only under `target`.
 */
function copyDirectory(source: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(target, entry.name);
		if (entry.isDirectory()) {
			copyDirectory(from, to);
		} else if (entry.isFile()) {
			copyFileSync(from, to);
		}
	}
}

/** The bytes of a settings-like JSON file, or why it may not be copied. */
function readJsonObjectForCopy(file: string): { text: string } | { failure: string } {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return { failure: 'the source file could not be read' };
	}
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return { failure: 'the source is not a JSON object' };
		}
	} catch {
		return { failure: 'the source is not valid JSON' };
	}
	return { text };
}

function importFile(item: ImportItem, source: string, target: string): ImportItemReport {
	if (!existsSync(source)) {
		return { item, status: 'absent', path: target };
	}
	if (!isFile(source)) {
		return { item, status: 'failed', path: target, reason: 'the source path is not a file' };
	}
	const read = readJsonObjectForCopy(source);
	if ('failure' in read) {
		return { item, status: 'failed', path: target, reason: read.failure };
	}
	if (existsSync(target) && !isFile(target)) {
		return { item, status: 'failed', path: target, reason: 'the target already exists and is not a file' };
	}
	const existed = isFile(target);
	try {
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, read.text);
	} catch {
		return { item, status: 'failed', path: target, reason: 'the target could not be written' };
	}
	return { item, status: existed ? 'overwritten' : 'copied', path: target };
}

function importDirectory(item: ImportItem, source: string, target: string): ImportItemReport {
	if (!existsSync(source)) {
		return { item, status: 'absent', path: target };
	}
	if (!isDirectory(source)) {
		return { item, status: 'failed', path: target, reason: 'the source path is not a directory' };
	}
	try {
		const files = countFiles(source);
		// Decided before the copy, because the copy is what would otherwise make the
		// target look occupied.
		const existed = hasContent(target);
		copyDirectory(source, target);
		return { item, status: existed ? 'overwritten' : 'copied', path: target, files };
	} catch {
		return { item, status: 'failed', path: target, reason: 'the directory could not be copied' };
	}
}

/**
 * Copies a chosen subset of `from` into `to` and reports every item.
 *
 * An unselected item is never opened: it is reported as `declined`. Throws only on a
 * caller mistake — importing a profile into itself would put a write path under `from`.
 */
export function importProfile(options: ImportOptions): ImportReport {
	const from = path.resolve(options.from);
	const to = path.resolve(options.to);
	if (from === to) {
		throw new Error('the source and target profiles cannot be the same directory');
	}
	mkdirSync(to, { recursive: true });

	const items: ImportItemReport[] = [];
	for (const spec of ITEMS) {
		const target = path.join(to, spec.name);
		let report: ImportItemReport;
		if (options.selection[spec.item] !== true) {
			report = { item: spec.item, status: 'declined', path: target };
		} else {
			const source = path.join(from, spec.name);
			report = spec.kind === 'file'
				? importFile(spec.item, source, target)
				: importDirectory(spec.item, source, target);
		}
		items.push(report);
	}
	const by = (status: ImportItemStatus): number => items.filter(report => report.status === status).length;
	return {
		from,
		to,
		items,
		copied: by('copied'),
		overwritten: by('overwritten'),
		absent: by('absent'),
		declined: by('declined'),
		failed: by('failed'),
	};
}
