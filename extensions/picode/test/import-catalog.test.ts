/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Import window's engine, run against throwaway folders: what each source offers item by
 * item, and that only the ticked items arrive and nothing PiCode already has is replaced.
 */

import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { applyPiImport, applyVsCodeImport, scanPiProfile, scanVsCode, readPendingExtensions } = await import('../src/import-catalog.ts');

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'picode-import-'));
}

function write(file: string, value: unknown): void {
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function read(file: string): any {
	return JSON.parse(readFileSync(file, 'utf8'));
}

function piProfile(root: string): string {
	const dir = join(root, 'pi');
	write(join(dir, 'settings.json'), { theme: 'dark', packages: ['npm:gentle-pi@4.7.0', { source: 'npm:pi-tools@1.0.0' }, 'npm:pi-memory'] });
	write(join(dir, 'models.json'), { providers: { openai: { key: 'a' }, local: { url: 'http://x' } } });
	write(join(dir, 'mcp.json'), { mcpServers: { git: { command: 'git' }, web: { command: 'web' } } });
	write(join(dir, 'skills', 'review', 'SKILL.md'), '# review');
	write(join(dir, 'skills', 'deploy', 'SKILL.md'), '# deploy');
	write(join(dir, 'memory', 'a.md'), 'm');
	write(join(dir, 'auth.json'), { openai: { token: 't' } });
	return dir;
}

test('the pi scan lists packages one by one and hides the ones the product leaves behind', () => {
	const catalog = scanPiProfile(piProfile(scratch()));
	const packages = catalog.categories.find(category => category.id === 'packages');
	assert.deepStrictEqual(packages?.items.map(item => item.id), ['npm:gentle-pi@4.7.0', 'npm:pi-tools@1.0.0']);
	assert.strictEqual(packages?.items[0].label, 'gentle-pi');
	assert.strictEqual(packages?.items[0].detail, '4.7.0');
	assert.strictEqual(catalog.categories.find(category => category.id === 'providers')?.count, 2);
	assert.strictEqual(catalog.categories.find(category => category.id === 'logins')?.sensitive, true);
});

test('a missing pi profile is an empty catalog, not an error', () => {
	const catalog = scanPiProfile(join(scratch(), 'nope'));
	assert.strictEqual(catalog.found, false);
	assert.deepStrictEqual(catalog.categories, []);
});

test('only the ticked pi items arrive, and what PiCode has stays', () => {
	const root = scratch();
	const from = piProfile(root);
	const to = join(root, 'picode');
	write(join(to, 'settings.json'), { theme: 'light', packages: ['npm:pi-tools@2.0.0'] });
	write(join(to, 'mcp.json'), { mcpServers: { git: { command: 'mine' } } });

	const result = applyPiImport({
		from,
		to,
		choice: { packages: ['npm:gentle-pi@4.7.0', 'npm:pi-tools@1.0.0'], preferences: 'all', mcp: ['git', 'web'], skills: ['review'], providers: ['local'] },
	});

	const settings = read(join(to, 'settings.json'));
	assert.deepStrictEqual(settings.packages, ['npm:pi-tools@2.0.0', 'npm:gentle-pi@4.7.0']);
	assert.strictEqual(settings.theme, 'light');
	assert.deepStrictEqual(Object.keys(read(join(to, 'mcp.json')).mcpServers), ['git', 'web']);
	assert.strictEqual(read(join(to, 'mcp.json')).mcpServers.git.command, 'mine');
	assert.deepStrictEqual(Object.keys(read(join(to, 'models.json')).providers), ['local']);
	assert.ok(existsSync(join(to, 'skills', 'review', 'SKILL.md')));
	assert.ok(!existsSync(join(to, 'skills', 'deploy')));
	assert.ok(!existsSync(join(to, 'auth.json')), 'logins were not ticked');
	assert.ok(!existsSync(join(to, 'memory')), 'memory was not ticked');
	assert.strictEqual(result.categories.find(category => category.category === 'packages')?.skipped, 1);
});

test('logins and memory come across only as whole categories', () => {
	const root = scratch();
	const from = piProfile(root);
	const to = join(root, 'picode');
	applyPiImport({ from, to, choice: { logins: 'all', memory: 'all' } });
	assert.strictEqual(read(join(to, 'auth.json')).openai.token, 't');
	assert.ok(existsSync(join(to, 'memory', 'a.md')));
});

test('a skill id that climbs out of the skills folder is never copied', () => {
	const root = scratch();
	const from = piProfile(root);
	write(join(root, 'secret', 'x.txt'), 'x');
	const to = join(root, 'picode');
	applyPiImport({ from, to, choice: { skills: ['../secret'] } });
	assert.ok(!existsSync(join(to, 'secret')));
});

function vscodeMachine(root: string): { home: string; appData: string } {
	const home = join(root, 'home');
	const appData = join(root, 'appdata');
	write(join(appData, 'Code', 'User', 'settings.json'), '{ // mine\n "editor.fontSize": 18, "update.mode": "none", "files.autoSave": "afterDelay" }');
	write(join(appData, 'Code', 'User', 'keybindings.json'), [{ key: 'ctrl+k', command: 'a' }, { key: 'ctrl+j', command: 'b' }]);
	write(join(appData, 'Code', 'User', 'snippets', 'js.json'), { x: {} });
	const extensions = join(home, '.vscode', 'extensions');
	write(join(extensions, 'extensions.json'), [
		{ identifier: { id: 'dracula-theme.theme-dracula' }, version: '2.0.0', relativeLocation: 'dracula-theme.theme-dracula-2.0.0' },
		{ identifier: { id: 'esbenp.prettier-vscode' }, version: '10.0.0', relativeLocation: 'esbenp.prettier-vscode-10.0.0' },
		{ identifier: { id: 'GitHub.copilot' }, version: '1.0.0' },
	]);
	write(join(extensions, 'dracula-theme.theme-dracula-2.0.0', 'package.json'), { contributes: { themes: [{ label: 'Dracula' }] } });
	write(join(extensions, 'esbenp.prettier-vscode-10.0.0', 'package.json'), { contributes: {} });
	return { home, appData };
}

test('the VS Code scan separates themes from extensions and skips machine settings and Copilot', () => {
	const roots = vscodeMachine(scratch());
	const [catalog] = scanVsCode(roots);
	assert.strictEqual(catalog.name, 'Visual Studio Code');
	const byId = (id: string) => catalog.categories.find(category => category.id === id);
	assert.deepStrictEqual(byId('themes')?.items.map(item => item.id), ['dracula-theme.theme-dracula']);
	assert.deepStrictEqual(byId('extensions')?.items.map(item => item.id), ['esbenp.prettier-vscode']);
	assert.deepStrictEqual(byId('editorSettings')?.items.map(item => item.id), ['editor.fontSize', 'files.autoSave']);
	assert.strictEqual(byId('keybindings')?.count, 2);
});

test('no VS Code installed is no catalog', () => {
	assert.deepStrictEqual(scanVsCode({ home: join(scratch(), 'h'), appData: join(scratch(), 'a') }), []);
});

test('VS Code settings, shortcuts and snippets arrive without replacing what PiCode has', () => {
	const root = scratch();
	const roots = vscodeMachine(root);
	const userDataPath = join(root, 'picode-data');
	write(join(userDataPath, 'User', 'settings.json'), { 'editor.fontSize': 12 });
	write(join(userDataPath, 'User', 'keybindings.json'), [{ key: 'ctrl+k', command: 'a' }]);
	const paths = { distributionRoot: root, profileDir: join(root, 'profile'), userDataPath };

	const result = applyVsCodeImport({
		product: 'code',
		roots,
		paths,
		choice: { editorSettings: ['editor.fontSize', 'files.autoSave', 'update.mode'], keybindings: 'all', snippets: ['js.json'], themes: ['dracula-theme.theme-dracula'], extensions: ['not a valid id!'] },
	});

	assert.deepStrictEqual(read(join(userDataPath, 'User', 'settings.json')), { 'editor.fontSize': 12, 'files.autoSave': 'afterDelay' });
	assert.deepStrictEqual(read(join(userDataPath, 'User', 'keybindings.json')), [{ key: 'ctrl+k', command: 'a' }, { key: 'ctrl+j', command: 'b' }]);
	assert.ok(existsSync(join(userDataPath, 'User', 'snippets', 'js.json')));
	assert.deepStrictEqual(result.queuedExtensions, ['dracula-theme.theme-dracula']);
	assert.deepStrictEqual(readPendingExtensions(userDataPath), ['dracula-theme.theme-dracula']);
});

test('an unreadable PiCode settings file is left untouched', () => {
	const root = scratch();
	const roots = vscodeMachine(root);
	const userDataPath = join(root, 'picode-data');
	write(join(userDataPath, 'User', 'settings.json'), '{ broken');
	const result = applyVsCodeImport({ product: 'code', roots, paths: { distributionRoot: root, profileDir: join(root, 'p'), userDataPath }, choice: { editorSettings: ['files.autoSave'] } });
	assert.strictEqual(result.categories[0].status, 'failed');
	assert.strictEqual(readFileSync(join(userDataPath, 'User', 'settings.json'), 'utf8'), '{ broken');
});

test('the host answers the Import window\'s two commands (a command the switch does not know is an error)', async () => {
	const { runHostCommand } = await import('../src/onboarding-host.ts');
	const root = scratch();
	const paths = { distributionRoot: root, profileDir: join(root, 'profile'), userDataPath: join(root, 'data') };
	const scan: any = await runHostCommand(paths, 'importScan', { profile: piProfile(root) });
	assert.strictEqual(scan.pi.found, true);
	assert.ok(Array.isArray(scan.vscode));
	const applied: any = await runHostCommand(paths, 'importApply', { source: 'pi', profile: piProfile(root), choice: { skills: ['review'], logins: 'nope', junk: 5 } });
	assert.ok(existsSync(join(paths.profileDir, 'skills', 'review', 'SKILL.md')));
	assert.ok(!existsSync(join(paths.profileDir, 'auth.json')), 'a malformed logins value is not "all"');
	assert.strictEqual(applied.categories[0].category, 'skills');
});
