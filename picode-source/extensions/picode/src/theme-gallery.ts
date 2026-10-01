/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadVariant, searchThemes, type DeclaredTheme, type ThemeCandidate } from './theme-catalog';
import type { ThemeJson } from './theme-types';

/**
 * The theme gallery, served from Open VSX — the registry this product installs from.
 *
 * The wizard's theme card shows the installed themes with their own colors; this module is
 * the other half: what the registry has, searchable, each one with a small preview painted
 * from its real colors (the VSIX is downloaded once and cached in the extension's storage),
 * and installable on click. It is the same catalogue `vscodethemes.com` fronts, read from
 * the source that can actually install here.
 *
 * Three commands, all answers-not-surprises: a search, a thumb (palette for one card,
 * computed from the theme's own file), and the install.
 */

export const GALLERY_SEARCH_COMMAND = 'picode.setup.gallerySearch';
export const GALLERY_THUMB_COMMAND = 'picode.setup.galleryThumb';
export const GALLERY_INSTALL_COMMAND = 'picode.setup.galleryInstall';

export interface GalleryItem {
	/** `publisher.name` — what the editor installs. */
	readonly id: string;
	readonly label: string;
	readonly publisher: string;
	readonly downloads: number;
	readonly version: string;
	/** The declared theme the row stands for; it travels back with the thumb request. */
	readonly downloadUrl?: string;
	readonly variant: DeclaredTheme;
	readonly uiTheme: 'dark' | 'light' | 'hc';
}

export interface GalleryPalette {
	readonly bg: string;
	readonly fg: string;
	readonly ln: string;
	/** keyword, string, comment, function — in that order. */
	readonly a: readonly [string, string, string, string];
}

/** The page size the gallery shows; the card's "Show more" walks this. */
export const GALLERY_PAGE = 24;

export function registerThemeGalleryCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
	const cacheDir = path.join(context.globalStorageUri.fsPath, 'themes');

	return [
		vscode.commands.registerCommand(GALLERY_SEARCH_COMMAND, async (query: unknown): Promise<{ items: GalleryItem[] }> => {
			const text = typeof query === 'string' ? query : '';
			const found: ThemeCandidate[] = await searchThemes({ query: text, limit: GALLERY_PAGE * 2 });
			const items: GalleryItem[] = [];
			for (const candidate of found) {
				// An extension can declare several themes; the card shows one row per theme,
				// because the colour is what is being chosen.
				for (const variant of candidate.declared) {
					items.push({
						id: candidate.id,
						label: candidate.displayName,
						publisher: candidate.id.split('.')[0] ?? '',
						downloads: candidate.downloads,
						version: candidate.version,
						downloadUrl: candidate.downloadUrl,
						variant,
						uiTheme: kindOf(variant.uiTheme),
					});
				}
			}
			return { items };
		}),

		vscode.commands.registerCommand(GALLERY_THUMB_COMMAND, async (request: unknown): Promise<GalleryPalette> => {
			const req = request as { id?: unknown; version?: unknown; downloadUrl?: unknown; declared?: unknown } | undefined;
			if (typeof req?.id !== 'string' || typeof req.version !== 'string' || typeof req.downloadUrl !== 'string' || typeof req.declared !== 'object' || req.declared === null) {
				throw new Error('PiCode: the gallery thumb needs the extension id, version, url and declared theme.');
			}
			const declared = req.declared as DeclaredTheme;
			const variant = await loadVariant({
				extensionId: req.id,
				version: req.version,
				declared,
				downloadUrl: req.downloadUrl,
				cacheDir,
			});
			if (variant === undefined) {
				throw new Error('the theme file could not be read from its VSIX');
			}
			return paletteOf(variant.theme, kindOf(variant.uiTheme));
		}),

		vscode.commands.registerCommand(GALLERY_INSTALL_COMMAND, async (id: unknown): Promise<void> => {
			if (typeof id !== 'string') {
				throw new Error('PiCode: the gallery install needs the extension id.');
			}
			await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
		}),
	];
}

function kindOf(uiTheme: string | undefined): 'dark' | 'light' | 'hc' {
	const value = (uiTheme ?? '').toLowerCase();
	if (value.includes('hc')) { return 'hc'; }
	return value.includes('vs-dark') || value === 'black' ? 'dark' : 'light';
}

/** The theme file's string for a key, or undefined. */
function colorOf(theme: ThemeJson, key: string): string | undefined {
	const colors = theme.colors;
	if (typeof colors !== 'object' || colors === null) { return undefined; }
	const value = (colors as Record<string, unknown>)[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa` → `#rrggbb`, or the fallback. */
function hex6(value: string | undefined, fallback: string): string {
	if (value === undefined || !value.startsWith('#')) { return fallback; }
	const hex = value.slice(1);
	if (hex.length === 3) {
		return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
	}
	if (hex.length >= 6) {
		return `#${hex.slice(0, 6)}`;
	}
	return fallback;
}

/** The four accents a thumbnail needs, from the theme's own token rules. */
function accentsOf(theme: ThemeJson, fallback: string): readonly [string, string, string, string] {
	const wanted = ['keyword', 'string', 'comment', 'entity.name.function'];
	const found: string[] = [fallback, fallback, fallback, fallback];
	const rules = Array.isArray(theme.tokenColors) ? theme.tokenColors : [];
	for (const rule of rules) {
		const foreground = typeof rule?.settings === 'object' && rule.settings !== null
			? (rule.settings as Record<string, unknown>)['foreground']
			: undefined;
		if (typeof foreground !== 'string') { continue; }
		const scopes = typeof rule.scope === 'string' ? [rule.scope] : Array.isArray(rule.scope) ? rule.scope : [];
		for (let i = 0; i < wanted.length; i += 1) {
			if (found[i] !== fallback) { continue; }
			if (scopes.some((scope: string) => scope.includes(wanted[i] as string))) {
				found[i] = hex6(foreground, fallback);
			}
		}
	}
	return found as unknown as readonly [string, string, string, string];
}

/** The thumbnail palette, from the theme's own file. */
function paletteOf(theme: ThemeJson, kind: 'dark' | 'light' | 'hc'): GalleryPalette {
	const dark = kind !== 'light';
	const bg = hex6(colorOf(theme, 'editor.background'), dark ? '#1e1e1e' : '#ffffff');
	const fg = hex6(colorOf(theme, 'editor.foreground'), dark ? '#cccccc' : '#333333');
	const ln = hex6(colorOf(theme, 'editorLineNumber.foreground'), dark ? '#858585' : '#237893');
	return { bg, fg, ln, a: accentsOf(theme, fg) };
}

/** Ensures the cache directory exists; called once per command that downloads. */
export function ensureCacheDir(cacheDir: string): void {
	if (!existsSync(cacheDir)) {
		mkdirSync(cacheDir, { recursive: true });
	}
}

export const INTERNAL_CACHE_DIR = (context: { globalStorageUri: { fsPath: string } }): string =>
	path.join(context.globalStorageUri.fsPath, 'themes');
