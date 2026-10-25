/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How this editor runs npm, decided in one pure place.
 *
 * ## The bug this module closes
 *
 * npm on Windows is `npm.cmd`, and `execFile` refuses to run a `.cmd` without a shell — so every
 * npm path here used to spawn through one. A shell does not escape its arguments, it
 * **concatenates** them, so any argument carrying a space breaks into several. The build's own
 * folder never carried one (`PiCode-win32-x64`), so this stayed latent until a side-by-side
 * build's `" - experimental2"` suffix reached the update's `--prefix <runtimeDir>`: npm's log
 * recorded the prefix split into `"d:\…\PiCode-win32-x64"`, `"-"`,
 * `"experimental2\resources\pi-runtime"` — a nonexistent prefix plus two junk arguments.
 * Any owner whose install path holds a space (a user name, `Program Files`) was next.
 *
 * ## The shape
 *
 * npm's CLI is a JS file, so the primary plan runs it the way pi's own CLI is run:
 * `process.execPath` with `ELECTRON_RUN_AS_NODE` — the editor's binary as plain Node — over
 * `<npm-cli.js> install …`, a **real arguments array**, and **no shell**. The class of bug is
 * gone, not patched: no shell, no concatenation. The CLI's file is derived from the `npm` shim
 * on PATH ({@link locateNpmCli}), which is where every other npm path found npm anyway.
 *
 * When the CLI's file cannot be located (an npm shaped unlike the standard layouts), the plan
 * falls back to the npm shim through a shell — with every argument quoted first, so a space
 * still cannot split one. That fallback is why {@link isSafeNpmInstallSpec} keeps its place:
 * the whitelist stays in front of whatever reaches a shell, belt and braces.
 *
 * There is deliberately **no `vscode` import**: the plan is pure, so the tests can pin the
 * exact argv each shape issues.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { resolveOnPath } from './piLocate';

/* ------------------------------------------------------------------ *
 * Finding npm's CLI script
 * ------------------------------------------------------------------ */

/** What locating needs; everything is injectable so the rules run without a machine. */
export interface LocateNpmCliDeps {
	/** Finds the `npm` shim on PATH. Defaults to `piLocate.ts`'s resolver. */
	readonly resolve?: (name: string) => string | undefined;
	/** Whether a candidate file exists. Defaults to the filesystem. */
	readonly exists?: (file: string) => boolean;
	/** The platform the shim's layout is read for. Defaults to the running one. */
	readonly platform?: NodeJS.Platform;
}

/**
 * The `npm-cli.js` behind the npm on PATH, or `undefined` when there is none.
 *
 * The standard layouts this derivation covers: Windows installs the shim at
 * `<node>\npm.cmd` with the CLI at `<node>\node_modules\npm\bin\npm-cli.js`; Unix installs
 * the shim at `<prefix>/bin/npm` with the CLI at `<prefix>/lib/node_modules/npm/bin/npm-cli.js`
 * (which is what the shim symlinks to). `undefined` means the npm on PATH is shaped unlike
 * both — the caller's plan falls back to the shim through a quoted shell, never to nothing.
 */
export function locateNpmCli(deps: LocateNpmCliDeps = {}): string | undefined {
	const platform = deps.platform ?? process.platform;
	const resolve = deps.resolve ?? resolveOnPath;
	const exists = deps.exists ?? (file => {
		try {
			return existsSync(file);
		} catch {
			return false;
		}
	});
	const shim = resolve('npm');
	if (shim === undefined) {
		return undefined;
	}
	const directory = path.dirname(shim);
	const cliFile = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
	const candidates = platform === 'win32'
		? [path.join(directory, cliFile)]
		: [path.join(directory, '..', 'lib', cliFile)];
	return candidates.find(candidate => exists(candidate));
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/** One npm run, resolved to the process the editor actually spawns. */
export interface NpmRunPlan {
	/** The executable: the editor's own binary over npm's CLI, or the npm shim. */
	readonly file: string;
	/** The arguments, one per element — never a shell string to be split. */
	readonly args: readonly string[];
	/** Whether the run goes through a shell (the shim fallback only). */
	readonly shell: boolean;
	/** The child must run the editor's binary as plain Node (npm's CLI is a Node script). */
	readonly runAsNode: boolean;
}

/** What planning needs; everything optional, so the default is the real machine. */
export interface NpmRunDeps {
	/** npm's CLI file; `undefined` plans the shim through a quoted shell. */
	readonly npmCli?: string;
	/** The Node executable that runs the CLI file. Defaults to the editor's own binary. */
	readonly execPath?: string;
	/** The platform the fallback quoting is spelled for. Defaults to the running one. */
	readonly platform?: NodeJS.Platform;
}

/** The characters a shell could act on; an argument carrying any of them is quoted. */
const SHELL_UNSAFE = /[\s&|<>^"%!]/;

/**
 * One argument made safe for the fallback's shell: quoted when it carries a space or any
 * metacharacter a shell concatenates on, left alone when it needs nothing. Double quotes are
 * how both cmd.exe and POSIX shells keep a spaced argument one argument; the primary plan
 * never shells at all, so this is the fallback's floor, not the guarantee.
 */
export function shellSafeArgument(arg: string): string {
	return SHELL_UNSAFE.test(arg) ? `"${arg}"` : arg;
}

/**
 * The plan for one npm run: node over npm's CLI when the CLI is known, the npm shim through a
 * shell — every argument quoted — when it is not. Either way a space in any argument, a
 * `--prefix` path included, arrives as one argument.
 */
export function planNpmRun(args: readonly string[], deps: NpmRunDeps = {}): NpmRunPlan {
	if (deps.npmCli !== undefined) {
		return {
			file: deps.execPath ?? process.execPath,
			args: [deps.npmCli, ...args],
			shell: false,
			runAsNode: true,
		};
	}
	return {
		file: 'npm',
		args: args.map(shellSafeArgument),
		shell: true,
		runAsNode: false,
	};
}

/**
 * The environment one plan's child needs: the editor's binary must be told to act as Node
 * when it is handed npm's CLI script, and handed through untouched otherwise.
 */
export function npmRunEnv(plan: NpmRunPlan, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return plan.runAsNode ? { ...base, ELECTRON_RUN_AS_NODE: '1' } : { ...base };
}
