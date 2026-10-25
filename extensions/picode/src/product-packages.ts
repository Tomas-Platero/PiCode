/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The packages the product itself puts in PiCode's profile, at the versions it ships.
 *
 * PiCode is pi plus Gentle AI (ADR-030): gentle-pi brings the method, the roles and the review
 * tools; gentle-engram brings pi its memory. They are declared here at **exact versions**, so a
 * profile can never float to a release nobody tried, and every run of the package installer
 * puts the declaration back the way the product pins it — an import, an old profile or a hand
 * edit cannot leave it ranged, unpinned or filtered differently.
 *
 * gentle-pi is also **narrowed**: it ships a terminal experience (a banner, sounds, a pretty
 * printer, a prompt history, the Herdr integration, usage statistics, its shell and its usage
 * metrics) that has no place in an editor, so those extensions are excluded by pi's own package
 * filter. What stays is the method, the roles, the tools and the review.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

import { packageNameOf } from './left-behind-packages';

/** One package the product pins. */
export interface ProductPackage {
	/** The npm name. */
	readonly name: string;
	/** The exact version the product ships. */
	readonly version: string;
	/** pi's package filter for extensions (`!pattern` excludes); omitted loads everything. */
	readonly extensions?: readonly string[];
	/** pi's package filter for themes; `[]` loads none. */
	readonly themes?: readonly string[];
}

/**
 * gentle-pi's terminal-only extensions, as pi's filter spells them (paths inside the package).
 * The banner, the sounds, the pretty printer, the prompt history, the Herdr integration, the
 * statistics, the shell, the usage metrics (which also report usage) and the resume hint.
 */
export const GENTLE_PI_TERMINAL_EXTENSIONS: readonly string[] = [
	'!extensions/startup-banner.ts',
	'!extensions/gentle-notifications.ts',
	'!extensions/pi-pretty.ts',
	'!extensions/history/**',
	'!extensions/gentle-herdr-activity.ts',
	'!extensions/gentle-stats.ts',
	'!extensions/gentle-shell.ts',
	'!extensions/runtime-metrics.ts',
	'!extensions/resume-hint.ts',
];

/**
 * Packages that do what Gentle AI already does here, and so are switched off in the profile.
 *
 * PiCode is pi plus Gentle AI: one set of subagents (gentle-pi's `subagent_run`) and one memory
 * (gentle-engram). An imported profile can carry others — `@tintinweb/pi-subagents` registers an
 * `Agent` tool, and the model picks whichever tool it likes, so the chat's Tasks block, which
 * draws gentle-pi's agents, would see nothing of the work the other one ran. These are named as
 * `packageNameOf` reads them (`left-behind-packages.ts`).
 */
export const DISPLACED_PACKAGE_NAMES: readonly string[] = [
	'@tintinweb/pi-subagents',
	'github.com/HazAT/pi-interactive-subagents',
	'pi-memory',
];

/** What the product pins, in the order it declares them. */
export const PRODUCT_PACKAGES: readonly ProductPackage[] = [
	{ name: 'gentle-pi', version: '4.3.0', extensions: GENTLE_PI_TERMINAL_EXTENSIONS, themes: [] },
	{ name: 'gentle-engram', version: '0.4.2' },
];

/** The `packages` entry for one pinned package: a plain spec, or the filtered object form. */
export function productEntry(pkg: ProductPackage): string | Record<string, unknown> {
	const source = `npm:${pkg.name}@${pkg.version}`;
	if (pkg.extensions === undefined && pkg.themes === undefined) {
		return source;
	}
	return {
		source,
		...(pkg.extensions === undefined ? {} : { extensions: [...pkg.extensions] }),
		...(pkg.themes === undefined ? {} : { themes: [...pkg.themes] }),
	};
}

/** The bare npm name an existing `packages` entry points at, or `undefined` when it is not an npm one. */
function npmNameOf(entry: unknown): string | undefined {
	const source = typeof entry === 'string'
		? entry
		: typeof entry === 'object' && entry !== null && typeof (entry as { source?: unknown })['source'] === 'string'
			? (entry as { source: string })['source']
			: undefined;
	if (source === undefined || !source.toLowerCase().startsWith('npm:')) {
		return undefined;
	}
	const spec = source.slice('npm:'.length).trim();
	const at = spec.indexOf('@', 1);
	return at > 0 ? spec.slice(0, at) : spec;
}

/** The entry that keeps a displaced package declared and loads nothing from it. */
export function switchedOff(source: string): { readonly source: string; readonly extensions: readonly string[]; readonly skills: readonly string[]; readonly prompts: readonly string[]; readonly themes: readonly string[] } {
	return { source, extensions: [], skills: [], prompts: [], themes: [] };
}

/** What one reconciliation answered. */
export interface ProductPackagesResult {
	/** The settings text to keep: the original when nothing had to change. */
	readonly text: string | undefined;
	readonly changed: boolean;
}

/**
 * Makes the settings declare every product package exactly as the product pins it.
 *
 * Other entries stay where they are, untouched. A product package already declared keeps its
 * position and is rewritten to the pinned entry; a duplicate declaration is dropped; a missing
 * one is appended. A settings file that is not a JSON object is left alone — the owner's file
 * is never replaced by a guess.
 *
 * A displaced package written as a plain declaration is switched off (`switchedOff`): still
 * declared, nothing loaded. One already written as an object is the owner's own choice of what to
 * load from it, and is left as it is — which is also how it is switched back on.
 */
export function withProductPackages(
	settingsText: string | undefined,
	products: readonly ProductPackage[] = PRODUCT_PACKAGES,
	displaced: readonly string[] = DISPLACED_PACKAGE_NAMES,
): ProductPackagesResult {
	if (products.length === 0 && displaced.length === 0) {
		return { text: settingsText, changed: false };
	}
	let settings: Record<string, unknown>;
	if (settingsText === undefined || settingsText.trim().length === 0) {
		settings = {};
	} else {
		try {
			const parsed: unknown = JSON.parse(settingsText);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				return { text: settingsText, changed: false };
			}
			settings = parsed as Record<string, unknown>;
		} catch {
			return { text: settingsText, changed: false };
		}
	}
	const declared = Array.isArray(settings['packages']) ? settings['packages'] as unknown[] : [];
	const wanted = new Map(products.map(pkg => [pkg.name, productEntry(pkg)] as const));
	const placed = new Set<string>();
	const next: unknown[] = [];
	for (const entry of declared) {
		const name = npmNameOf(entry);
		if (name === undefined || !wanted.has(name)) {
			next.push(typeof entry === 'string' && displaced.includes(packageNameOf(entry)) ? switchedOff(entry) : entry);
			continue;
		}
		if (!placed.has(name)) {
			placed.add(name);
			next.push(wanted.get(name));
		}
	}
	for (const [name, entry] of wanted) {
		if (!placed.has(name)) {
			next.push(entry);
		}
	}
	if (JSON.stringify(next) === JSON.stringify(declared) && (Array.isArray(settings['packages']) || next.length === 0)) {
		return { text: settingsText, changed: false };
	}
	const text = `${JSON.stringify({ ...settings, packages: next }, undefined, '\t')}\n`;
	return { text, changed: true };
}
