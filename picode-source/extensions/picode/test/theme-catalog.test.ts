/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The gallery's manifest filter, run on its own.
 *
 * Open VSX's `category=themes` search is loose: it returns PowerShell. PowerShell really does
 * declare `contributes.themes` (the "PowerShell ISE" theme), so the theme check alone keeps
 * it — and choosing it installs a debugger and raises the publisher-trust prompt on the way.
 * The manifests below are the two sides of that boundary, reduced to the fields the rule reads.
 *
 * `node --test` runs this file directly (Node's own type stripping), which is why the module
 * carries no `vscode`.
 */

import assert from 'assert';
import { test } from 'node:test';
import { declaredThemes, isThemeOnlyManifest } from '../src/theme-catalog.ts';

/** The shape PowerShell declares, minus everything the rule does not read. */
const POWERSHELL_MANIFEST = {
	name: 'powershell',
	main: './dist/extension.js',
	activationEvents: ['onDebugResolve:PowerShell', 'onLanguage:powershell'],
	contributes: {
		debuggers: [{ type: 'PowerShell', label: 'PowerShell' }],
		commands: [{ command: 'PowerShell.ShowLogs', title: 'Show Logs' }],
		views: { explorer: [{ id: 'PowerShell', name: 'PowerShell' }] },
		themes: [{ label: 'PowerShell ISE', uiTheme: 'vs', path: './themes/theme-psise/theme.json' }],
	},
};

/** The shape a real color theme declares (One Dark Pro, Catppuccin, …), reduced the same way. */
const THEME_MANIFEST = {
	name: 'material-theme',
	main: './out/extension.js',
	contributes: {
		commands: [{ command: 'materialTheme.setTheme', title: 'Set Theme' }],
		themes: [{ id: 'One Dark Pro', label: 'One Dark Pro', uiTheme: 'vs-dark', path: './themes/OneDark-Pro.json' }],
	},
};

test('isThemeOnlyManifest rejects a tool that merely ships a theme (PowerShell)', () => {
	assert.strictEqual(isThemeOnlyManifest(POWERSHELL_MANIFEST), false);
});

test('isThemeOnlyManifest keeps a color theme, main entry point and commands included', () => {
	assert.strictEqual(isThemeOnlyManifest(THEME_MANIFEST), true);
});

test('isThemeOnlyManifest rejects an extension pack and a language provider', () => {
	assert.strictEqual(isThemeOnlyManifest({ extensionPack: ['a.b'], contributes: { themes: [] } }), false);
	assert.strictEqual(isThemeOnlyManifest({ contributes: { languages: [{ id: 'x' }], themes: [] } }), false);
	assert.strictEqual(isThemeOnlyManifest({}), false);
	assert.strictEqual(isThemeOnlyManifest(undefined), false);
});

test('declaredThemes reads the id and falls back to the label, dropping unusable rows', () => {
	assert.deepStrictEqual(
		declaredThemes({ contributes: { themes: [
			{ id: 'Abyss', label: 'Abyss', uiTheme: 'vs-dark', path: './themes/abyss.json' },
			{ label: 'No path' },
			{ label: 'Fallback', path: './themes/f.json' },
		] } }),
		[
			{ id: 'Abyss', label: 'Abyss', path: './themes/abyss.json', uiTheme: 'vs-dark' },
			{ id: 'Fallback', label: 'Fallback', path: './themes/f.json' },
		],
	);
});
