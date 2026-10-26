/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's own package installer: what the profile declares and the disk lacks, installed
 * here, in **one** hidden run, before anything loads pi.
 *
 * ## Why this module exists — the mechanism it closes off
 *
 * pi's own loader installs packages that are declared but missing: `package-manager.js`'s
 * `resolve()` → `resolvePackageSources()` walks the declarations one by one and, for each one
 * whose install directory is absent, calls `installMissing()` → `installParsedSource()` →
 * `installNpm()` — **one npm process per package** (`installNpm` passes a single spec). The
 * spawn goes through `spawnProcess` (pi's `utils/child-process.js`), which on Windows uses
 * `cross-spawn` to reach `npm.cmd` through a shell, and pi sets neither `windowsHide` nor a
 * console-free stdio for it — so every missing package flashed a console window, per package,
 * per load. This module removes the trigger: by the time any pi session is built, the tree is
 * whole, and the loader's `needsInstall` check finds every declared package installed.
 *
 * ## The rules
 *
 * - **One process for N packages.** npm takes the whole list in a single command — the same
 *   path the import uses (`onboarding.ts`'s `runNpm` shape: `install --save --no-audit
 *   --no-fund <specs>`, cwd `<profile>/npm`, hidden). A failed batch is retried spec by spec,
 *   still hidden, because npm is all or nothing and one bad package must not take the list.
 * - **Nothing profile-derived reaches the shell unchecked.** npm runs planned by
 *   `npm-run.ts` (node over npm's own CLI script, no shell) carry the specs as one argument
 *   each; the shim fallback still goes through a shell, so every spec passes
 *   {@link isSafeNpmInstallSpec} first — belt and braces. A refusal is a named line, not a
 *   passed-through argument. The one git source kind a profile can declare is cloned with
 *   `git` directly — an executable `execFile` can run without a shell — one clone per
 *   repository, hidden.
 * - **Honest state.** The outcome carries how many packages were installed, how many were
 *   already present, how many failed, and which declarations were refused; `lines` holds the
 *   sentences for the caller's log or notification.
 *
 * There is deliberately **no `vscode` import**: the spawn and the filesystem are injectable,
 * so the rules run under `node --test` — the one-process guarantee included.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isSafeNpmInstallSpec, npmInstallSpec } from './packages-registry';
import { npmRunEnv, planNpmRun } from './npm-run';
import { withProductEnv } from './product-env';
import { isLeftBehindPackage } from './left-behind-packages';
import { PRODUCT_PACKAGES, withProductPackages, type ProductPackage } from './product-packages';
import { parsePackageSource, parseSettings, type SettingsDocument } from './packages-data';

/** The whitelist this module enforces before any profile-derived spec reaches npm's shell. */
export { isSafeNpmInstallSpec } from './packages-registry';

/* ------------------------------------------------------------------ *
 * The scan: what the settings declare against what the disk holds
 * ------------------------------------------------------------------ */

/** One git checkout the profile needs and the disk lacks. */
export interface GitCloneRequest {
	/** The clone URL — always `https://`, built from pi's `git:host/path` spelling. */
	readonly url: string;
	/** Where pi expects the checkout: `<profile>/git/<host>/<path>`. */
	readonly target: string;
}

/** What one scan of the profile produced. */
export interface PackageScan {
	/** npm specs to install, whole missing set, already whitelist-checked. */
	readonly specs: readonly string[];
	/** Git sources to clone, already whitelist-checked. */
	readonly gitClones: readonly GitCloneRequest[];
	/** Declarations already whole on disk. */
	readonly present: number;
	/** Declarations nothing here can or may install (left-behind, local paths). */
	readonly skipped: number;
	/** Declarations refused **before** any process ran, one sentence each. */
	readonly rejected: readonly string[];
	/** Refusals plus declarations that could not be parsed at all. */
	readonly failedBeforeSpawn: number;
}

/** The filesystem facts a scan reads, injectable so the rules run without a disk. */
export interface PackageScanIo {
	/** Whether the directory exists — pi's install directory for the declaration. */
	readonly directoryExists: (dir: string) => boolean;
	/** The installed package's version from its manifest, or `undefined`. */
	readonly manifestVersion: (dir: string) => string | undefined;
	/** The entries of a directory, or none. Absent means this fixture holds no tree to walk. */
	readonly listDirectory?: (dir: string) => readonly string[];
}

/**
 * The exact version a pinned spec carries, or `undefined` when the spec is not an exact pin.
 *
 * A range (`^1.0.0`, `>=1.0.0`) or a dist-tag (`next`) is not a pin: an existing install
 * satisfies it as far as this check is concerned, and pi's own `satisfies` test decides.
 */
function exactPin(spec: string): string | undefined {
	const at = spec.lastIndexOf('@');
	const version = at > 0 ? spec.slice(at + 1) : undefined;
	return version !== undefined && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}

/**
 * What the profile's `packages` declarations need, as install work.
 *
 * The walk mirrors pi's own resolution (`package-manager.js`): an npm declaration installs to
 * `<npmRoot>/<name>`, a git one checks out to `<gitRoot>/<host>/<path>`, a local one is
 * resolved in place. A declaration that is already installed is `present` — except an exact
 * pin whose installed version differs, which is reinstalled here so pi never does it with its
 * own window. Left-behind packages are never installed, and an unsafe spec is
 * refused with a line rather than passed to npm's shell.
 */
export function scanDeclaredPackages(
	settings: SettingsDocument | undefined,
	npmRoot: string,
	gitRoot: string,
	io: PackageScanIo,
): PackageScan {
	const declared = Array.isArray(settings?.['packages']) ? settings!['packages'] as readonly unknown[] : [];
	const specs: string[] = [];
	const gitClones: GitCloneRequest[] = [];
	const rejected: string[] = [];
	let present = 0;
	let skipped = 0;
	let failedBeforeSpawn = 0;

	for (const entry of declared) {
		if (isLeftBehindPackage(entry)) {
			skipped += 1;
			continue;
		}
		const source = parsePackageSource(entry);
		if (source === undefined) {
			skipped += 1;
			continue;
		}
		if (source.kind === 'local') {
			// pi resolves local declarations in place and skips the missing ones without
			// spawning anything — nothing here can install them, and nothing has to. A relative
			// path resolves against the profile, the scope these settings belong to.
			const baseDir = path.dirname(path.dirname(npmRoot)); // `<profile>/npm/node_modules` → `<profile>`
			if (!io.directoryExists(path.isAbsolute(source.path) ? source.path : path.join(baseDir, source.path))) {
				skipped += 1;
			} else {
				present += 1;
			}
			continue;
		}
		if (source.kind === 'npm') {
			const installDir = path.join(npmRoot, source.name);
			if (io.directoryExists(installDir)) {
				const pin = exactPin(source.spec);
				if (pin === undefined || io.manifestVersion(installDir) === pin) {
					present += 1;
					continue;
				}
			}
			const spec = npmInstallSpec(`npm:${source.spec}`);
			if (spec === undefined || !isSafeNpmInstallSpec(spec)) {
				failedBeforeSpawn += 1;
				rejected.push(`Refused ${source.spec}: it does not fit the spelling this editor installs through npm's shell.`);
				continue;
			}
			specs.push(spec);
			continue;
		}
		// git: pi expects the checkout at `<gitRoot>/<host>/<path>`, so a missing one is cloned
		// there — installing its URL through npm would fill `node_modules` and still leave the
		// checkout absent, and pi would clone it itself, with its own window.
		const target = path.join(gitRoot, source.host, source.path);
		if (io.directoryExists(target)) {
			present += 1;
			continue;
		}
		const url = `https://${source.host}/${source.path}`;
		if (!isSafeNpmInstallSpec(`git+https://${source.host}/${source.path}`)) {
			failedBeforeSpawn += 1;
			rejected.push(`Refused ${source.spec}: the repository address does not fit the spelling this editor clones.`);
			continue;
		}
		gitClones.push({ url, target });
	}

	return { specs, gitClones, present, skipped, rejected, failedBeforeSpawn };
}

/* ------------------------------------------------------------------ *
 * The install: one hidden run for the whole missing set
 * ------------------------------------------------------------------ */

/** One process run: whether it exited cleanly, and what it said on its error stream. */
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

/** The process run, injectable so a test can count exactly what would have been executed. */
export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => Promise<SpawnOutcome>;

/**
 * The real spawn: `execFile`, hidden, no visible console, for every process this module runs.
 *
 * The shell flag comes from the run's plan (`npm-run.ts`): npm runs planned over npm's CLI
 * script spawn **no shell**, so no argument — flag, spec, or a path the caller did not spell —
 * can be split on its spaces. The shim fallback still shells (`npm.cmd`), which is why the
 * specs keep passing the whitelist before this line. `git` is an executable `execFile` runs
 * directly, no shell, on every platform.
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

/** How long the whole batch may take before it is cut. */
const BATCH_TIMEOUT_MS = 600_000;

/** How long one retry or one git clone may take. */
const ONE_TIMEOUT_MS = 180_000;

/** What one ensure run answered — the honest state of the profile's packages. */
export interface PackagesInstallOutcome {
	readonly installed: number;
	readonly cloned: number;
	readonly present: number;
	readonly failed: number;
	readonly rejected: readonly string[];
	/** The sentences for the caller's log or notification, in order. */
	readonly lines: readonly string[];
}

/** The filesystem a run reads, injectable so a test needs no disk. */
export interface PackagesFileIo extends PackageScanIo {
	/** The profile's `settings.json` text, or `undefined` when there is none. */
	readonly readSettingsText: (file: string) => string | undefined;
	/** Writes a file, creating the directory it lives in. Absent in a fixture with no disk. */
	readonly writeText?: (file: string, text: string) => void;
}

/* ------------------------------------------------------------------ *
 * The runtime's family: the profile has to carry the same version
 * ------------------------------------------------------------------ */

/**
 * One package of the family PiCode's pi is made of, at the exact version in force.
 *
 * The profile needs a copy of this family for a reason that is npm's, not pi's: a dozen
 * ecosystem packages declare it as a **non-optional** peer, and npm installs a peer it must
 * satisfy — from the profile's own tree, which is nowhere near `resources/pi-runtime`. That
 * copy is not the one extensions load (pi's extension loader aliases every
 * `@earendil-works/*` specifier to the pi doing the loading, so what runs is always the
 * runtime's), but it *is* the one npm keeps, and left alone it is whatever the newest
 * published version happens to be. When that version moves ahead of the runtime, a package
 * compiled against it asks the older one for an export it never had, and the profile breaks
 * on a bump nobody asked for. Pinning the family to the runtime is what makes the two agree.
 */
export interface RuntimeFamilyPin {
	readonly name: string;
	readonly version: string;
}

/** The scope every package of the family lives under. */
const RUNTIME_FAMILY_SCOPE = '@earendil-works';

/** A version that means one thing only: `1.2.3`. A prerelease or a range is not a pin. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The family the runtime actually carries, read off the runtime on disk.
 *
 * Deliberately **derived, never listed**: the set of packages and their versions are both
 * facts of the installed runtime, so a bump of the build pin moves this list with it and no
 * second place has to be remembered. A runtime that is absent (a dev tree that never ran the
 * build's runtime step) answers nothing, and the run does no family work at all.
 */
export function runtimeFamilyPins(runtimeRoot: string, io: PackageScanIo): readonly RuntimeFamilyPin[] {
	const scopeDir = path.join(runtimeRoot, 'node_modules', RUNTIME_FAMILY_SCOPE);
	const entries = io.listDirectory?.(scopeDir) ?? [];
	const pins: RuntimeFamilyPin[] = [];
	for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
		const version = io.manifestVersion(path.join(scopeDir, entry));
		if (version === undefined || !EXACT_VERSION.test(version)) {
			continue;
		}
		pins.push({ name: `${RUNTIME_FAMILY_SCOPE}/${entry}`, version });
	}
	return pins;
}

/**
 * Writes the family's exact versions into the profile's npm manifest, when they are not there.
 *
 * The manifest is the profile's own `npm/package.json` — the file npm keeps as the record of
 * what this tree holds. Declaring the family there is the half of this that survives: an
 * install the owner runs by hand, or pi's own for a new declaration, then finds the family
 * already pinned and has no reason to hoist a newer one over it. Nothing else in the file is
 * touched, and a profile that already declares the same versions is not rewritten at all.
 *
 * @returns whether the file changed.
 */
function declareFamilyInManifest(
	npmProject: string,
	declared: Readonly<Record<string, string>>,
	io: PackagesFileIo,
): boolean {
	const names = Object.keys(declared);
	if (names.length === 0 || io.writeText === undefined) {
		return false;
	}
	const file = path.join(npmProject, 'package.json');
	let manifest: Record<string, unknown> = { private: true };
	const text = io.readSettingsText(file);
	if (text !== undefined) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				manifest = parsed as Record<string, unknown>;
			}
		} catch {
			// A manifest that cannot be read is not worth guessing at: npm rewrites it on the next
			// install anyway, so the family is left to that run instead of being written over a file
			// whose other contents this module cannot preserve.
			return false;
		}
	}
	const current = typeof manifest['dependencies'] === 'object' && manifest['dependencies'] !== null && !Array.isArray(manifest['dependencies'])
		? manifest['dependencies'] as Record<string, unknown>
		: {};
	const settled = names.every(name => current[name] === declared[name]);
	if (settled) {
		return false;
	}
	manifest['dependencies'] = { ...current, ...declared };
	io.writeText(file, `${JSON.stringify(manifest, null, '\t')}\n`);
	return true;
}

/** What the family needs in the profile: the versions to declare, and the specs to install. */
export interface RuntimeFamilyWork {
	/** Every family package, with the exact version the profile's manifest should declare. */
	readonly declared: Readonly<Record<string, string>>;
	/** The exact specs the profile is missing or holds at another version. */
	readonly specs: readonly string[];
}

/**
 * The family, as the profile's own `node_modules` holds it against the runtime's versions.
 *
 * The declared map is the whole family every time, because declaring it is what keeps npm
 * from drifting later; only a version that differs becomes install work.
 */
export function scanRuntimeFamily(
	npmRoot: string,
	pins: readonly RuntimeFamilyPin[],
	io: PackageScanIo,
): RuntimeFamilyWork {
	const declared: Record<string, string> = {};
	const specs: string[] = [];
	for (const pin of pins) {
		declared[pin.name] = pin.version;
		const installed = io.directoryExists(path.join(npmRoot, pin.name)) ? io.manifestVersion(path.join(npmRoot, pin.name)) : undefined;
		if (installed !== pin.version) {
			specs.push(`${pin.name}@${pin.version}`);
		}
	}
	return { declared, specs };
}

/** What a run needs: the profile, and everything else is optional and defaults to the real thing. */
export interface EnsureProfilePackagesOptions {
	/** PiCode's own profile — the only profile this module ever writes to. */
	readonly profileDir: string;
	/** npm's CLI script; `undefined` plans the npm shim through a quoted shell. */
	readonly npmCli?: string;
	/**
	 * The runtime in force (`resources/pi-runtime`). Its family versions are the ones the profile
	 * is kept on; without it the run installs declarations only, as it always did.
	 */
	readonly runtimeRoot?: string;
	readonly spawn?: SpawnFn;
	readonly io?: PackagesFileIo;
	/** Where the sentences go; the caller decides whether that is a log or a notification. */
	readonly log?: (line: string) => void;
	/** The packages the product pins in the profile; the product's own list unless a test says otherwise. */
	readonly productPackages?: readonly ProductPackage[];
}

/** The real filesystem. */
const realIo: PackagesFileIo = {
	directoryExists: dir => {
		try {
			return existsSync(dir);
		} catch {
			return false;
		}
	},
	manifestVersion: dir => {
		try {
			const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
			const version = typeof manifest === 'object' && manifest !== null
				? (manifest as { version?: unknown })['version']
				: undefined;
			return typeof version === 'string' ? version : undefined;
		} catch {
			return undefined;
		}
	},
	readSettingsText: file => {
		try {
			return readFileSync(file, 'utf8');
		} catch {
			return undefined;
		}
	},
	writeText: (file, text) => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	},
	listDirectory: dir => {
		try {
			return readdirSync(dir);
		} catch {
			return [];
		}
	},
};

/** The last meaningful line of a process's error stream, or a short fallback. */
function reasonOf(stderr: string): string {
	const line = stderr.split(/\r?\n/).map(part => part.trim()).filter(part => part.length > 0).pop();
	if (line === undefined) {
		return 'npm gave no reason';
	}
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The run behind {@link ensureProfilePackages}, one at a time per profile.
 *
 * Every rejection and failure is a sentence; a complete profile produces no lines and spawns
 * nothing. The batch is one process for the whole spec list; only a failed batch is retried
 * one spec at a time, so a single unresolvable package does not take the rest with it.
 */
async function runEnsure(options: EnsureProfilePackagesOptions): Promise<PackagesInstallOutcome> {
	const io = options.io ?? realIo;
	const spawn = options.spawn ?? defaultSpawn;
	const profileDir = options.profileDir;
	const npmProject = path.join(profileDir, 'npm');
	const npmRoot = path.join(npmProject, 'node_modules');
	const gitRoot = path.join(profileDir, 'git');
	const settingsFile = path.join(profileDir, 'settings.json');
	const lines: string[] = [];
	const log = (line: string): void => {
		lines.push(line);
		options.log?.(line);
	};
	// The product's packages are declared at the versions it pins before anything is scanned, so
	// the scan below installs them like any other declaration.
	let settingsText = io.readSettingsText(settingsFile);
	const pinned = withProductPackages(settingsText, options.productPackages ?? PRODUCT_PACKAGES);
	if (pinned.changed && pinned.text !== undefined) {
		try {
			(io.writeText ?? realIo.writeText)!(settingsFile, pinned.text);
			settingsText = pinned.text;
			log('This profile now declares the packages PiCode ships, at the versions it ships them.');
		} catch (error) {
			log(`The packages PiCode ships could not be declared in this profile (${error instanceof Error ? error.message : String(error)}).`);
		}
	}
	const settings = parseSettings(settingsText);
	const scan = scanDeclaredPackages(settings, npmRoot, gitRoot, io);
	let installed = 0;
	let cloned = 0;
	let failed = scan.failedBeforeSpawn;
	const env = withProductEnv({ ...process.env, PI_CODING_AGENT_DIR: profileDir });

	for (const sentence of scan.rejected) {
		log(sentence);
	}

	if (scan.specs.length > 0) {
		// The npm project may not exist yet — a fresh profile has no `npm/` directory until the
		// first install — and npm refuses a working directory that is not there. The same
		// bootstrap the import's `runNpm` does.
		try {
			mkdirSync(npmProject, { recursive: true });
			const manifest = path.join(npmProject, 'package.json');
			if (!existsSync(manifest)) {
				writeFileSync(manifest, '{\n\t"private": true\n}\n');
			}
		} catch (error) {
			failed += scan.specs.length;
			log(`The profile's npm directory could not be prepared (${error instanceof Error ? error.message : String(error)}), so ${scan.specs.length} package(s) were not installed.`);
		}
		if (failed === scan.failedBeforeSpawn) {
			log(`Installing ${scan.specs.length} missing package${scan.specs.length === 1 ? '' : 's'} for this profile…`);
			const runArgs = (specs: readonly string[]): string[] => ['install', '--save', '--no-audit', '--no-fund', ...specs];
			const npmPlan = planNpmRun(runArgs(scan.specs), { npmCli: options.npmCli });
			try {
				// One process for the whole list — never one per package.
				const outcome = await spawn(npmPlan.file, npmPlan.args, {
					cwd: npmProject,
					env: npmRunEnv(npmPlan, env),
					windowsHide: true,
					timeoutMs: BATCH_TIMEOUT_MS,
					shell: npmPlan.shell,
				});
				if (outcome.ok) {
					installed = scan.specs.length;
				} else {
					throw new Error(reasonOf(outcome.stderr));
				}
			} catch (batchError) {
				// npm is all or nothing: only a failed batch is retried one spec at a time.
				for (const spec of scan.specs) {
					const onePlan = planNpmRun(runArgs([spec]), { npmCli: options.npmCli });
					try {
						const outcome = await spawn(onePlan.file, onePlan.args, {
							cwd: npmProject,
							env: npmRunEnv(onePlan, env),
							windowsHide: true,
							timeoutMs: ONE_TIMEOUT_MS,
							shell: onePlan.shell,
						});
						if (outcome.ok) {
							installed += 1;
						} else {
							throw new Error(reasonOf(outcome.stderr));
						}
					} catch {
						failed += 1;
						log(`Package ${spec} could not be installed (${batchError instanceof Error ? batchError.message : String(batchError)}).`);
					}
				}
			}
			if (installed > 0) {
				log(`Installed ${installed} package${installed === 1 ? '' : 's'} into this profile.`);
			}
		}
	}

	/*
	 * The runtime's family, kept at the runtime's own versions.
	 *
	 * Two things happen here, and only the second runs a process. Declaring the family in the
	 * profile's manifest is written by this module rather than by npm, so a profile that already
	 * holds the right versions costs nothing and still cannot drift on the next install someone
	 * else runs; installing is only for a version that differs.
	 */
	const family = options.runtimeRoot === undefined ? [] : runtimeFamilyPins(options.runtimeRoot, io);
	if (family.length > 0) {
		const familyWork = scanRuntimeFamily(npmRoot, family, io);
		declareFamilyInManifest(npmProject, familyWork.declared, io);
		if (familyWork.specs.length > 0) {
			log('Updating this profile’s pi packages so they match the version PiCode runs…');
			const familyPlan = planNpmRun(['install', '--save-exact', '--no-audit', '--no-fund', ...familyWork.specs], { npmCli: options.npmCli });
			try {
				const outcome = await spawn(familyPlan.file, familyPlan.args, {
					cwd: npmProject,
					env: npmRunEnv(familyPlan, env),
					windowsHide: true,
					timeoutMs: BATCH_TIMEOUT_MS,
					shell: familyPlan.shell,
				});
				if (!outcome.ok) {
					throw new Error(reasonOf(outcome.stderr));
				}
				log(`Updated ${familyWork.specs.length} pi package${familyWork.specs.length === 1 ? '' : 's'} in this profile.`);
			} catch (error) {
				failed += familyWork.specs.length;
				log(`This profile’s pi packages could not be updated (${error instanceof Error ? error.message : String(error)}), so they stay on the version already installed.`);
			}
		}
	}

	for (const checkout of scan.gitClones) {
		try {
			mkdirSync(path.dirname(checkout.target), { recursive: true });
			const outcome = await spawn('git', ['clone', checkout.url, checkout.target], {
				cwd: profileDir,
				env,
				windowsHide: true,
				timeoutMs: ONE_TIMEOUT_MS,
			});
			if (outcome.ok) {
				cloned += 1;
			} else {
				throw new Error(reasonOf(outcome.stderr));
			}
		} catch (error) {
			failed += 1;
			log(`Repository ${checkout.url} could not be brought into this profile (${error instanceof Error ? error.message : String(error)}).`);
		}
	}
	if (cloned > 0) {
		log(`Brought ${cloned} git package${cloned === 1 ? '' : 's'} into this profile.`);
	}

	return { installed, cloned, present: scan.present, failed, rejected: scan.rejected, lines };
}

/**
 * The runs already in flight, per profile — so every caller that reaches for the same profile
 * waits for the same single install and no second one can start beside it.
 */
const inflight = new Map<string, Promise<PackagesInstallOutcome>>();

/**
 * Makes the profile whole, once: whatever the settings declare and the disk lacks is installed
 * in one hidden npm run (and git clones for git declarations), then the outcome is answered.
 *
 * Concurrent calls for the same profile share one run; a later call after a completed one only
 * scans — a whole profile spawns nothing. This never rejects: a failure is `failed` plus its
 * sentence, so a caller can log it and go on.
 */
export function ensureProfilePackages(options: EnsureProfilePackagesOptions): Promise<PackagesInstallOutcome> {
	const key = `${path.resolve(options.profileDir).toLowerCase()}\u0000${path.resolve(options.profileDir)}`;
	const running = inflight.get(key);
	if (running !== undefined) {
		return running;
	}
	const run = runEnsure(options).finally(() => inflight.delete(key));
	inflight.set(key, run);
	return run;
}
