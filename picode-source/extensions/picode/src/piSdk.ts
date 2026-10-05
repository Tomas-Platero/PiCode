/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Finding pi, and loading it.
 *
 * One place, because three modules need it for three different things: the agent needs
 * `createAgentSessionFromServices`, connecting a subscription and listing its models need
 * `createAgentSessionServices`. A second copy of the candidate paths would be a second answer to
 * "where is the pi of this editor", and the product only has one.
 *
 * pi is **not** a dependency of the editor's build: it is loaded by URL at runtime, and only the
 * members actually used are declared structurally by each caller. That is why the load is generic
 * here and typed by whoever asks.
 *
 * ## The one thing that must not be written as a plain `import()`
 *
 * This module compiles to CommonJS, and TypeScript turns a dynamic `import(expression)` into
 * `Promise.resolve(...).then(s => require(s))` under that target. `require()` **cannot load an
 * ESM package**, and pi publishes its entry as ESM — so the failure is not "pi is missing", it is
 * `ERR_REQUIRE_ESM` for a pi that is sitting right there. That is exactly what happened once: the
 * check found the file, the load failed, and the owner was told "this editor has no pi to talk to"
 * while pi was installed and working.
 *
 * Building the import at runtime keeps it a genuine dynamic `import()`, which is what loads ESM.
 * The reason a load failed is **returned rather than swallowed**, because the sentence the owner
 * reads has to be true: "pi is not installed" and "pi is installed and could not be loaded" are
 * different problems with different fixes.
 */

/** What a load produced: the module with the entry it was loaded from, or why there is none. */
export type PiSdkLoad<T> = { readonly sdk: T; readonly entry: string } | { readonly problem: string };

/**
 * The candidate places pi can live, most-PiCode-first. The **internal** pi's candidates;
 * the external one is resolved by `runtime.ts` (and `piLocate.ts`) and passed directly.
 */
export function sdkCandidates(distributionRoot: string): string[] {
	return piInstallRoots(distributionRoot).map(root => path.join(root, 'dist', 'index.js'));
}

/** The package roots `sdkCandidates` looks in, in the same order. */
function piInstallRoots(distributionRoot: string): string[] {
	return [
		// PiCode's own runtime, where it installs its pinned pi.
		path.join(distributionRoot, 'resources', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent'),
		// A pi already present for this machine. Not the product's own profile — only the
		// code — so nothing of the owner's configuration is read or written from here.
		path.join(distributionRoot, 'resources', 'app', 'node_modules', '@earendil-works', 'pi-coding-agent'),
	];
}

/**
 * The built-in extensions module that ships beside an SDK entry, in pi's own layout.
 *
 * pi's CLI builds every session's factory list from it (`dist/main.js:451`: its built-ins first,
 * the caller's after). A session built from the SDK entry alone has **no** built-in extension at
 * all — pi builds its built-in map from the factories the caller passed — so whoever builds a
 * session the way the CLI does needs this module from the **same** install, which is why it is
 * derived from the entry that was actually loaded and not searched for afresh.
 */
export function builtinsModuleOf(sdkEntry: string): string {
	return path.join(path.dirname(sdkEntry), 'extensions', 'index.js');
}

/** One built-in extension entry of pi's `builtInExtensions` module (`dist/extensions/index.js`). */
export interface PiBuiltinExtension {
	readonly name: string;
	readonly factory: (pi: unknown) => void | Promise<void>;
	/** See pi's `InlineExtension`: another extension registering the same name replaces this one. */
	readonly replaceable?: boolean;
	/** What makes pi treat the entry as the code of a `builtin:<name>` path (`isBuiltinExtension`). */
	readonly builtin: true;
}

/**
 * The built-in extension entries a loaded pi module ships, read defensively.
 *
 * The list comes from pi, so its shape is pi's to change; an entry without the built-in mark is
 * not a built-in to pi's loader (`resource-loader.js` `isBuiltinExtension`) and would silently do
 * nothing here either, so it is reported instead of passed on. The module is never assumed — a
 * pi without the list yields an empty result with the reason said.
 */
export function piBuiltinExtensions(module: unknown): { builtins: PiBuiltinExtension[]; skipped: string[] } {
	const list = (typeof module === 'object' && module !== null && 'builtInExtensions' in module
		? (module as { builtInExtensions?: unknown }).builtInExtensions
		: undefined);
	if (!Array.isArray(list)) {
		return { builtins: [], skipped: [`pi's built-in extension list is missing or not a list`] };
	}
	const builtins: PiBuiltinExtension[] = [];
	const skipped: string[] = [];
	for (const entry of list) {
		const candidate = entry as Partial<PiBuiltinExtension> | null | undefined;
		if (typeof candidate !== 'object' || candidate === null
			|| typeof candidate.name !== 'string' || typeof candidate.factory !== 'function'
			|| candidate.builtin !== true) {
			skipped.push(`entry without name, factory and the built-in mark: ${JSON.stringify(entry) ?? String(entry)}`);
			continue;
		}
		builtins.push(candidate as PiBuiltinExtension);
	}
	return { builtins, skipped };
}

/** The first candidate that is a file, or `undefined` when none is. */
export function firstExisting(candidates: readonly string[]): string | undefined {
	return candidates.find(candidate => {
		try {
			return fs.statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
}

/**
 * The genuine dynamic import, built at runtime.
 *
 * `new Function` and not `import(...)` in the source: see the module comment. This is the same
 * reason pi's own SDK client does it.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

/** Loads pi's entry, or says why it could not. An empty candidate list is "no pi chosen". */
export async function loadPiSdk<T>(candidates: readonly string[]): Promise<PiSdkLoad<T>> {
	const entry = firstExisting(candidates);
	if (entry === undefined) {
		return { problem: `pi could not be found for this editor (looked in ${candidates.length === 0 ? 'nowhere — no pi is installed where the runtime setting points' : candidates.join(' and ')})` };
	}

	try {
		return { sdk: (await dynamicImport(pathToFileURL(entry).href)) as T, entry };
	} catch (error) {
		return { problem: `pi is installed but could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
	}
}
