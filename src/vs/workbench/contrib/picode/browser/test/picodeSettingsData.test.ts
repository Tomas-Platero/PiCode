/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The Settings window: its search, pi's tool switches and the old account links. */

import assert from 'assert';
import { test } from 'node:test';
import { accountLinkTarget, settingsMatches, themeKind, themeMatches, toolEnabled, toolsAfterToggle } from '../settings/picodeSettingsData.js';

test('the search finds a page by its name or a row name, ignoring case and accents', () => {
	assert.strictEqual(settingsMatches('THEME', 'General', ['theme', 'language']), true);
	assert.strictEqual(settingsMatches('configuracion', 'Configuración', []), true);
	assert.strictEqual(settingsMatches('jira', 'General', ['theme']), false);
});

test('an empty search shows every page', () => {
	assert.strictEqual(settingsMatches('   ', 'Updates', []), true);
});

test('turning a tool off adds it once, turning it on removes it, MCP entries stay', () => {
	assert.deepStrictEqual(toolsAfterToggle(['mcp_github'], 'bash', false), ['mcp_github', 'bash']);
	assert.deepStrictEqual(toolsAfterToggle(['mcp_github', 'bash'], 'bash', false), ['mcp_github', 'bash']);
	assert.deepStrictEqual(toolsAfterToggle(['mcp_github', 'bash'], 'bash', true), ['mcp_github']);
	assert.deepStrictEqual(toolsAfterToggle(undefined, 'read', true), []);
});

test('a tool is on unless the list names it', () => {
	assert.strictEqual(toolEnabled(undefined, 'bash'), true);
	assert.strictEqual(toolEnabled(['bash'], 'bash'), false);
});

test('old account links land on their page in Settings', () => {
	assert.strictEqual(accountLinkTarget('sync'), 'cloudSync');
	assert.strictEqual(accountLinkTarget('connections'), 'connections');
	assert.strictEqual(accountLinkTarget('privacy'), 'privacy');
	assert.strictEqual(accountLinkTarget('proFeatures'), 'account');
	assert.strictEqual(accountLinkTarget('overview'), 'account');
	assert.strictEqual(accountLinkTarget(undefined), 'account');
});

test('a theme is dark, light or high contrast, whatever the editor calls its scheme', () => {
	assert.strictEqual(themeKind('dark'), 'dark');
	assert.strictEqual(themeKind('light'), 'light');
	assert.strictEqual(themeKind('hcDark'), 'hc');
	assert.strictEqual(themeKind('hcLight'), 'hc');
	assert.strictEqual(themeKind('hc'), 'hc');
});

test('the theme gallery filters by kind and by name', () => {
	assert.strictEqual(themeMatches('', 'all', 'Dracula', 'dark'), true);
	assert.strictEqual(themeMatches('', 'light', 'Dracula', 'dark'), false);
	assert.strictEqual(themeMatches('drac', 'dark', 'Dracula', 'dark'), true);
	assert.strictEqual(themeMatches('nord', 'all', 'Dracula', 'dark'), false);
});
