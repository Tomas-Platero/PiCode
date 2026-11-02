/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's language, prepared by the setup: which pack a language needs, when there is nothing
 * to do, and that a registry that fails or lies never leaves a note for the editor to follow.
 */

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { editorLanguage, languagePackOf, LANGUAGE_PACKS, LANGUAGE_FOLDER, PENDING_FILE, packInstalled, prepareEditorLanguage } = await import('../src/display-language');

const GOOD_DOWNLOAD = 'https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-es/1.131.0/file/MS-CEINTL.vscode-language-pack-es-1.131.0.vsix';

function scratch(): string {
	return mkdtempSync(path.join(tmpdir(), 'picode-language-'));
}

/** A registry that answers as Open VSX does, and records what it was asked for. */
function registry(answer: unknown = { version: '1.131.0', files: { download: GOOD_DOWNLOAD } }) {
	const calls: string[] = [];
	return {
		calls,
		io: {
			async fetchJson(url: string) { calls.push(`json ${url}`); return answer; },
			async download(url: string, destination: string) { calls.push(`file ${url}`); writeFileSync(destination, 'pack'); },
		},
	};
}

const IN_ENGLISH = { VSCODE_NLS_CONFIG: JSON.stringify({ resolvedLanguage: 'en' }) } as NodeJS.ProcessEnv;

test('every language PiCode translates has a pack, and the odd names are the registry\'s', () => {
	assert.strictEqual(Object.keys(LANGUAGE_PACKS).length, 13);
	assert.strictEqual(languagePackOf('pt-br'), 'pt-BR');
	assert.strictEqual(languagePackOf('zh-cn'), 'zh-hans');
	assert.strictEqual(languagePackOf('zh-tw'), 'zh-hant');
	assert.strictEqual(languagePackOf('en'), undefined);
	assert.strictEqual(languagePackOf('constructor'), undefined);
});

test('the language the editor shows comes from the environment the main process set', () => {
	assert.strictEqual(editorLanguage({ VSCODE_NLS_CONFIG: JSON.stringify({ resolvedLanguage: 'ES' }) } as NodeJS.ProcessEnv), 'es');
	assert.strictEqual(editorLanguage({} as NodeJS.ProcessEnv), 'en');
	assert.strictEqual(editorLanguage({ VSCODE_NLS_CONFIG: 'not json' } as NodeJS.ProcessEnv), 'en');
});

test('an installed pack is found by its folder name, whatever its version', () => {
	const extensions = scratch();
	mkdirSync(path.join(extensions, 'ms-ceintl.vscode-language-pack-es-1.131.0-universal'));
	assert.strictEqual(packInstalled(extensions, 'es'), true);
	assert.strictEqual(packInstalled(extensions, 'de'), false);
	assert.strictEqual(packInstalled(undefined, 'es'), false);
	rmSync(extensions, { recursive: true, force: true });
});

test('a language the editor is not in is downloaded and left, with a note, for its first start', async () => {
	const data = scratch();
	const { io, calls } = registry();
	assert.strictEqual(await prepareEditorLanguage({ language: 'es', label: 'Español', userDataPath: data, env: IN_ENGLISH }, io), 'ready');
	const note = JSON.parse(readFileSync(path.join(data, LANGUAGE_FOLDER, PENDING_FILE), 'utf8'));
	assert.strictEqual(note.language, 'es');
	assert.strictEqual(note.label, 'Español');
	assert.strictEqual(note.version, '1.131.0');
	assert.strictEqual(note.firstRun, false, 'a setup opened later does not make the editor restart by itself');
	assert.ok(existsSync(note.file) && note.file.endsWith('.vsix'));
	assert.deepStrictEqual(calls, ['json https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-es/latest', `file ${GOOD_DOWNLOAD}`]);
	rmSync(data, { recursive: true, force: true });
});

test('the first run leaves word of it, so the editor can switch by itself', async () => {
	const data = scratch();
	const { io } = registry();
	await prepareEditorLanguage({ language: 'es', label: 'Espa\u00f1ol', userDataPath: data, firstRun: true, env: IN_ENGLISH }, io);
	assert.strictEqual(JSON.parse(readFileSync(path.join(data, LANGUAGE_FOLDER, PENDING_FILE), 'utf8')).firstRun, true);
	rmSync(data, { recursive: true, force: true });
});

test('a pack already downloaded is not downloaded again', async () => {
	const data = scratch();
	const first = registry();
	await prepareEditorLanguage({ language: 'es', label: 'Español', userDataPath: data, env: IN_ENGLISH }, first.io);
	const second = registry();
	assert.strictEqual(await prepareEditorLanguage({ language: 'es', label: 'Español', userDataPath: data, env: IN_ENGLISH }, second.io), 'ready');
	assert.deepStrictEqual(second.calls, ['json https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-es/latest']);
	rmSync(data, { recursive: true, force: true });
});

test('nothing is fetched when the editor already speaks the language, or has its pack', async () => {
	const data = scratch();
	const extensions = scratch();
	const { io, calls } = registry();
	mkdirSync(path.join(data, LANGUAGE_FOLDER), { recursive: true });
	writeFileSync(path.join(data, LANGUAGE_FOLDER, PENDING_FILE), '{}');

	const inSpanish = { VSCODE_NLS_CONFIG: JSON.stringify({ resolvedLanguage: 'es' }) } as NodeJS.ProcessEnv;
	assert.strictEqual(await prepareEditorLanguage({ language: 'es', label: 'x', userDataPath: data, env: inSpanish }, io), 'current');
	assert.ok(!existsSync(path.join(data, LANGUAGE_FOLDER)), 'a note that is no longer needed is removed');

	mkdirSync(path.join(extensions, 'ms-ceintl.vscode-language-pack-de-1.131.0-universal'));
	assert.strictEqual(await prepareEditorLanguage({ language: 'de', label: 'x', userDataPath: data, extensionsPath: extensions, env: IN_ENGLISH }, io), 'installed');

	assert.strictEqual(await prepareEditorLanguage({ language: 'en', label: 'English', userDataPath: data, env: inSpanish }, io), 'unsupported');
	assert.deepStrictEqual(calls, []);
	rmSync(data, { recursive: true, force: true });
	rmSync(extensions, { recursive: true, force: true });
});

test('a registry that fails, or points somewhere else, leaves no note and says offline', async () => {
	const data = scratch();
	const failing = { async fetchJson() { throw new Error('no network'); }, async download() { throw new Error('no network'); } };
	assert.strictEqual(await prepareEditorLanguage({ language: 'fr', label: 'Français', userDataPath: data, env: IN_ENGLISH }, failing), 'offline');

	const elsewhere = registry({ version: '1.131.0', files: { download: 'https://example.com/pack.vsix' } });
	assert.strictEqual(await prepareEditorLanguage({ language: 'fr', label: 'Français', userDataPath: data, env: IN_ENGLISH }, elsewhere.io), 'offline');
	assert.deepStrictEqual(elsewhere.calls.filter(call => call.startsWith('file')), []);

	const badVersion = registry({ version: '../../x', files: { download: GOOD_DOWNLOAD } });
	assert.strictEqual(await prepareEditorLanguage({ language: 'fr', label: 'Français', userDataPath: data, env: IN_ENGLISH }, badVersion.io), 'offline');

	assert.ok(!existsSync(path.join(data, LANGUAGE_FOLDER, PENDING_FILE)));
	rmSync(data, { recursive: true, force: true });
});
