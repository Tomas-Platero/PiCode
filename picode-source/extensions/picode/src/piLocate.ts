/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Finding a pi that is not PiCode's own.
 *
 * The external pi is the one installed on this machine — the `pi` on the PATH. PiCode runs
 * it where it lives and never writes to it, so locating it is the whole integration: once
 * the package's ESM entry is found, the SDK loads it exactly like the internal one.
 *
 * Probing is necessary rather than incidental: the package publishes `dist/index.js` under
 * an `import` condition only, so a CommonJS `require.resolve` rejects it, and the module
 * system has no supported way to ask where an ESM-only package lives. Walking up covers both
 * shapes this meets — an npm global shim, which sits beside `node_modules`, and a direct
 * path into `dist/` — without knowing anything about npm's layout beyond that.
 */

/** The published package the external entry is looked for in. */
const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** The depth bound: from `dist/` inside the package, the entry is four levels up. */
const MAX_WALK_UP = 10;

/**
 * Finds an executable on PATH, applying PATHEXT on Windows.
 *
 * `spawn` does not resolve `pi` to `pi.cmd` by itself, and reaching for a shell to do it
 * would put the name through shell parsing. Resolving here keeps the reported path honest.
 */
export function resolveOnPath(name: string): string | undefined {
	if (name.includes('/') || name.includes('\\')) {
		return existsSync(name) ? name : undefined;
	}

	const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		if (directory.length === 0) {
			continue;
		}
		for (const extension of extensions) {
			const candidate = path.join(directory, `${name}${extension}`);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/**
 * The pi package's ESM entry, found by walking up from a directory.
 *
 * Returns the first `node_modules/<pi package>/dist/index.js` (or its nested shape when the
 * start is already inside the package) that exists on disk, or `undefined` when ten levels
 * up from the start there is none.
 */
export function findSdkEntry(start: string): string | undefined {
	const nested = path.join('node_modules', ...PI_PACKAGE.split('/'), 'dist', 'index.js');
	const inside = path.join(...PI_PACKAGE.split('/'), 'dist', 'index.js');

	let current = start;
	for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
		for (const candidate of [path.join(current, nested), path.join(current, inside)]) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return undefined;
}

/**
 * The pi package's entry, found from the shim that launches it.
 *
 * One function for the three places that must agree on the answer — the onboarding card's
 * availability, its probe, and the external runtime — because two layouts put the package
 * behind a `pi` on the PATH:
 *
 * - an **npm install**, where the shim sits beside its `node_modules`: the walk-up above;
 * - pi's **managed install**, where the shim runs `pi-launcher.js`, which reads
 *   `install/current-version` and launches the package from
 *   `install/releases/<version>/node_modules/…` (the launcher's own arithmetic, with the
 *   launcher's own validation of the version file).
 *
 * Only the first was ever looked for, so a machine with the managed install had no external
 * pi as far as this editor was concerned: the onboarding card stayed greyed — and
 * unclickable, since the click was bound only when the option was available — while the
 * probe beside it already said "found on your computer — ready to use".
 */
export function sdkEntryOfShim(shim: string): string | undefined {
	const start = path.dirname(shim);
	return findSdkEntry(start) ?? findManagedSdkEntry(start);
}

/**
 * The managed install's entry, for the two roots a shim can sit in: `<root>/bin/pi` (the
 * shape pi installs) or `<root>/pi`. Absent or unreadable is "there is no pi here" — the
 * same answer the caller gives for a missing shim, never a path built from a version file
 * that does not name one.
 */
function findManagedSdkEntry(shimDir: string): string | undefined {
	const nested = path.join('node_modules', ...PI_PACKAGE.split('/'), 'dist', 'index.js');
	for (const root of [path.dirname(shimDir), shimDir]) {
		const versionFile = path.join(root, 'install', 'current-version');
		if (!existsSync(versionFile)) {
			continue;
		}
		try {
			const version = readFileSync(versionFile, 'utf8').trim();
			// The version names one segment of a path, so the launcher's rule applies verbatim:
			// nothing empty, nothing that could climb out of `releases/`, one path segment only.
			if (!version || version === '.' || version === '..' || !/^[0-9A-Za-z._+-]+$/.test(version)) {
				continue;
			}
			const entry = path.join(root, 'install', 'releases', version, nested);
			if (existsSync(entry)) {
				return entry;
			}
		} catch {
			// An unreadable version file is "not found", which the caller says in its own words.
		}
	}
	return undefined;
}

/**
 * The external pi's SDK entry: the entry of the package behind the `pi` on the PATH.
 *
 * `undefined` means the machine has no `pi` on the PATH, or the one it names does not carry
 * the package — both are "there is no external pi here", and the caller says so rather than
 * falling back to the internal one in silence.
 */
export function externalSdkEntry(): string | undefined {
	const executable = resolveOnPath('pi');
	return executable === undefined ? undefined : sdkEntryOfShim(executable);
}
