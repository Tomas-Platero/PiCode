/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether an installed package is behind, and how it is taken to the newer version, run on
 * their own.
 *
 * The host already has this shape — `updates-check.ts` asks npm's registry which of the
 * installed things are behind and runs the update through `npm-run.ts`'s shell-free planner —
 * and the Packages page's rows now get the same courtesy: a row that is behind says what it is
 * behind **to**, and its Update action takes it there on the profile in force.
 *
 * The rules of what can be checked:
 *
 * - An npm declaration (`npm:name`, optionally pinned as `npm:name@range`) can be asked of
 *   npm's registry. A **pinned** one can still be *checked* — the installed version on disk
 *   against the registry's latest — but it cannot be taken: pi loads the pinned spelling, so
 *   an install behind its back would be re-pinned on the next load, and the row says to
 *   change the pin instead.
 * - A **git** declaration cannot be honestly checked by npm: the registry has no answer for a
 *   checkout pi installed as a repository, and guessing one would put a fake badge on a row.
 *   The row says it cannot be checked. The same for a **local path** — the answer is the
 *   owner's disk, not the registry.
 * - A package the scan found without a declaration has no spelling to check against and no
 *   spec to reinstall with; it says so too.
 *
 * ## Not slow, not chatty
 *
 * One registry call per checkable package (the same `fetchNpmLatest` the host check uses, an
 * eight-second leash each), answered **in parallel** — sixteen packages is sixteen quick
 * requests, not sixteen queued ones. The latest version of each package is cached in memory
 * for ten minutes (`checkPackageUpdates` serves a fresh cache without a request), overlapping
 * checks for the same package share one flight, and a failed lookup is **not** cached — a downed
 * network must not be remembered as "current" for ten minutes. Refreshing the page inside the
 * lifetime asks the registry for nothing.
 *
 * ## Why this module has no `vscode` import
 *
 * The same split `updates-check.ts` and `packages-registry.ts` make: everything here is a rule
 * about versions, time and argv, not about the editor. The network arrives through an
 * injectable `fetchFn`, the clock through an injectable `now`, and the process spawn through
 * an injectable `spawn`, so the rules can be exercised by running them without an editor, a
 * network or a process in the way. `extension.ts` resolves the editor-only parts (the profile
 * in force, npm's CLI script) and hands them in.
 */

import { execFile } from 'node:child_process';
import { cacheKey, cachedModels, singleFlight, storeModels, type CacheEntry } from './models-cache';
import { parsePackageSource } from './packages-data';
import { isSafeNpmInstallSpec, type InstallResult } from './packages-registry';
import { npmRunEnv, planNpmRun } from './npm-run';
import { compareVersions, fetchNpmLatest, isComparableVersion, type FetchFn } from './updates-check';

/* ------------------------------------------------------------------ *
 * What can be checked
 * ------------------------------------------------------------------ */

/** One declaration classified for the update check. */
export type UpdateCheckableSource =
	| { readonly kind: 'npm'; readonly name: string; readonly pin?: string }
	| { readonly kind: 'uncheckable'; readonly reason: string };

/**
 * One package's declaration, classified for the update check.
 *
 * The spellings are pi's own (`parsePackageSource` reads them): `npm:name` — with the pin, if
 * one is written, carried separately so the update can refuse it — and everything else
 * uncheckable with the reason the row will say.
 */
export function updateCheckableSource(source: string | undefined): UpdateCheckableSource {
	const trimmed = source?.trim() ?? '';
	if (trimmed.length === 0) {
		return { kind: 'uncheckable', reason: 'No declaration of its own to check' };
	}
	const parsed = parsePackageSource(trimmed);
	if (parsed === undefined) {
		return { kind: 'uncheckable', reason: 'Its declaration cannot be read' };
	}
	if (parsed.kind === 'git') {
		return { kind: 'uncheckable', reason: 'Installed from git; npm cannot say whether it is behind' };
	}
	if (parsed.kind === 'local') {
		return { kind: 'uncheckable', reason: 'A local path; npm cannot say whether it is behind' };
	}
	// The spec is the name alone, or the name with the pin after an `@` — the same split
	// `parsePackageSource` made, kept here as the row's honest refusal when an update is asked.
	const pin = parsed.spec.length > parsed.name.length ? parsed.spec.slice(parsed.name.length + 1) : undefined;
	return pin === undefined ? { kind: 'npm', name: parsed.name } : { kind: 'npm', name: parsed.name, pin };
}

/* ------------------------------------------------------------------ *
 * The decision: is it behind?
 * ------------------------------------------------------------------ */

/** What the check decided about one package. */
export type PackageUpdateState = 'uncheckable' | 'unknown' | 'current' | 'behind';

/** One package's update status, as the row shows it. */
export interface PackageUpdateStatus {
	readonly state: PackageUpdateState;
	/** The newer version npm knows, when the package is behind. */
	readonly latest?: string;
	/** Why the row says nothing actionable: said for `uncheckable` and `unknown`, never for the others. */
	readonly reason?: string;
}

/**
 * Whether one package is behind, from the version on disk and the one npm knows.
 *
 * The comparison is the host's own `compareVersions` — semver-shaped, never throwing. A
 * version that cannot be read (the manifest said nothing, npm could not be asked) is
 * `unknown`, said with its reason, never silently "current": the check reports only what it
 * can prove, and a row that is current says nothing at all.
 */
export function updateStatusFor(installed: string | undefined, latest: string | undefined, checkable: UpdateCheckableSource): PackageUpdateStatus {
	if (checkable.kind === 'uncheckable') {
		return { state: 'uncheckable', reason: checkable.reason };
	}
	if (installed === undefined || installed.trim().length === 0) {
		return { state: 'unknown', reason: 'Its installed version cannot be read' };
	}
	if (latest === undefined) {
		return { state: 'unknown', reason: 'npm could not be asked' };
	}
	// A version the comparator cannot order — `dev`, a git sha — is not a version answer: the
	// string fallback `compareVersions` keeps for determinism must never decide "current".
	if (!isComparableVersion(installed) || !isComparableVersion(latest)) {
		return { state: 'unknown', reason: 'Its version cannot be compared' };
	}
	if (compareVersions(installed, latest) < 0) {
		return { state: 'behind', latest };
	}
	return { state: 'current' };
}

/* ------------------------------------------------------------------ *
 * The check, cached
 * ------------------------------------------------------------------ */

/** What one row hands the check: where it lives, what it is called, what it declares. */
export interface PackageUpdateRowInput {
	/** The package's install directory — the key the page merges the answers back by. */
	readonly path: string;
	readonly name: string;
	/** The version the installed manifest carries, when it could be read. */
	readonly version?: string;
	/** The declaration as the settings file spells it (`npm:pi-lens`), when one exists. */
	readonly source?: string;
}

/** One row's status, keyed back to the row that asked. */
export interface PackageUpdateStatusRow extends PackageUpdateStatus {
	readonly path: string;
	readonly name: string;
}

/** How long one package's latest-version answer is served without asking npm again. */
export const UPDATE_CHECK_TTL_MS = 10 * 60_000;

/** What a check needs beside the rows; everything is optional and defaults to the real thing. */
export interface CheckDependencies {
	/** The network. Defaults to the runtime's own `fetch`. */
	readonly fetchFn?: FetchFn;
	/** The clock, for the cache's lifetime. Defaults to `Date.now`. */
	readonly now?: () => number;
	/** Where problems are said once; the check answers "unknown" for that package either way. */
	readonly log?: (line: string) => void;
	/** The latest-version cache; defaults to this module's own, so a test can pass a private one. */
	readonly cache?: Map<string, CacheEntry<string>>;
	/** The in-flight lookups; defaults to this module's own, so a test can pass a private one. */
	readonly flights?: Map<string, Promise<string | undefined>>;
}

/** The latest-version answers, per package name — so refreshing the page does not re-ask npm. */
const latestCache = new Map<string, CacheEntry<string>>();

/** The lookups already running, per package name — so overlapping checks share one request. */
const latestFlights = new Map<string, Promise<string | undefined>>();

/**
 * npm's latest for one package, served from the cache when it is fresh.
 *
 * A miss or a stale entry asks npm once (eight seconds, `fetchNpmLatest`), stores the answer,
 * and every overlapping ask joins the same flight. A failure is not cached: the next check
 * asks again, because "npm could not be asked" must not outlive the network trouble that
 * caused it.
 */
function npmLatestFor(name: string, deps: CheckDependencies, cache: Map<string, CacheEntry<string>>, flights: Map<string, Promise<string | undefined>>): Promise<string | undefined> {
	const now = deps.now ?? Date.now;
	const key = cacheKey('packages-latest', name);
	const cached = cachedModels(cache, key, UPDATE_CHECK_TTL_MS, now());
	if (cached.fresh && cached.value !== undefined) {
		return Promise.resolve(cached.value);
	}
	return singleFlight(flights, key, async () => {
		const joined = cachedModels(cache, key, UPDATE_CHECK_TTL_MS, now());
		if (joined.fresh && joined.value !== undefined) {
			return joined.value;
		}
		const latest = await fetchNpmLatest(name, { fetchFn: deps.fetchFn, log: deps.log });
		if (latest !== undefined) {
			storeModels(cache, key, latest, now());
		}
		return latest;
	});
}

/**
 * The update status of every row, answered **in parallel**.
 *
 * A row that cannot be checked answers `uncheckable` with its reason and costs no request;
 * a checkable one costs at most one registry call, cached for {@link UPDATE_CHECK_TTL_MS}.
 * The answers come back in the rows' order, keyed by `path`, ready to be merged into the page's
 * rows — and the page calls this after it has already rendered, so the check never holds the
 * list open.
 */
export async function checkPackageUpdates(rows: readonly PackageUpdateRowInput[], deps: CheckDependencies = {}): Promise<readonly PackageUpdateStatusRow[]> {
	const cache = deps.cache ?? latestCache;
	const flights = deps.flights ?? latestFlights;
	return Promise.all(rows.map(async row => {
		const checkable = updateCheckableSource(row.source);
		if (checkable.kind === 'uncheckable') {
			return { path: row.path, name: row.name, state: 'uncheckable' as const, reason: checkable.reason };
		}
		const latest = await npmLatestFor(checkable.name, deps, cache, flights);
		return { path: row.path, name: row.name, ...updateStatusFor(row.version, latest, checkable) };
	}));
}

/* ------------------------------------------------------------------ *
 * The update run
 * ------------------------------------------------------------------ */

/** One process run: whether it exited cleanly, and what npm said on its error stream. */
export interface SpawnOutcome {
	readonly ok: boolean;
	readonly stderr: string;
}

/** The options a spawn gets; the real one hands them to `execFile`. */
export interface SpawnOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly windowsHide: boolean;
	readonly timeoutMs: number;
	/** Run through the shell, which is how the npm shim fallback runs (`npm.cmd`). */
	readonly shell?: boolean;
}

/** The process run, injectable so a test can observe what would have been executed. */
export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => Promise<SpawnOutcome>;

/**
 * The real spawn: `execFile`, hidden, no visible console — the same runner
 * `packages-install.ts` uses, with the shell flag coming from the run's plan.
 */
const defaultSpawn: SpawnFn = (file, args, options) => new Promise(resolve => {
	execFile(file, [...args], {
		cwd: options.cwd,
		env: options.env,
		windowsHide: options.windowsHide,
		timeout: options.timeoutMs,
		shell: options.shell === true,
	}, (error, _stdout, stderr) => {
		resolve({
			ok: error === null,
			stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : (error?.message ?? ''),
		});
	});
});

/** How long one package's update may run before it is cut — the installer's leash. */
export const PACKAGE_UPDATE_TIMEOUT_MS = 180_000;

/** What an update needs beside the source, resolved by the caller (`extension.ts`). */
export interface PackageUpdateContext {
	/** The npm project the package is installed in — pi's install root, `<profile>/npm`. */
	readonly npmProject: string;
	/** npm's CLI script; `undefined` plans the npm shim through a quoted shell. */
	readonly npmCli?: string;
	readonly spawn?: SpawnFn;
	readonly timeoutMs?: number;
}

/**
 * The npm arguments one update runs: the same shape pi's own installer and
 * `packages-install.ts` use — `install` over the npm project, the spec as one argument.
 * `@latest` is what the row promised: the version npm's registry names as newest.
 */
export function packageUpdateArgs(name: string): string[] {
	return ['install', '--save', '--no-audit', '--no-fund', `${name}@latest`];
}

/** The stderr line the failure message carries, or nothing when npm said nothing usable. */
function lastMeaningfulLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
	const last = lines.at(-1);
	if (last === undefined) {
		return undefined;
	}
	return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/**
 * One update of one package, run now, on the profile in force.
 *
 * The run is planned by `npm-run.ts` — node over npm's own CLI script, a real arguments
 * array, **no shell** — so the npm project's path arrives as one argument even when it
 * carries a space, the same guarantee every other npm path here runs on. Before anything is
 * spawned, the refusals are said: a package with no checkable declaration, one pinned in the
 * settings (the pin would reinstall itself over the update on pi's next load), and a name
 * that does not fit {@link isSafeNpmInstallSpec} — the whitelist stays in front of whatever
 * reaches a shell, as it does for every install.
 */
export async function updatePackage(source: string, context: PackageUpdateContext): Promise<InstallResult> {
	const checkable = updateCheckableSource(source);
	if (checkable.kind === 'uncheckable') {
		return { ok: false, message: `Package ${source} cannot be updated here (${checkable.reason.toLowerCase()}).` };
	}
	if (checkable.pin !== undefined) {
		return { ok: false, message: `Package ${checkable.name} is pinned to ${checkable.pin} in the settings; change the pin to update it.` };
	}
	if (!isSafeNpmInstallSpec(`${checkable.name}@latest`)) {
		return { ok: false, message: `Package ${checkable.name} cannot be updated: its name does not fit the spelling this editor installs.` };
	}
	const plan = planNpmRun(packageUpdateArgs(checkable.name), { npmCli: context.npmCli });
	const spawn = context.spawn ?? defaultSpawn;
	try {
		const outcome = await spawn(plan.file, plan.args, {
			cwd: context.npmProject,
			env: npmRunEnv(plan, { ...process.env }),
			windowsHide: true,
			timeoutMs: context.timeoutMs ?? PACKAGE_UPDATE_TIMEOUT_MS,
			shell: plan.shell,
		});
		if (!outcome.ok) {
			const reason = lastMeaningfulLine(outcome.stderr);
			return { ok: false, message: `Package ${checkable.name} could not be updated${reason === undefined ? '.' : `: ${reason}`}` };
		}
		return { ok: true, message: `Package ${checkable.name} updated to the latest version.` };
	} catch (error) {
		return { ok: false, message: `Package ${checkable.name} could not be updated (${error instanceof Error ? error.message : String(error)}).` };
	}
}
