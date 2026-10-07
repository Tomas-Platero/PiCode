/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The workspace area's identity and the context a session is given about it.
 *
 * The area session must be a session of the area, not of its first folder wearing the
 * area's clothes: filed under a slug of its own, and told about every root by the name the
 * owner uses for it. These tests run the two rules that decide that, with real paths and
 * without the editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import { areaContextBlock, areaSessionSlug, isWorkspaceWindow } from '../src/workspace-area.ts';
import { piProjectSlug } from '../src/sessions-provider.ts';

const WEB = 'D:\\repositorios\\ArticTempest-Web';
const BOT = 'D:\\repositorios\\artictempest-bot-dashboard';
const APP = 'D:\\repositorios\\artictempest-app';
const GONE = 'D:\\repositorios\\guildboard';

test('the area slug is stable and independent of the folders\' open order', () => {
	const one = areaSessionSlug([WEB, BOT, APP], 'Artictempest');
	const other = areaSessionSlug([APP, WEB, BOT], 'Artictempest');
	assert.strictEqual(one, other);
});

test('the area slug is the area\'s own, never a single folder\'s slug', () => {
	const slug = areaSessionSlug([WEB, BOT], 'Artictempest');
	assert.notStrictEqual(slug, piProjectSlug(WEB));
	assert.notStrictEqual(slug, piProjectSlug(BOT));
	assert.ok(slug.startsWith('--area-'));
	assert.ok(slug.endsWith('--'));
});

test('areas with the same name but different folders file differently', () => {
	assert.notStrictEqual(
		areaSessionSlug([WEB, BOT], 'Artictempest'),
		areaSessionSlug([WEB, APP], 'Artictempest'),
	);
});

test('a workspace name that would break a folder name is sanitized', () => {
	const slug = areaSessionSlug([WEB, BOT], 'Artictempest: "the area"');
	assert.ok(!slug.includes(':'));
	assert.ok(!slug.includes('"'));
	assert.ok(slug.startsWith('--area-Artictempest-'));
});

test('an area without a workspace name still files under its own readable slug', () => {
	const slug = areaSessionSlug([WEB, BOT], undefined);
	assert.ok(slug.startsWith('--area-'));
	assert.ok(slug.endsWith('--'));
});

test('an empty folder list still yields a well-formed slug', () => {
	assert.ok(areaSessionSlug([], 'Artictempest').startsWith('--area-Artictempest-'));
});

test('the context block names every root with the name the owner says and its path', () => {
	const block = areaContextBlock([
		{ name: 'ArticTempest-Web', path: WEB, onDisk: true },
		{ name: 'artictempest-bot-dashboard', path: BOT, onDisk: true },
	], WEB);
	assert.ok(block?.includes('- ArticTempest-Web — D:\\repositorios\\ArticTempest-Web'));
	assert.ok(block?.includes('- artictempest-bot-dashboard — D:\\repositorios\\artictempest-bot-dashboard'));
	assert.ok(block?.includes('Workspace area'));
});

test('a root that is not on disk is named as such, not hidden', () => {
	const block = areaContextBlock([
		{ name: 'guildboard', path: GONE, onDisk: false },
		{ name: 'artictempest-app', path: APP, onDisk: true },
	], APP);
	assert.ok(block?.includes('guildboard'));
	assert.ok(block?.includes('not on disk'));
});

test('the block carries the addressing rules and the honest one-working-directory limit', () => {
	const block = areaContextBlock([
		{ name: 'ArticTempest-Web', path: WEB, onDisk: true },
		{ name: 'artictempest-bot-dashboard', path: BOT, onDisk: true },
	], WEB);
	assert.ok(block?.includes('absolute path under the right root'));
	assert.ok(block?.includes('one working directory at a time'));
	// The session runs in the web root, so the command example is another root.
	assert.ok(block?.includes(`cd "${BOT}"`));
	// ...and the session's own working directory is said, so the model never guesses it.
	assert.ok(block?.includes(WEB));
});

test('no roots at all is no block', () => {
	assert.strictEqual(areaContextBlock([], WEB), undefined);
});

test('a saved workspace file decides the window is a workspace, before its folders finish loading', () => {
	// The owner's report: «la lista de sesiones en un area de trabajo sigue fallando, es que parpadea,
	// es como si intentase coger las de una de las carpetas… Ejemplo las de artictempest-web». A window
	// opened from a workspace file reports one folder while it is still being restored, so counting
	// folders answered "folder" for an instant and the panel listed that folder's sessions.
	assert.strictEqual(isWorkspaceWindow('auto', 1, true), true);
	assert.strictEqual(isWorkspaceWindow('auto', 2, true), true);
	assert.strictEqual(isWorkspaceWindow('auto', 1, false), false);

	// A window opened on folders alone still follows the count, which is what that rule was for.
	assert.strictEqual(isWorkspaceWindow('auto', 2, false), true);
	assert.strictEqual(isWorkspaceWindow('auto', 0, false), false);

	// And the owner's own setting wins over both.
	assert.strictEqual(isWorkspaceWindow('workspace', 1, false), true);
	assert.strictEqual(isWorkspaceWindow('folder', 3, true), false);
});
