/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The packages an import from an external pi leaves behind.
 *
 * This product carries an integration that its owner decided against — it was taken out of
 * the product (commit `2ac4e68d`) — so an import must not drag those packages into PiCode's
 * own profile. The refusal has to happen twice, because a declaration left in the copied
 * `settings.json` is an instruction: the next `pi install` reads that list and installs
 * whatever it names. The import therefore neither installs these packages nor copies their
 * declarations.
 *
 * This module is the one place that knows which names count, so adding a package later is
 * one line in the list below. The names come from the owner's real profile and from the
 * removed integration's own record of what it installed — no others were ever known.
 */

/** The package names this editor does not carry, spelled as npm knows them. */
export const LEFT_BEHIND_PACKAGE_NAMES: readonly string[] = ['gentle-pi', 'gentle-engram'];

/**
 * A package entry's bare name, from any of the spellings a `packages` entry uses: the
 * `npm:` / `git:` prefix comes off, and so does an `@version` suffix. A scoped name
 * (`@scope/pkg`) keeps its leading `@` — only the version's `@` is cut — and an exact
 * name never grows or shrinks: `x-extras` is not `x`.
 */
export function packageNameOf(entry: string): string {
	let value = entry.trim();
	const lowered = value.toLowerCase();
	for (const prefix of ['npm:', 'git:'] as const) {
		if (lowered.startsWith(prefix)) {
			value = value.slice(prefix.length);
			break;
		}
	}
	const at = value.indexOf('@', 1);
	return at > 0 ? value.slice(0, at) : value;
}

/** What a `packages` entry names as its source: the string itself, or the object's `source`. */
function sourceOf(entry: unknown): string | undefined {
	if (typeof entry === 'string') {
		return entry;
	}
	if (typeof entry === 'object' && entry !== null) {
		const source = (entry as { source?: unknown })['source'];
		if (typeof source === 'string') {
			return source;
		}
	}
	return undefined;
}

/** Whether a `packages` entry — a string or an object with a `source` — names a left-behind package. */
export function isLeftBehindPackage(entry: unknown): boolean {
	const source = sourceOf(entry);
	return source !== undefined && LEFT_BEHIND_PACKAGE_NAMES.includes(packageNameOf(source));
}

/** The reference a log line can quote: what the profile actually declared, verbatim. */
export function leftBehindReference(entry: unknown): string | undefined {
	return isLeftBehindPackage(entry) ? sourceOf(entry) : undefined;
}

/**
 * Splits a profile's `packages` list in two: the entries that survive, in their original
 * order and untouched, and the references of the ones the import leaves behind. A list
 * that is not a list leaves nothing behind and keeps nothing.
 */
export function splitLeftBehindPackages(packages: unknown): { kept: unknown[]; leftBehind: string[] } {
	if (!Array.isArray(packages)) {
		return { kept: [], leftBehind: [] };
	}
	const kept: unknown[] = [];
	const leftBehind: string[] = [];
	for (const entry of packages) {
		const reference = leftBehindReference(entry);
		if (reference === undefined) {
			kept.push(entry);
		} else {
			leftBehind.push(reference);
		}
	}
	return { kept, leftBehind };
}
