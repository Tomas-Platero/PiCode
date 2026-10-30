/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The setup window's writes, as rules.
 *
 * These tests are about the promises the setup makes to somebody who has never opened PiCode:
 * an owner's settings file is merged rather than replaced, a file that cannot be understood is
 * left alone, and **credentials never travel unless they were asked for by name**.
 *
 * They run against a throwaway directory, so what they check is what lands on disk. The module
 * under test (`onboarding-settings.ts`) has no runtime dependency on its neighbours precisely so
 * this can be done without standing up an editor.
 */

import * as assert from 'assert';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildImportSelection,
	EXTRA_SETTINGS,
	HOST_ENV,
	editorSettingsPath,
	readEditorSetting,
	readPackages,
	setExtras,
	setModel,
	setPackages,
	setRuntime,
	setTheme,
	setupPathsFromEnv,
	stripJsonComments,
	writeEditorSettings,
	type SetupPaths,
} from '../src/onboarding-settings.ts';

/** A profile pair in a temporary folder: `from` is the machine's, `to` is PiCode's. */
function profiles(): { paths: SetupPaths; from: string; dataDir: string } {
	const root = mkdtempSync(join(tmpdir(), 'picode-onboarding-settings-'));
	const from = join(root, 'external');
	const to = join(root, 'internal');
	const userDataPath = join(root, 'user-data');
	mkdirSync(from, { recursive: true });
	mkdirSync(to, { recursive: true });
	return { paths: { distributionRoot: root, profileDir: to, userDataPath }, from, dataDir: root };
}

function write(file: string, text: string): void {
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, text);
}

test('the paths come from the environment the main process sets, and only when all three are there', () => {
	const env: NodeJS.ProcessEnv = {
		[HOST_ENV.distributionRoot]: '/root',
		[HOST_ENV.profileDir]: '/root/data/pi-agent',
		[HOST_ENV.userDataPath]: '/root/data/user-data',
	};
	assert.deepStrictEqual(setupPathsFromEnv(env), { distributionRoot: '/root', profileDir: '/root/data/pi-agent', userDataPath: '/root/data/user-data' });
	assert.strictEqual(setupPathsFromEnv({ ...env, [HOST_ENV.profileDir]: undefined }), undefined);
	assert.strictEqual(setupPathsFromEnv({}), undefined);
});

test('credentials are only ever in the selection when they were asked for by name', () => {
	const everything = ['settings', 'models', 'mcp', 'skills', 'memory', 'sessions'];

	assert.deepStrictEqual(buildImportSelection(everything, false), {
		settings: true, models: true, mcp: true, skills: true, memory: true, sessions: true,
	});
	assert.deepStrictEqual(buildImportSelection(everything, true), {
		settings: true, models: true, mcp: true, skills: true, memory: true, sessions: true, credentials: true,
	});
	// An item that was not ticked is absent, which the copier reads as "declined" and never opens.
	assert.deepStrictEqual(buildImportSelection(['settings'], false), { settings: true });
	assert.deepStrictEqual(buildImportSelection([], false), {});
	// A page that hands over something unexpected gets nothing it did not ask for.
	assert.deepStrictEqual(buildImportSelection(['settings', 'auth'], false), { settings: true });
});

test('the editor settings are merged, never replaced', () => {
	const { paths } = profiles();
	write(editorSettingsPath(paths), '{\n\t// the shipped defaults\n\t"editor.fontSize": 13,\n\t"workbench.colorTheme": "Abyss"\n}\n');

	setTheme(paths, 'Monokai');

	const settings = JSON.parse(readFileSync(editorSettingsPath(paths), 'utf8'));
	assert.strictEqual(settings['editor.fontSize'], 13, 'the keys already there survive');
	assert.strictEqual(settings['workbench.colorTheme'], 'Monokai');
	assert.ok(existsSync(join(paths.userDataPath, 'User', 'settings.json')));
});

test('a settings file that cannot be read is left untouched instead of flattened', () => {
	const { paths } = profiles();
	const file = editorSettingsPath(paths);
	write(file, '{ this is not json');

	const outcome = writeEditorSettings(paths, { 'workbench.colorTheme': 'Monokai' });

	assert.strictEqual(outcome.written, false);
	assert.strictEqual(readFileSync(file, 'utf8'), '{ this is not json');
});

test('comment stripping leaves strings that contain slashes alone', () => {
	assert.strictEqual(stripJsonComments('{"url":"https://example.test/a//b"}'), '{"url":"https://example.test/a//b"}');
	assert.strictEqual(stripJsonComments('{\n// a comment\n"a":1\n}'), '{\n\n"a":1\n}');
	assert.strictEqual(stripJsonComments('{/* block */"a":1}'), '{"a":1}');
	// A comment that contains quotes must not start a string.
	assert.strictEqual(stripJsonComments('{"a":1} // it\'s "fine"\n'), '{"a":1} \n');
});

test('a comment-bearing settings file is read, not refused', () => {
	const { paths } = profiles();
	write(editorSettingsPath(paths), '{\n\t// mine\n\t"workbench.colorTheme": "Abyss" // the shipped one\n}\n');

	assert.strictEqual(readEditorSetting(paths, 'workbench.colorTheme'), 'Abyss');
	assert.deepStrictEqual(writeEditorSettings(paths, { 'editor.fontSize': 14 }), { written: true });
	assert.strictEqual(JSON.parse(readFileSync(editorSettingsPath(paths), 'utf8'))['editor.fontSize'], 14);
});

test('extra switches only write keys the product declares', () => {
	const { paths } = profiles();

	const applied = setExtras(paths, { mcp: true, context: false, somethingElse: true });

	assert.deepStrictEqual(applied, { mcp: true, context: false });
	const settings = JSON.parse(readFileSync(editorSettingsPath(paths), 'utf8'));
	assert.strictEqual(settings[EXTRA_SETTINGS['mcp']], true);
	assert.strictEqual(settings[EXTRA_SETTINGS['context']], false);
	assert.ok(!Object.keys(settings).some(key => key.includes('somethingElse')));
});

test('switching dictation on only leaves a note for the editor to act on', () => {
	const { paths } = profiles();
	assert.deepStrictEqual(setExtras(paths, { voice: true }), { voice: true });
	assert.strictEqual(JSON.parse(readFileSync(editorSettingsPath(paths), 'utf8'))['picode.voice.downloadOnStart'], true);
	assert.deepStrictEqual(setExtras(paths, { voice: false }), { voice: false });
	assert.strictEqual(JSON.parse(readFileSync(editorSettingsPath(paths), 'utf8'))['picode.voice.downloadOnStart'], false);
});

test('a value that is not a boolean is not written', () => {
	const { paths } = profiles();
	assert.deepStrictEqual(setExtras(paths, { mcp: 'yes' }), {});
	assert.strictEqual(readEditorSetting(paths, EXTRA_SETTINGS['mcp']), undefined);
});

test('the runtime is written where the editor reads it, and only the two values are accepted', () => {
	const { paths } = profiles();

	setRuntime(paths, 'external');
	assert.strictEqual(readEditorSetting(paths, 'picode.pi.runtime'), 'external');

	setRuntime(paths, 'internal');
	assert.strictEqual(readEditorSetting(paths, 'picode.pi.runtime'), 'internal');

	assert.throws(() => setRuntime(paths, 'whatever'), /internal or external/);
	assert.strictEqual(readEditorSetting(paths, 'picode.pi.runtime'), 'internal', 'the refused value changed nothing');
});

test('a theme with no name is refused rather than written', () => {
	const { paths } = profiles();
	assert.throws(() => setTheme(paths, '   '), /needs a name/);
	assert.ok(!existsSync(editorSettingsPath(paths)));
});

test('packages are declared once, and removed when taken off the list', () => {
	const { paths } = profiles();

	assert.deepStrictEqual(setPackages(paths, { add: ['npm:demo-pkg', 'npm:demo-pkg'] }), ['npm:demo-pkg']);
	assert.deepStrictEqual(setPackages(paths, { add: ['npm:other'] }), ['npm:demo-pkg', 'npm:other']);
	assert.deepStrictEqual(setPackages(paths, { remove: ['npm:demo-pkg'] }), ['npm:other']);
	assert.deepStrictEqual(readPackages(paths), ['npm:other']);
	assert.deepStrictEqual(JSON.parse(readFileSync(join(paths.profileDir, 'settings.json'), 'utf8'))['packages'], ['npm:other']);
});

test('the default model is written where pi and the chat both look for it', () => {
	const { paths } = profiles();

	setModel(paths, 'openrouter/deepseek/deepseek-chat');

	const profileSettings = JSON.parse(readFileSync(join(paths.profileDir, 'settings.json'), 'utf8'));
	assert.strictEqual(profileSettings['defaultProvider'], 'openrouter');
	assert.strictEqual(profileSettings['defaultModel'], 'openrouter/deepseek/deepseek-chat');
	assert.strictEqual(readEditorSetting(paths, 'chat.defaultModel'), 'openrouter/deepseek/deepseek-chat');
});

test('a default model that is not provider/model is refused', () => {
	const { paths } = profiles();
	assert.throws(() => setModel(paths, 'deepseek-chat'), /provider\/model/);
	assert.ok(!existsSync(join(paths.profileDir, 'settings.json')));
});

test('writing the profile settings keeps what was already in them', () => {
	const { paths } = profiles();
	write(join(paths.profileDir, 'settings.json'), JSON.stringify({ theme: 'picode', packages: ['npm:kept'] }));

	setModel(paths, 'groq/llama');

	const profileSettings = JSON.parse(readFileSync(join(paths.profileDir, 'settings.json'), 'utf8'));
	assert.strictEqual(profileSettings['theme'], 'picode');
	assert.deepStrictEqual(profileSettings['packages'], ['npm:kept']);
	assert.strictEqual(profileSettings['defaultModel'], 'groq/llama');
});
