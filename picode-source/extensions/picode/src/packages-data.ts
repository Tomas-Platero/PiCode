/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type { FsReader, ResourceSource } from './customizations';

/**
 * The packages pi has installed — the "Plugins" of the chat's management page.
 *
 * pi's packages are ordinary npm packages, git checkouts or local directories that pi loads as one
 * unit (extensions, skills, prompts, themes). The owner's list of them is `packages` in the
 * settings file, and pi resolves every entry to a directory on disk before it loads anything.
 *
 * ## Where the answers come from
 *
 * - **The declarations**: `settings.json`'s `packages`, read exactly as this connector already
 *   writes it (`onboarding.ts` filters `typeof p === 'string'`) and as pi documents it
 *   (`docs/packages.md`): a string (`"npm:gentle-pi"`) or an object with a `source`. The
 *   per-scope files are `<profile>/settings.json` and `<workspace>/.pi/settings.json`
 *   (`settings-manager.js:61`), and a project's declarations only count while the project is
 *   trusted — pi itself throws project settings away when it is not (`loadFromStorage`), so this
 *   module does not read them at all in that case (the caller decides that, see `extension.ts`).
 * - **The installed directories**: pi installs an npm package to `<root>/npm/node_modules/<name>`
 *   and a git one to `<root>/git/<host>/<path>` (`package-manager.js:1723` and `:1749`), with
 *   `<root>` being the profile for a personal package and `<workspace>/.pi` for a project one. The
 *   walk over those `node_modules` is not the *declaration* list read a second time: it is how a
 *   package that is on disk gets listed even when the settings file no longer mentions it — and
 *   that same `node_modules` holds every transitive dependency of the two, which is why the scan
 *   keeps only directories that declare themselves as pi packages (`pi` manifest, the `pi-package`
 *   keyword, or a conventional resource directory). Ninety-five directories live there; three of
 *   them are pi packages.
 * - **What is not listed**: a declaration pi could not resolve to an existing directory. pi's own
 *   `getInstalledPath` answers `undefined` for those, so "configured but not installed" is not a
 *   package of this profile and inventing a path for it would put a row in the list that opens
 *   nothing. Those names are returned in `unresolved` for the log instead.
 *
 * ## No `vscode` import
 *
 * Pure mapping over an injected filesystem, so `node --test` covers it.
 */

/** One installed package, in the shape the editor's plugin list asks for. */
export interface PiPackage {
	/** pi's identity for the package: its npm name, or the directory's name. */
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	/** The directory pi loaded it from. */
	readonly path: string;
}

/** One settings file, once parsed: pi's `settings.json` keys and their values. */
export type SettingsDocument = Readonly<Record<string, unknown>>;

/** One settings scope: what it declares, and where its installs land. */
export interface PackageScope {
	/** The parsed `settings.json`, or `undefined` when there is none. */
	readonly settings: SettingsDocument | undefined;
	/** The directory the settings file lives in: what a relative path resolves against. */
	readonly baseDir: string;
	/** Where npm installs of this scope land. */
	readonly npmRoot: string;
	/** Where git checkouts of this scope land. */
	readonly gitRoot: string;
	readonly source: ResourceSource;
}

/** The personal scope: pi's own profile. */
export function userPackageScope(profileDir: string, settings: SettingsDocument | undefined): PackageScope {
	return {
		settings,
		baseDir: profileDir,
		npmRoot: path.join(profileDir, 'npm', 'node_modules'),
		gitRoot: path.join(profileDir, 'git'),
		source: 'user',
	};
}

/** A project scope: `<workspace>/.pi`, which is pi's project configuration directory. */
export function projectPackageScope(folder: string, settings: SettingsDocument | undefined): PackageScope {
	const root = path.join(folder, '.pi');
	return {
		settings,
		baseDir: folder,
		npmRoot: path.join(root, 'npm', 'node_modules'),
		gitRoot: path.join(root, 'git'),
		source: 'local',
	};
}

/** The settings file itself, parsed; `undefined` for a missing or malformed one. */
export function parseSettings(text: string | undefined): SettingsDocument | undefined {
	if (text === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ *
 * What the settings declare
 * ------------------------------------------------------------------ */

/** A declaration, once its source has been classified. */
export type PackageSource =
	| { readonly kind: 'npm'; readonly name: string; readonly spec: string }
	| { readonly kind: 'git'; readonly host: string; readonly path: string; readonly spec: string }
	| { readonly kind: 'local'; readonly path: string; readonly spec: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The name and version of an npm spec, the way pi's `parseNpmSpec` reads it. */
function npmName(spec: string): string | undefined {
	const match = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec.trim());
	const name = match?.[1]?.trim();
	return name === undefined || name.length === 0 ? undefined : name;
}

/**
 * One `packages` entry, classified.
 *
 * The three kinds and their spellings are pi's own: `npm:` for npm, then a local path for anything
 * that is not a package source or a remote protocol (`isLocalPath`), then a git repository for
 * `git:`/`http(s)://`/`ssh://` (`parseGitUrl`). A bare name (`gentle-pi`) is a local path for pi,
 * so it is one here too.
 */
export function parsePackageSource(raw: unknown): PackageSource | undefined {
	const declaration = typeof raw === 'string'
		? raw
		: isRecord(raw) && typeof raw['source'] === 'string'
			? raw['source']
			: undefined;
	if (declaration === undefined) {
		return undefined;
	}
	const trimmed = declaration.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (trimmed.startsWith('npm:')) {
		const spec = trimmed.slice('npm:'.length).trim();
		const name = npmName(spec);
		return name === undefined ? undefined : { kind: 'npm', name, spec };
	}
	if (trimmed.startsWith('git:') || /^(https?|ssh|git):\/\//i.test(trimmed)) {
		const withoutScheme = trimmed.startsWith('git:') ? trimmed.slice('git:'.length).trim() : trimmed.replace(/^[a-z]+:\/\//i, '');
		// A trailing `@ref` pins the checkout; it is not part of the repository's path.
		const withoutRef = withoutScheme.replace(/@[^/]*$/, '').trim();
		const slash = withoutRef.indexOf('/');
		if (slash <= 0 || slash === withoutRef.length - 1) {
			return undefined;
		}
		return {
			kind: 'git',
			host: withoutRef.slice(0, slash),
			path: withoutRef.slice(slash + 1).replace(/\.git$/, ''),
			spec: trimmed,
		};
	}
	if (/^file:\/\//i.test(trimmed)) {
		// A `file:` URL is a local path for pi; rewriting a URL into a Windows path is a second
		// way to get it wrong, so it is reported instead of guessed at.
		return undefined;
	}
	return { kind: 'local', path: trimmed, spec: trimmed };
}

/** The declarations of one scope, as the directories they resolve to. */
function declaredPaths(scope: PackageScope): readonly string[] {
	const declared = scope.settings?.['packages'];
	if (!Array.isArray(declared)) {
		return [];
	}
	const paths: string[] = [];
	for (const raw of declared) {
		const source = parsePackageSource(raw);
		if (source === undefined) {
			continue;
		}
		switch (source.kind) {
			case 'npm':
				paths.push(path.join(scope.npmRoot, source.name));
				break;
			case 'git':
				paths.push(path.join(scope.gitRoot, source.host, source.path));
				break;
			case 'local':
				// A relative path resolves against the settings file that wrote it — which is why the
				// scope carries its own base directory (`getBaseDirForScope` in pi) — and `path.join`
				// collapses the `.` and `..` in it, so a declaration and the directory it points at are
				// one row and not two spellings of one row.
				paths.push(path.isAbsolute(source.path) ? source.path : path.join(scope.baseDir, source.path));
				break;
		}
	}
	return paths;
}

/* ------------------------------------------------------------------ *
 * What is on disk
 * ------------------------------------------------------------------ */

/** One package's manifest, read where it lives. */
function readManifest(dir: string, read: FsReader): SettingsDocument | undefined {
	const text = read.text(path.join(dir, 'package.json'));
	if (text === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** How deep the resource check below looks before it stops. */
const RESOURCE_DIRS = ['extensions', 'skills', 'prompts', 'themes'];

/** A list of strings, dropping everything that is not one. */
function stringList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Whether a directory is a pi package.
 *
 * Declaring itself is the test, because `node_modules` is full of packages that are not one: a `pi`
 * manifest, the `pi-package` keyword the gallery indexes (`docs/packages.md`), or one of the
 * conventional resource directories — the three ways pi's package discovery recognizes a package
 * without a manifest.
 */
export function isPiPackage(dir: string, manifest: SettingsDocument | undefined, read: FsReader): boolean {
	if (manifest === undefined) {
		return false;
	}
	if (isRecord(manifest['pi'])) {
		return true;
	}
	if (stringList(manifest['keywords']).includes('pi-package')) {
		return true;
	}
	return RESOURCE_DIRS.some(resource => read.entries(path.join(dir, resource)).length > 0);
}

/** One installed directory, in the editor's shape; `undefined` when it has no manifest to name it. */
function packageAt(dir: string, read: FsReader): PiPackage | undefined {
	const manifest = readManifest(dir, read);
	if (manifest === undefined) {
		return undefined;
	}
	const declaredName = typeof manifest['name'] === 'string' ? manifest['name'].trim() : '';
	const id = declaredName.length > 0 ? declaredName : dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir;
	const version = typeof manifest['version'] === 'string' ? manifest['version'] : undefined;
	const description = typeof manifest['description'] === 'string' ? manifest['description'] : undefined;
	return {
		id,
		name: id,
		...(version === undefined ? {} : { version }),
		...(description === undefined ? {} : { description }),
		path: dir,
	};
}

/**
 * Every pi package installed under one `node_modules`.
 *
 * The scoped form is one level deeper (`@scope/pkg`), which is where `@heyhuynhgiabuu/pi-pretty`
 * lives.
 */
export function installedPackages(npmRoot: string, read: FsReader): readonly PiPackage[] {
	const packages: PiPackage[] = [];
	const scan = (dir: string): void => {
		if (!isPiPackage(dir, readManifest(dir, read), read)) {
			return;
		}
		const found = packageAt(dir, read);
		if (found !== undefined) {
			packages.push(found);
		}
	};
	for (const entry of read.entries(npmRoot)) {
		if (!entry.directory) {
			continue;
		}
		if (entry.name.startsWith('@')) {
			for (const scoped of read.entries(path.join(npmRoot, entry.name))) {
				if (scoped.directory) {
					scan(path.join(npmRoot, entry.name, scoped.name));
				}
			}
			continue;
		}
		if (entry.name.startsWith('.')) {
			continue;
		}
		scan(path.join(npmRoot, entry.name));
	}
	return packages;
}

/** What one read of every scope produced: the packages, and what could not be resolved. */
export interface PackageReadResult {
	/** Sorted by name, one row per directory. */
	readonly packages: readonly PiPackage[];
	/** The declarations that resolved to nothing, one line each, for the log. */
	readonly unresolved: readonly string[];
}

/**
 * The packages pi has, from the declarations and from what is installed.
 *
 * A declaration and a scan that name the same directory are **one** row: the settings file and the
 * directory are two views of the same install, and listing it twice would make the page look like
 * the profile holds two copies.
 */
export function piPackages(scopes: readonly PackageScope[], read: FsReader): PackageReadResult {
	const byPath = new Map<string, PiPackage>();
	const unresolved: string[] = [];

	for (const scope of scopes) {
		for (const dir of declaredPaths(scope)) {
			if (!read.exists(dir)) {
				unresolved.push(`${dir}: declared, but nothing is installed there`);
				continue;
			}
			const found = packageAt(dir, read);
			if (found === undefined) {
				unresolved.push(`${dir}: installed, but it has no readable package.json`);
				continue;
			}
			byPath.set(found.path, found);
		}
	}

	for (const scope of scopes) {
		for (const found of installedPackages(scope.npmRoot, read)) {
			byPath.set(found.path, found);
		}
	}

	return {
		packages: [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name)),
		unresolved,
	};
}

/**
 * The skill directories one package contributes.
 *
 * A package says where its skills are (`pi.skills` in its manifest, as `gentle-pi` does with
 * `["./skills"]`); without that manifest key, the conventional `skills/` directory is the answer.
 * An entry that is a glob is walked from its literal part — `./resources/skills/*` reads
 * `./resources/skills` — because the pattern's job is usually just to name the directory, and the
 * skill walk below finds `SKILL.md` at any depth anyway. Exclusions in a pattern are not applied.
 */
export function packageSkillDirs(dir: string, read: FsReader): readonly string[] {
	const manifest = readManifest(dir, read);
	const pi = manifest === undefined ? undefined : manifest['pi'];
	const declared = isRecord(pi) ? stringList(pi['skills']).map(entry => entry.trim()) : [];
	const candidates = declared.length > 0
		? declared
		: ['skills'];
	return candidates
		.filter(entry => entry.length > 0)
		.map(entry => literalPrefix(entry))
		.map(entry => (path.isAbsolute(entry) ? entry : path.join(dir, entry)))
		.filter(candidate => read.exists(candidate));
}

/** The part of a path pattern before its first wildcard, without a trailing separator. */
function literalPrefix(pattern: string): string {
	const wildcard = pattern.search(/[*?[]/);
	const literal = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
	return literal.replace(/[\\/]+$/, '');
}
