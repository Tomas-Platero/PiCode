/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The rules of PiCode's update check: which of the installed things an npm registry says are
 * behind, what the check stores so its answer survives a restart, what the notification says,
 * and how `pi update` is run.
 *
 * ## Why this module has no `vscode` import
 *
 * The same split `packages-registry.ts` makes: everything here is a rule about versions and
 * time, not about the editor. The network arrives through an injectable `fetchFn` and the
 * process spawn through an injectable `spawn`, so the rules can be exercised by running them
 * — the ordering, the assembly, the snapshot and the argv pi receives — without an editor,
 * a network or a process in the way. `extension.ts` resolves the editor-only parts (which
 * runtime is in force, the profile, the bundled pi CLI, the notification surfaces) and hands
 * them in.
 */

import { execFile } from 'node:child_process';

/* ------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------ */

/** One version, once parsed into the parts the comparator reads. */
interface ParsedVersion {
	/** The numeric core, `x.y.z` as numbers. */
	readonly core: readonly number[];
	/** The prerelease identifiers, when the version carries one; a release has none. Numeric identifiers are kept as numbers, so they order numerically. */
	readonly pre?: readonly (string | number)[];
}

/**
 * One version, parsed — or `undefined` when it says nothing this comparator understands.
 *
 * The `v` some tools write and any build metadata (`+…`) are dropped; the rest must be a
 * dotted run of integers, optionally followed by a `-` prerelease. Anything else — `dev`,
 * a git sha, an empty string — is junk: the caller treats it as incomparable rather than
 * guessing where it sits.
 */
function parseVersion(value: string): ParsedVersion | undefined {
	const trimmed = value.trim().replace(/^[vV]/, '').replace(/\+.*$/, '');
	const dash = trimmed.indexOf('-');
	const coreText = dash === -1 ? trimmed : trimmed.slice(0, dash);
	const core = coreText.split('.').map(Number);
	if (core.length === 0 || core.some(part => !Number.isInteger(part) || part < 0)) {
		return undefined;
	}
	if (dash === -1) {
		return { core };
	}
	const preText = trimmed.slice(dash + 1).split('.');
	if (preText.some(part => part.length === 0)) {
		return undefined;
	}
	// A numeric identifier is kept as its number, so `2` orders before `10` — semver's rule,
	// which a string comparison would get backwards.
	const pre = preText.map(part => /^\d+$/.test(part) ? Number(part) : part);
	return { core, pre };
}

/** The plain order two runs of identifiers have, pairwise numeric, prefix-shorter first. */
function compareIdentifiers(a: readonly (string | number)[], b: readonly (string | number)[]): number {
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const left = a[index];
		const right = b[index];
		if (left === right) {
			continue;
		}
		if (left === undefined) {
			return -1;
		}
		if (right === undefined) {
			return 1;
		}
		// A numeric identifier exists only when both sides carry one at this spot; one number
		// and one word order by semver's rule: the number is the lower one.
		if (typeof left === 'number' && typeof right === 'number') {
			return left - right;
		}
		if (typeof left === 'number') {
			return -1;
		}
		if (typeof right === 'number') {
			return 1;
		}
		return left < right ? -1 : 1;
	}
	return 0;
}

/**
 * How two versions order: negative when `a` is older, positive when newer, zero when equal.
 *
 * The comparison is semver-shaped — numbers compare as numbers, a release is newer than any
 * of its own prereleases, prerelease identifiers order as semver spells — and it never throws:
 * a version this module cannot parse falls back to plain string order, so the answer stays
 * deterministic for whatever a manifest or a registry happens to say.
 */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (left === undefined || right === undefined) {
		const normalizedA = a.trim();
		const normalizedB = b.trim();
		if (normalizedA === normalizedB) {
			return 0;
		}
		return normalizedA < normalizedB ? -1 : 1;
	}
	const core = compareIdentifiers(left.core, right.core);
	if (core !== 0) {
		return core;
	}
	// A release has no prerelease part, which is exactly "higher than any prerelease".
	if (left.pre === undefined && right.pre === undefined) {
		return 0;
	}
	if (left.pre === undefined) {
		return 1;
	}
	if (right.pre === undefined) {
		return -1;
	}
	return compareIdentifiers(left.pre, right.pre);
}

/* ------------------------------------------------------------------ *
 * What can be updated
 * ------------------------------------------------------------------ */

/** The kinds of thing the check watches: the pi runtime, Gentle AI, and pi's npm packages. */
export type UpdateKind = 'runtime' | 'gentle' | 'package';

/** One candidate the check compared, as the caller gathered it — versions may be missing. */
export interface CandidateTarget {
	readonly kind: UpdateKind;
	/** What the notification and the sentence call it: `pi`, `gentle-pi`, the package's name. */
	readonly name: string;
	readonly installed?: string;
	readonly latest?: string;
}

/** One thing that is behind, with both versions spelled. */
export interface UpdateTarget {
	readonly kind: UpdateKind;
	readonly name: string;
	readonly installed: string;
	readonly latest: string;
}

/**
 * The candidates that are actually behind.
 *
 * A candidate needs **both** versions to speak for it: a missing one (a runtime whose manifest
 * could not be read, a package installed from git with no version to compare) and a junk one
 * (a local build marked `dev`) are tolerated by being left out — the check reports only what it
 * can prove, and a downgrade is not an update. The input's order is kept, so the notification
 * reads the runtime first and the packages last.
 */
export function updatableTargets(candidates: readonly CandidateTarget[]): readonly UpdateTarget[] {
	const targets: UpdateTarget[] = [];
	for (const candidate of candidates) {
		const { kind, name, installed, latest } = candidate;
		if (installed === undefined || latest === undefined) {
			continue;
		}
		if (parseVersion(installed) === undefined || parseVersion(latest) === undefined) {
			continue;
		}
		if (compareVersions(installed, latest) < 0) {
			targets.push({ kind, name, installed, latest });
		}
	}
	return targets;
}

/**
 * The one sentence the notification carries after `PiCode: updates available — `.
 *
 * The runtime and Gentle are named with their versions (`pi 0.87.1 → 0.88.0`); the packages
 * are counted and named (`2 packages (pi-pretty, pi-lint)`), because a profile can hold many
 * and the count is what the sentence needs to stay readable.
 */
export function describeTargets(targets: readonly UpdateTarget[]): string {
	const parts: string[] = [];
	const packages = targets.filter(target => target.kind === 'package');
	for (const target of targets) {
		if (target.kind !== 'package') {
			parts.push(`${target.name} ${target.installed} → ${target.latest}`);
		}
	}
	if (packages.length === 1) {
		const [only] = packages;
		parts.push(`1 package (${only.name} ${only.installed} → ${only.latest})`);
	} else if (packages.length > 1) {
		parts.push(`${packages.length} packages (${packages.map(target => target.name).join(', ')})`);
	}
	return parts.join(', ');
}

/* ------------------------------------------------------------------ *
 * The snapshot globalState carries across restarts
 * ------------------------------------------------------------------ */

/** What the editor stores after one check: when it ran, and what it found. */
export interface UpdatesSnapshot {
	readonly checkedAt: number;
	readonly targets: readonly UpdateTarget[];
}

/** The kinds that may appear in a stored target, as a set the reader checks against. */
const SNAPSHOT_KINDS: readonly UpdateKind[] = ['runtime', 'gentle', 'package'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The stored value as a snapshot, or `undefined` when it says nothing this module understands.
 *
 * Everything globalState hands back is untrusted — an old build wrote it, a hand edited it —
 * so every field is checked before it is believed, and anything else reads as "no snapshot":
 * the next check will rebuild the truth anyway.
 */
export function parseSnapshot(value: unknown): UpdatesSnapshot | undefined {
	if (!isRecord(value) || typeof value['checkedAt'] !== 'number' || !Array.isArray(value['targets'])) {
		return undefined;
	}
	const targets: UpdateTarget[] = [];
	for (const raw of value['targets']) {
		if (!isRecord(raw)) {
			return undefined;
		}
		const { kind, name, installed, latest } = raw as Record<string, unknown>;
		if (!SNAPSHOT_KINDS.includes(kind as UpdateKind) || typeof name !== 'string' || typeof installed !== 'string' || typeof latest !== 'string') {
			return undefined;
		}
		targets.push({ kind: kind as UpdateKind, name, installed, latest });
	}
	return { checkedAt: value['checkedAt'], targets };
}

/* ------------------------------------------------------------------ *
 * The npm latest lookup
 * ------------------------------------------------------------------ */

/** The one fetch the lookup needs, as narrow as it can be — the shape `packages-registry.ts` uses. */
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

/** npm's registry; the `/latest` endpoint answers one package's newest version. */
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/';

/** The URL one package's latest lookup asks, scoped names encoded the way npm reads them. */
export function npmLatestUrl(name: string): string {
	return `${REGISTRY_LATEST_URL}${encodeURIComponent(name)}/latest`;
}

/** A lookup that never answers must not hold the check open: the request is cut at eight seconds. */
const LATEST_TIMEOUT_MS = 8_000;

/** What a lookup needs beside the name; everything is optional and defaults to the real thing. */
export interface LatestDependencies {
	/** The network. Defaults to the runtime's own `fetch`. */
	readonly fetchFn?: FetchFn;
	/** Where problems are said once; the check answers "no update" for that package either way. */
	readonly log?: (line: string) => void;
}

/**
 * The newest version npm knows for one package, or `undefined` when npm says nothing usable.
 *
 * Every failure — a network error, a non-OK status, a body without a version string — is
 * `undefined`, said out loud once through `log`, and never an update claim: a package the
 * registry could not be asked about is one the check stays silent on.
 */
export async function fetchNpmLatest(name: string, deps: LatestDependencies = {}): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), LATEST_TIMEOUT_MS);
	try {
		const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
		const response = await fetchFn(npmLatestUrl(name), { signal: controller.signal });
		if (!response.ok) {
			deps.log?.(`updates: npm answered ${response.status} for ${name}`);
			return undefined;
		}
		const payload: unknown = await response.json();
		const version = isRecord(payload) ? payload['version'] : undefined;
		if (typeof version !== 'string' || version.length === 0) {
			deps.log?.(`updates: npm's answer for ${name} carries no version`);
			return undefined;
		}
		return version;
	} catch (error) {
		deps.log?.(`updates: the lookup for ${name} failed (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/* ------------------------------------------------------------------ *
 * The update run
 * ------------------------------------------------------------------ */

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

/** What an update run needs beside the target, resolved by the caller (`extension.ts`). */
export interface UpdateRunContext {
	/** The pi CLI's entry, already checked for existence by the caller. */
	readonly cliEntry: string;
	/** The profile in force — handed to pi as `PI_CODING_AGENT_DIR`. */
	readonly profileDir: string;
	/** The process run. Defaults to `execFile` with an args array. */
	readonly spawn?: SpawnFn;
}

/** How long `pi update --all` may run — the runtime and every package, so a generous leash. */
export const UPDATE_TIMEOUT_MS = 300_000;

/** The stderr line the failure message carries, or nothing when pi said nothing usable. */
function lastMeaningfulLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
	const last = lines.at(-1);
	if (last === undefined) {
		return undefined;
	}
	return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/**
 * One update of everything pi owns, run now.
 *
 * `pi update --all` is the whole flow in one command: it covers pi itself and the packages in
 * the profile handed to it, whichever runtime is in force — the external pi updates its own
 * installation the same way. The spawn is awaited with a five-minute leash and both outcomes
 * end in one sentence the notification can show as-is: the failure carrying the last meaningful
 * line of pi's stderr, which is where npm puts the reason.
 */
export async function runPiUpdate(context: UpdateRunContext): Promise<{ ok: boolean; message: string }> {
	const run = async (spawn: SpawnFn): Promise<{ ok: boolean; message: string }> => {
		const outcome = await spawn(process.execPath, [context.cliEntry, 'update', '--all'], {
			// The editor's executable is Electron: without this flag it would try to open an app
			// instead of running pi's script as Node — the same invocation the installer uses.
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: context.profileDir },
			windowsHide: true,
			timeoutMs: UPDATE_TIMEOUT_MS,
		});
		if (!outcome.ok) {
			const reason = lastMeaningfulLine(outcome.stderr);
			return { ok: false, message: `PiCode could not be updated${reason === undefined ? '.' : `: ${reason}`}` };
		}
		return { ok: true, message: 'PiCode updated.' };
	};
	const spawn: SpawnFn = context.spawn ?? defaultSpawn;
	try {
		return await run(spawn);
	} catch (error) {
		return { ok: false, message: `PiCode could not be updated (${error instanceof Error ? error.message : String(error)}).` };
	}
}

/** The real spawn: `execFile` with an **args array only**, so nothing pi is handed is a shell string. */
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
