/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The catalog and the installer behind the chat page's Packages section, run on their own.
 *
 * The page shows two things: **what exists** — pi's catalog is the npm packages tagged with
 * pi's keywords, the very list `pi.dev/packages` renders, asked straight from npm's own search
 * endpoint (pi.dev has no public API of its own) — and **how one gets in**, which is always
 * pi's own installer, run into the profile in force. This module holds the rules of both: the
 * search's URL, parse, sort and cache, and how an install target is spelled for pi.
 *
 * ## Why this module has no `vscode` import
 *
 * The same split `models-cache.ts` makes: everything here is a rule about data and time, not
 * about the editor. The network arrives through an injectable `fetchFn`, the clock through an
 * injectable `now`, and the process spawn through an injectable `spawn`, so the rules can be
 * exercised by running them — the catalog's shape, the cache's lifetime, and the spellings pi
 * accepts — without an editor and without a network in the way. `extension.ts` resolves the
 * editor-only parts (the profile in force, the bundled pi CLI) and hands them in.
 */

import { execFile } from 'node:child_process';
import { cacheKey, cachedModels, storeModels, type CacheEntry } from './models-cache';

/* ------------------------------------------------------------------ *
 * The catalog: what npm says about pi packages
 * ------------------------------------------------------------------ */

/** One package of the catalog, as the page's list shows it. */
export interface PackageSearchRow {
	readonly name: string;
	readonly description?: string;
	readonly publisher?: string;
	readonly version?: string;
}

/**
 * The one fetch the search needs, as narrow as it can be.
 *
 * The default is the runtime's own `fetch`; the injected shape says only what the parse reads
 * — a status and a body — so a test can answer from memory.
 */
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

/** npm's own search endpoint; `text` and `size` are appended per query. */
const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';

/** The keyword pi packages are tagged with; the query the owner types is added after it. */
const SEARCH_KEYWORD = 'keywords:pi-package';

/** One page of results is all the page shows; npm's default of 25 is smaller than the list needs. */
const SEARCH_SIZE = 50;

/** A catalog that never answers must not hold the page open: the request is cut at eight seconds. */
const SEARCH_TIMEOUT_MS = 8_000;

/** How long one query's answer is served without asking npm again. */
const SEARCH_TTL_MS = 5 * 60_000;

/** The catalog's answers, per query — so repeated opens of the page do not refetch. */
const searchCache = new Map<string, CacheEntry<PackageSearchRow[]>>();

/**
 * The URL one search asks, built so a test can pin the whole contract.
 *
 * The owner's query is appended after the keyword and the whole `text` value is encoded once —
 * npm reads `keywords:pi-package react hooks` as "tagged pi-package, matching react hooks".
 * An empty query searches the keyword alone, which is the full catalog.
 */
export function catalogSearchUrl(query: string): string {
	const trimmed = query.trim();
	const text = trimmed.length > 0 ? `${SEARCH_KEYWORD} ${trimmed}` : SEARCH_KEYWORD;
	return `${SEARCH_URL}?text=${encodeURIComponent(text)}&size=${SEARCH_SIZE}`;
}

/** One object of npm's search payload, as far as this module reads it. */
interface CatalogEntry {
	readonly package?: {
		readonly name?: unknown;
		readonly description?: unknown;
		readonly version?: unknown;
		readonly publisher?: { readonly username?: unknown };
	};
	readonly downloads?: { readonly monthly?: unknown };
}

/**
 * The payload as rows, or an empty list when it says nothing this module understands.
 *
 * Entries without a name are skipped — a row without a name cannot be shown or installed —
 * and the rest are sorted by npm's monthly downloads, most first, so the page opens on the
 * packages people actually use. A payload without downloads sorts those rows last.
 */
function parseCatalog(payload: unknown): PackageSearchRow[] {
	const objects = typeof payload === 'object' && payload !== null && 'objects' in payload
		? (payload as { objects?: unknown }).objects
		: undefined;
	if (!Array.isArray(objects)) {
		return [];
	}
	const rows: { row: PackageSearchRow; downloads: number }[] = [];
	for (const object of objects) {
		const entry = object as CatalogEntry;
		const manifest = entry?.package;
		if (typeof manifest?.name !== 'string' || manifest.name.length === 0) {
			continue;
		}
		const row: {
			name: string;
			description?: string;
			publisher?: string;
			version?: string;
		} = { name: manifest.name };
		if (typeof manifest.description === 'string') {
			row.description = manifest.description;
		}
		if (typeof manifest.publisher?.username === 'string') {
			row.publisher = manifest.publisher.username;
		}
		if (typeof manifest.version === 'string') {
			row.version = manifest.version;
		}
		const downloads = typeof entry.downloads?.monthly === 'number' ? entry.downloads.monthly : 0;
		rows.push({ row, downloads });
	}
	return rows.sort((left, right) => right.downloads - left.downloads).map(kept => kept.row);
}

/** What a search needs beside the query; everything is optional and defaults to the real thing. */
export interface SearchDependencies {
	/** The network. Defaults to the runtime's own `fetch`. */
	readonly fetchFn?: FetchFn;
	/** The clock, for the cache's lifetime. Defaults to `Date.now`. */
	readonly now?: () => number;
	/** Where problems are said once per session; the page shows its empty state either way. */
	readonly log?: (line: string) => void;
}

/**
 * The catalog, for the query the owner typed.
 *
 * A fresh cached answer is served without a request. Otherwise npm is asked once, with an
 * eight-second leash, and the parsed rows are cached for five minutes — keyed by the full
 * URL, so one query's answer never masquerades as another's. Every failure — a network
 * error, a non-OK status, a body that will not parse — is an empty list, said out loud once
 * through `log`, and **not** cached: a downed network must not be remembered as an empty
 * catalog for five minutes.
 */
export async function searchPackages(query: string, deps: SearchDependencies = {}): Promise<PackageSearchRow[]> {
	const url = catalogSearchUrl(query);
	const key = cacheKey('packages-catalog', url);
	const now = (deps.now ?? Date.now)();
	const cached = cachedModels(searchCache, key, SEARCH_TTL_MS, now);
	if (cached.fresh && cached.value !== undefined) {
		return cached.value;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const fetchFn: FetchFn = deps.fetchFn ?? ((url_, init_) => fetch(url_, init_));
		const response = await fetchFn(url, { signal: controller.signal });
		if (!response.ok) {
			deps.log?.(`packages: the catalog answered ${response.status} for ${url}`);
			return [];
		}
		const rows = parseCatalog(await response.json());
		storeModels(searchCache, key, rows, now);
		return rows;
	} catch (error) {
		deps.log?.(`packages: the catalog search failed (${error instanceof Error ? error.message : String(error)})`);
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/* ------------------------------------------------------------------ *
 * The installer: how a target is spelled for pi
 * ------------------------------------------------------------------ */

/** What an install answers: whether it worked, and the one sentence the page shows. */
export interface InstallResult {
	readonly ok: boolean;
	readonly message: string;
}

/** One process run: whether it exited cleanly, and what pi said on its error stream. */
export interface SpawnOutcome {
	readonly ok: boolean;
	readonly stderr: string;
}

/** The options a spawn needs; the test's fake reads them, the real one hands them to `execFile`. */
export interface SpawnOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly windowsHide: boolean;
	readonly timeoutMs: number;
}

/** The process run, injectable so a test can observe what would have been executed. */
export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => Promise<SpawnOutcome>;

/**
 * The real spawn: `execFile` with an **args array only**.
 *
 * The install target is one argv element, never a shell string — whatever the page hands in
 * is passed to pi verbatim and executed by nobody.
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

/**
 * How pi is told to install one target.
 *
 * The rule follows what pi's own installer accepts:
 *
 * - a **git URL** — `http(s)://…`, `git@…`, or anything ending in `.git` — is passed through
 *   untouched, because rewriting it could only break it;
 * - a bare **`owner/repo` shorthand** (exactly two segments, neither carrying `@`) is passed
 *   through as-is too. It is deliberately ambiguous — an npm name never looks like that, and
 *   pi's manager reads it as GitHub shorthand — so pi decides, not this module;
 * - an already-spelled `npm:…` target keeps its spelling;
 * - everything else is an npm name — plain (`pkg`) or scoped (`@scope/pkg`, whose `/` is why
 *   the shorthand rule needs the no-`@` guard) — and is prefixed with `npm:`, pi's spelling.
 */
export function installTargetSpec(target: string): string {
	const trimmed = target.trim();
	if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('git@') || trimmed.endsWith('.git')) {
		return trimmed;
	}
	if (/^[^@/]+\/[^@/]+$/.test(trimmed)) {
		return trimmed;
	}
	if (trimmed.startsWith('npm:')) {
		return trimmed;
	}
	return `npm:${trimmed}`;
}

/**
 * Turns one of pi's package sources into the spec npm installs, or `undefined` for the
 * sources that cannot come across — a local path names the other machine's disk.
 *
 * The import writes the declarations from the external profile and then installs each one
 * directly with npm (hidden console — see the import flow), so it needs the npm spelling:
 * `npm:x` is just `x`, and pi's `git:host/path` and `https://host/path` sources are npm's
 * `git+https://host/path`.
 */
export function npmInstallSpec(source: string): string | undefined {
	const trimmed = source.trim();
	if (trimmed.startsWith('npm:')) {
		return trimmed.slice(4) || undefined;
	}
	if (trimmed.startsWith('git:')) {
		const host = trimmed.slice(4);
		return host.length > 0 ? `git+https://${host}` : undefined;
	}
	if (/^https:\/\//i.test(trimmed)) {
		return `git+${trimmed}`;
	}
	return undefined;
}

/**
 * Whether an npm install spec is safe to hand to a shell.
 *
 * npm runs this editor starts are planned by `npm-run.ts`: node over npm's own CLI script,
 * a real arguments array, no shell — and pi's own installer reaches npm itself. But the npm
 * shim fallback in that planner still goes through a shell, and pi spawns npm through one
 * (`cross-spawn` → `npm.cmd`), so the whitelist stays in front of every install as belt and
 * braces. A shell does not escape its arguments, it concatenates them, so whatever a profile
 * declares is executed character for character if it carries metacharacters. Profiles are
 * data this editor did not write — an imported one came from another machine — so every spec
 * is checked against this whitelist **before** any install uses it, and what does not fit is
 * refused with a line that names it, never passed through.
 *
 * Accepted: an npm name (plain or `@scope/name`), optionally pinned with a version or range
 * (`pkg@1.2.3`, `pkg@^1.0.0`, `pkg@>=1.0.0`), and a `git+https://host/path` source. A leading
 * `-` is refused — an argument here is always a spec, never a flag npm would read — and so is
 * everything a shell could act on: `; & | ` quotes, command substitution, whitespace, `..`.
 */
export function isSafeNpmInstallSpec(spec: string): boolean {
	if (spec.startsWith('-') || spec.includes('..')) {
		return false;
	}
	if (spec.startsWith('git+https://')) {
		return /^git\+https:\/\/[A-Za-z0-9._~-]+(:\d+)?(\/[A-Za-z0-9._~-]+)*$/.test(spec);
	}
	return /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9.^~<>=+-]+)?$/.test(spec);
}

/** What an install needs beside the target, resolved by the caller (`extension.ts`). */
export interface InstallContext {
	/** The bundled pi CLI's entry, already checked for existence by the caller. */
	readonly cliEntry: string;
	/** The profile in force — the directory pi installs into, handed to it as `PI_CODING_AGENT_DIR`. */
	readonly profileDir: string;
	/** The process run. Defaults to `execFile` with an args array. */
	readonly spawn?: SpawnFn;
	/**
	 * Reads a file as text, or nothing when it is not there. Defaults to the real disk; the
	 * removal flow injects a stub so the already-removed branch can be exercised without a
	 * profile on disk.
	 */
	readonly readSettingsFile?: (filePath: string) => Promise<string | undefined>;
}

/** How long pi may take to install one package before the run is cut. */
const INSTALL_TIMEOUT_MS = 180_000;

/** The stderr line the failure message carries, or nothing when pi said nothing usable. */
function lastMeaningfulLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
	const last = lines[lines.length - 1];
	if (last === undefined) {
		return undefined;
	}
	return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/**
 * One install, run now.
 *
 * An empty target is refused before anything is spawned: there is nothing to install, and a
 * run of `pi install npm:` would only make pi say so less clearly. The spawn is awaited with
 * a three-minute leash, and both outcomes end in one sentence the page can show as-is — the
 * success naming the target exactly as the owner typed it, the failure carrying the last
 * meaningful line of pi's stderr, which is where npm puts the reason.
 */
async function runInstall(rawTarget: string, context: InstallContext): Promise<InstallResult> {
	const target = rawTarget.trim();
	if (target.length === 0) {
		return { ok: false, message: 'No package name or URL was given.' };
	}
	const spec = installTargetSpec(target);
	let outcome: SpawnOutcome;
	try {
		outcome = await (context.spawn ?? defaultSpawn)(process.execPath, [context.cliEntry, 'install', spec], {
			// The editor's executable is Electron: without this flag it would try to open an
			// app instead of running pi's script as Node — the same invocation the MCP
			// server writer uses for pi.
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: context.profileDir },
			windowsHide: true,
			timeoutMs: INSTALL_TIMEOUT_MS,
		});
	} catch (error) {
		return { ok: false, message: `Package ${target} could not be installed (${error instanceof Error ? error.message : String(error)}).` };
	}
	if (!outcome.ok) {
		const reason = lastMeaningfulLine(outcome.stderr);
		return { ok: false, message: `Package ${target} could not be installed${reason === undefined ? '.' : `: ${reason}`}` };
	}
	return { ok: true, message: `Package ${target} installed with pi.` };
}

/**
 * An install into the profile in force, **one at a time**.
 *
 * Two clicks must not interleave pi's installs into the same profile — npm's own bookkeeping
 * is not built for that — so installs run one at a time, chained: each caller waits for the
 * ones queued before it and gets **its own** package installed with **its own** result. A
 * shared flight would answer a caller about a package it never asked for.
 */
let installQueue: Promise<InstallResult> = Promise.resolve({ ok: true, message: '' });

export function installPackage(target: string, context: InstallContext): Promise<InstallResult> {
	const run = installQueue.then(() => runInstall(target, context));
	// The chain never keeps a rejection: a failed install must not fail the ones queued after it.
	const linked = run.catch(() => ({ ok: false, message: `Package ${target} could not be installed.` }));
	installQueue = linked;
	return run;
}
