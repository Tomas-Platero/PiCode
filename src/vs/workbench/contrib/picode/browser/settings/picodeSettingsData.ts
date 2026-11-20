/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The Settings window's pure rules: search, tool switches and old account links. No DOM, so Node tests load it. */

/** Lower-cases and drops accents, so "configuración" matches "configuracion". */
export function normalizeSettingsQuery(text: string): string {
	return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Whether a page or row answers to the query, by its name or one of its keywords. An empty query matches everything. */
export function settingsMatches(query: string, label: string, keywords: readonly string[]): boolean {
	const q = normalizeSettingsQuery(query);
	if (!q) {
		return true;
	}
	return [label, ...keywords].some(word => normalizeSettingsQuery(word).includes(q));
}

/** Whether a tool is on, given the list of tools turned off. */
export function toolEnabled(disabled: readonly string[] | undefined, name: string): boolean {
	return !(disabled ?? []).includes(name);
}

/** The list of tools turned off after switching one on or off; every other entry (MCP tools) is kept. */
export function toolsAfterToggle(disabled: readonly string[] | undefined, name: string, on: boolean): string[] {
	const rest = (disabled ?? []).filter(entry => entry !== name);
	return on ? rest : [...rest, name];
}

/** The Settings page an old account link names (`picode.account.open <page>`); unknown or none lands on the account itself. */
export function accountLinkTarget(page: string | undefined): 'account' | 'cloudSync' | 'connections' | 'privacy' {
	switch (page) {
		case 'sync': return 'cloudSync';
		case 'connections': return 'connections';
		case 'privacy': return 'privacy';
		// Pro features was folded into the account overview.
		default: return 'account';
	}
}

/** A theme's kind, from the editor's colour scheme (`dark`, `light`, `hcDark`, `hcLight`). */
export type ThemeKind = 'dark' | 'light' | 'hc';

export function themeKind(type: string): ThemeKind {
	return type === 'light' ? 'light' : type === 'hcDark' || type === 'hcLight' || type === 'hc' ? 'hc' : 'dark';
}

/** Whether a theme shows in the gallery for this search and kind filter. */
export function themeMatches(query: string, filter: ThemeKind | 'all', label: string, kind: ThemeKind): boolean {
	return (filter === 'all' || filter === kind) && settingsMatches(query, label, []);
}
