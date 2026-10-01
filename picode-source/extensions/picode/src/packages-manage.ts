/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Enabling, disabling and removing the packages pi declares, run on their own.
 *
 * The management page's Packages section shows what pi has, and now acts on it too. pi has
 * no per-package disable of its own — the `packages` array of a settings file is a plain
 * list of source strings — so **disable** is a connector-level act: the declaration is taken
 * out of the settings file that wrote it, the package's files stay where pi installed them,
 * and the source is remembered in a per-profile "disabled" record so the listing can still
 * show the row (marked Disabled) and **enable** can put the declaration back. **Remove** is
 * pi's own `pi remove`, run the same way the installer runs `pi install`.
 *
 * ## Why this module has no `vscode` import
 *
 * The same split `packages-registry.ts` and `mcp-add.ts` make: everything here is a rule about
 * data and files, not about the editor. The filesystem arrives through an injectable `ManageFs`
 * and the process run through an injectable `spawn`, so the flows can be exercised by running
 * them — the JSON round-trip that preserves every other setting, the record's shape, the
 * listing's merge — without an editor and without a profile on disk. `extension.ts` resolves
 * the editor-only parts (the profile in force, the extension context's global state) and hands
 * them in.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { parsePackageSource, projectPackageScope, userPackageScope, type PackageScope, type PiPackage } from './packages-data';
import type { InstallContext, InstallResult, SpawnOptions, SpawnOutcome } from './packages-registry';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** How the page presents one package: its declaration is in place, or it is not. */
export type PackageState = 'enabled' | 'disabled';

/** Which settings scope a package belongs to: the profile, or a workspace's `.pi`. */
export type PackageScopeKind = 'user' | 'workspace';

/** The state one package row carries, on top of what the disk scan already found. */
export interface PackageRowInfo {
	/** The declaration as the settings file spells it (`npm:pi-lens`), when one exists. */
	readonly source?: string;
	readonly state: PackageState;
	readonly scope?: PackageScopeKind;
}

/** One row of the richer package listing: what the scan found, plus {@link PackageRowInfo}. */
export interface PiPackageRow extends PiPackage {
	readonly source?: string;
	readonly state?: PackageState;
	readonly scope?: PackageScopeKind;
}

/**
 * The disabled packages, as the extension context's global state holds them.
 *
 * One entry per profile directory — the profile in force, so a runtime switch never reads
 * another pi's record — holding the source strings that were disabled under it.
 */
export type DisabledRecord = Readonly<Record<string, readonly string[]>>;

/** The global-state key the record lives under; the commands and the listing must agree on it. */
export const DISABLED_PACKAGES_KEY = 'picode.disabledPackages';

/** A copy of the record with one more disabled source under one profile, never duplicated. */
export function disabledRecordWith(record: DisabledRecord, profileDir: string, source: string): DisabledRecord {
	const existing = record[profileDir] ?? [];
	if (existing.includes(source)) {
		return record;
	}
	return { ...record, [profileDir]: [...existing, source] };
}

/** A copy of the record with one source taken back out of one profile. */
export function disabledRecordWithout(record: DisabledRecord, profileDir: string, source: string): DisabledRecord {
	const existing = record[profileDir];
	if (existing === undefined) {
		return record;
	}
	const remaining = existing.filter(entry => entry !== source);
	const next = { ...record };
	if (remaining.length === 0) {
		delete next[profileDir];
	} else {
		next[profileDir] = remaining;
	}
	return next;
}

/* ------------------------------------------------------------------ *
 * The settings file's `packages` array, edited in place
 * ------------------------------------------------------------------ */

/** Whether one raw `packages` entry names the source, as a string or as an object. */
function matchesSource(raw: unknown, source: string): boolean {
	if (typeof raw === 'string') {
		return raw.trim() === source;
	}
	return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
		&& (raw as { source?: unknown }).source === source;
}

/** One settings file's text with one declaration taken out of its `packages` array. */
export function packagesArrayWithout(text: string | undefined, source: string): { text: string; changed: boolean } {
	const original = text ?? '';
	const parsed = parseRoot(text);
	if (parsed === undefined || !Array.isArray(parsed.root['packages'])) {
		return { text: original, changed: false };
	}
	const remaining = parsed.root['packages'].filter(entry => !matchesSource(entry, source));
	if (remaining.length === parsed.root['packages'].length) {
		return { text: original, changed: false };
	}
	return { text: serialize({ ...parsed.root, packages: remaining }), changed: true };
}

/** One settings file's text with one declaration added to its `packages` array, never twice. */
export function packagesArrayWith(text: string | undefined, source: string): { text: string; changed: boolean } {
	if (text === undefined) {
		// No file yet: a minimal one, in the shape pi reads.
		return { text: serialize({ packages: [source] }), changed: true };
	}
	const parsed = parseRoot(text);
	if (parsed === undefined) {
		// A malformed file is never overwritten: disabling or enabling must not destroy
		// settings this module could not read. The caller reports instead.
		return { text, changed: false };
	}
	const declared = Array.isArray(parsed.root['packages']) ? parsed.root['packages'] : [];
	if (declared.some(entry => matchesSource(entry, source))) {
		return { text, changed: false };
	}
	return { text: serialize({ ...parsed.root, packages: [...declared, source] }), changed: true };
}

/** The file's root as a record, or `undefined` when there is no readable one. */
function parseRoot(text: string | undefined): { root: Record<string, unknown> } | undefined {
	if (text === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) {
			return undefined;
		}
		return { root: parsed };
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How a settings file is written: two-space indent and a final newline, like the rest of the profile. */
function serialize(root: Record<string, unknown>): string {
	return `${JSON.stringify(root, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * The settings files of one window
 * ------------------------------------------------------------------ */

/** The profile's settings file — the one every window and every pi session agrees on. */
export function profileSettingsFile(profileDir: string): string {
	return path.join(profileDir, 'settings.json');
}

/** One workspace folder's project settings file. */
export function workspaceSettingsFile(folder: string): string {
	return path.join(folder, '.pi', 'settings.json');
}

/** The filesystem the flows run against; `extension.ts` hands in the real one. */
export interface ManageFs {
	/** A file's text, or `undefined` when it is not there. */
	readonly readText: (file: string) => string | undefined;
	/** Writes a file's text whole. */
	readonly writeText: (file: string, text: string) => void;
	/** Whether a path exists. */
	readonly exists: (file: string) => boolean;
}

/* ------------------------------------------------------------------ *
 * The flows the commands run
 * ------------------------------------------------------------------ */

/** What one disable or enable answers. */
export interface PackageFlowResult {
	/** The record the caller stores back into global state. */
	readonly record: DisabledRecord;
	/** The settings files actually written, for the caller's bookkeeping. */
	readonly changedFiles: readonly string[];
}

/**
 * Disabling one package: its declaration is taken out of every settings file that spells it
 * — the profile's and any workspace's — and the source is remembered per profile so the
 * listing can still show the row and enable can restore it. The package's files on disk stay
 * where pi put them: disabling is a declaration act, not an uninstall.
 *
 * A missing or malformed settings file is skipped, not overwritten. A source that no settings
 * file declares is still recorded — the page may disable a package the scan found without a
 * declaration of its own.
 */
export function disablePackageSource(source: string, deps: {
	readonly profileDir: string;
	readonly workspaceDirs: readonly string[];
	readonly fs: ManageFs;
	readonly record: DisabledRecord;
}): PackageFlowResult {
	const trimmed = source.trim();
	if (trimmed.length === 0) {
		return { record: deps.record, changedFiles: [] };
	}
	const changedFiles = editSettingsFiles([profileSettingsFile(deps.profileDir), ...deps.workspaceDirs.map(workspaceSettingsFile)], trimmed, deps.fs, packagesArrayWithout);
	return { record: disabledRecordWith(deps.record, deps.profileDir, trimmed), changedFiles };
}

/**
 * Enabling one package: its declaration goes back into the **profile** settings file — the
 * one every window agrees on — and the source leaves the disabled record. Whether the
 * package's files are still on disk is the caller's question (see
 * {@link packageInstallPaths}); a package whose files are gone needs pi's installer again.
 */
export function enablePackageSource(source: string, deps: {
	readonly profileDir: string;
	readonly workspaceDirs: readonly string[];
	readonly fs: ManageFs;
	readonly record: DisabledRecord;
}): PackageFlowResult {
	const trimmed = source.trim();
	if (trimmed.length === 0) {
		return { record: deps.record, changedFiles: [] };
	}
	const file = profileSettingsFile(deps.profileDir);
	const text = deps.fs.readText(file);
	const result = packagesArrayWith(text, trimmed);
	if (result.changed) {
		deps.fs.writeText(file, result.text);
	}
	return { record: disabledRecordWithout(deps.record, deps.profileDir, trimmed), changedFiles: result.changed ? [file] : [] };
}

/** Applies one array edit to each settings file, writing only the files that change. */
function editSettingsFiles(files: readonly string[], source: string, fs: ManageFs, edit: (text: string | undefined, source: string) => { text: string; changed: boolean }): string[] {
	const changedFiles: string[] = [];
	for (const file of files) {
		const result = edit(fs.readText(file), source);
		if (result.changed) {
			fs.writeText(file, result.text);
			changedFiles.push(file);
		}
	}
	return changedFiles;
}

/* ------------------------------------------------------------------ *
 * Where a source's files would be installed
 * ------------------------------------------------------------------ */

/**
 * The directories one source's files live in, per scope: the profile's first, then every
 * workspace's. The caller asks `exists` on them — a package whose files are all gone needs
 * pi's installer again when it is enabled. An unspellable source resolves to nothing.
 */
export function packageInstallPaths(source: string, profileDir: string, workspaceDirs: readonly string[]): readonly string[] {
	const parsed = parsePackageSource(source);
	if (parsed === undefined) {
		return [];
	}
	const scopes = [
		userPackageScope(profileDir, undefined),
		...workspaceDirs.map(folder => projectPackageScope(folder, undefined)),
	];
	return scopes.map(scope => installPathFor(parsed, scope));
}

/** The declaration text of one raw `packages` entry, as the file spells it. */
function declarationText(raw: unknown): string | undefined {
	if (typeof raw === 'string') {
		return raw.trim();
	}
	if (isRecord(raw) && typeof raw['source'] === 'string') {
		return raw['source'].trim();
	}
	return undefined;
}

/** Where one parsed source's files live under one scope — the same resolution pi does. */
function installPathFor(parsed: NonNullable<ReturnType<typeof parsePackageSource>>, scope: PackageScope): string {
	switch (parsed.kind) {
		case 'npm':
			return path.join(scope.npmRoot, parsed.name);
		case 'git':
			return path.join(scope.gitRoot, parsed.host, parsed.path);
		case 'local':
			// A relative path resolves against the settings file that wrote it.
			return path.isAbsolute(parsed.path) ? parsed.path : path.join(scope.baseDir, parsed.path);
	}
}

/* ------------------------------------------------------------------ *
 * The listing's merge: what the page shows per package
 * ------------------------------------------------------------------ */

/**
 * The state of every package in the listing, keyed by the directory the package was found in.
 *
 * A declaration wins its scope and source from the settings file that spells it (the profile's
 * declaration answers before a workspace's). The disabled record then brings its sources back:
 * a package whose declaration was removed still resolves to the directory pi installed it in,
 * and every directory a recorded source points at is marked Disabled — that is how a disabled
 * package stays in the listing instead of silently vanishing. Anything left over is a package
 * the scan found without a declaration: Enabled, with no source of its own.
 */
export function packageDisplayInfo(
	packages: readonly PiPackage[],
	scopes: readonly PackageScope[],
	disabled: DisabledRecord,
	profileDir: string,
): ReadonlyMap<string, PackageRowInfo> {
	const declarations = new Map<string, PackageRowInfo>();
	const disabledPaths = new Map<string, PackageRowInfo>();
	for (const scope of scopes) {
		const kind: PackageScopeKind = scope.source === 'user' ? 'user' : 'workspace';
		const declared = Array.isArray(scope.settings?.['packages']) ? scope.settings?.['packages'] : [];
		for (const raw of declared ?? []) {
			const text = declarationText(raw);
			const parsed = text === undefined ? undefined : parsePackageSource(text);
			if (text === undefined || parsed === undefined) {
				continue;
			}
			const dir = installPathFor(parsed, scope);
			if (!declarations.has(dir)) {
				declarations.set(dir, { source: text, state: 'enabled', scope: kind });
			}
		}
	}
	for (const source of disabled[profileDir] ?? []) {
		const parsed = parsePackageSource(source);
		if (parsed === undefined) {
			continue;
		}
		for (const scope of scopes) {
			const kind: PackageScopeKind = scope.source === 'user' ? 'user' : 'workspace';
			const dir = installPathFor(parsed, scope);
			if (!disabledPaths.has(dir)) {
				disabledPaths.set(dir, { source, state: 'disabled', scope: kind });
			}
		}
	}
	const info = new Map<string, PackageRowInfo>();
	for (const found of packages) {
		info.set(found.path, disabledPaths.get(found.path) ?? declarations.get(found.path) ?? scopeForPath(found.path, scopes));
	}
	return info;
}

/** The state of a package with no declaration and no record: Enabled, scoped by where it lives. */
function scopeForPath(dir: string, scopes: readonly PackageScope[]): PackageRowInfo {
	for (const scope of scopes) {
		if (dir.startsWith(scope.npmRoot) || dir.startsWith(scope.gitRoot)) {
			return { state: 'enabled', scope: scope.source === 'user' ? 'user' : 'workspace' };
		}
	}
	return { state: 'enabled' };
}

/* ------------------------------------------------------------------ *
 * The remover: pi's own `pi remove`
 * ------------------------------------------------------------------ */

/**
 * The real spawn: `execFile` with an **args array only**, exactly as `packages-registry.ts`
 * runs the installer. The source is one argv element, never a shell string.
 *
 * `packages-registry.ts` keeps its spawn private and its failure lines are shaped the same
 * way; this is the one command outside the installer's queue that runs pi's CLI, and it
 * duplicates the runner rather than widening the installer module's surface.
 */
function defaultSpawn(file: string, args: readonly string[], options: SpawnOptions): Promise<SpawnOutcome> {
	return new Promise(resolve => {
		execFile(file, args, {
			env: options.env,
			windowsHide: options.windowsHide,
			timeout: options.timeoutMs,
		}, (error, _stdout, stderr) => {
			resolve({
				ok: error === null,
				stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : (error?.message ?? ''),
			});
		});
	});
}

/** The stderr line the failure message carries, or nothing when pi said nothing usable. */
function lastMeaningfulLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
	const last = lines[lines.length - 1];
	if (last === undefined) {
		return undefined;
	}
	return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/** How long pi may take to remove one package before the run is cut — the installer's leash. */
const REMOVE_TIMEOUT_MS = 180_000;

/**
 * One removal, run now: `pi remove <source>` into the profile in force.
 *
 * The source is passed to pi **as the settings file spells it** — the declaration came from
 * pi's own list, so rewriting it (as the installer normalizes a bare name to `npm:…`) could
 * only make pi look for a package under a name it was never declared by. Like the installer,
 * the spawn is awaited with a three-minute leash and both outcomes end in one sentence the
 * page can show as-is.
 */
export async function removePackage(rawSource: string, context: InstallContext): Promise<InstallResult> {
	const source = rawSource.trim();
	if (source.length === 0) {
		return { ok: false, message: 'No package source was given.' };
	}
	let outcome: SpawnOutcome;
	try {
		outcome = await (context.spawn ?? defaultSpawn)(process.execPath, [context.cliEntry, 'remove', source], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: context.profileDir },
			windowsHide: true,
			timeoutMs: REMOVE_TIMEOUT_MS,
		});
	} catch (error) {
		return { ok: false, message: `Package ${source} could not be removed (${error instanceof Error ? error.message : String(error)}).` };
	}
	if (!outcome.ok) {
		const reason = lastMeaningfulLine(outcome.stderr);
		return { ok: false, message: `Package ${source} could not be removed${reason === undefined ? '.' : `: ${reason}`}` };
	}
	return { ok: true, message: `Package ${source} removed with pi.` };
}
