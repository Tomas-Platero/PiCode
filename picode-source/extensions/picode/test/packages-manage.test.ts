/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Managing the packages pi declares, run on their own.
 *
 * The fixtures are the shapes on disk in a real profile: a `settings.json` the owner also
 * keeps other settings in, the project's `.pi/settings.json` beside it, and no file at all.
 * What matters — that removing or adding one declaration leaves every other setting and the
 * file's own formatting exactly as it was, that the disabled record is a plain object of
 * per-profile source lists, and that a listing marks a disabled package Disabled without
 * dropping it — needs no editor and no pi process.
 */

import assert from 'assert';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

/**
 * Why the imports below arrive through a hook and not a plain statement.
 *
 * Running a `.ts` file directly, Node strips types but resolves imports as ESM — and ESM has
 * no extensionless resolution, so `packages-manage.ts`'s `from './packages-data'` (which the
 * compiler requires extensionless) cannot be found. The hook adds the extension the runtime
 * needs for exactly the relative specifiers that lack one, in this test process only; the
 * compiled build is untouched.
 */
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const {
	DISABLED_PACKAGES_KEY,
	disablePackageSource,
	disabledRecordWith,
	disabledRecordWithout,
	enablePackageSource,
	packageDisplayInfo,
	packageInstallPaths,
	packagesArrayWith,
	packagesArrayWithout,
	profileSettingsFile,
	workspaceSettingsFile,
} = await import('../src/packages-manage.ts');

const { projectPackageScope, userPackageScope } = await import('../src/packages-data.ts');

import * as path from 'node:path';

/** A profile settings file the owner also keeps other settings in. */
const PROFILE_SETTINGS = [
	'{',
	'  "theme": "dark",',
	'  "packages": [',
	'    "npm:pi-lens",',
	'    "git:github.com/user/repo"',
	'  ],',
	'  "mcpServers": {',
	'    "files": {',
	'      "command": "node"',
	'    }',
	'  }',
	'}',
	'',
].join('\n');

/** A project settings file declaring one package of its own. */
const WORKSPACE_SETTINGS = [
	'{',
	'  "packages": [',
	'    "npm:pi-lens",',
	'    "./local-package"',
	'  ],',
	'  "autoupdate": true',
	'}',
	'',
].join('\n');

test('the disabled record key is stable, because the page and the commands must agree on it', () => {
	assert.strictEqual(DISABLED_PACKAGES_KEY, 'picode.disabledPackages');
});

test('disable removes the declaration from the profile settings and preserves every other key', () => {
	const files = new Map<string, string>([[profileSettingsFile('/profile'), PROFILE_SETTINGS]]);
	const fs = fakeFs(files);
	const result = disablePackageSource('npm:pi-lens', {
		profileDir: '/profile',
		workspaceDirs: [],
		fs,
		record: {},
	});

	assert.deepStrictEqual(result.changedFiles, [profileSettingsFile('/profile')]);
	const written = JSON.parse(files.get(profileSettingsFile('/profile'))!);
	assert.deepStrictEqual(Object.keys(written).sort(), ['mcpServers', 'packages', 'theme']);
	assert.deepStrictEqual(written.packages, ['git:github.com/user/repo']);
	assert.deepStrictEqual(written.mcpServers, { files: { command: 'node' } });
	assert.strictEqual(written.theme, 'dark');
	// The file's own style survives: two-space indent, final newline.
	assert.strictEqual(files.get(profileSettingsFile('/profile'))!.endsWith('\n'), true);
	assert.strictEqual(files.get(profileSettingsFile('/profile'))!.includes('  "theme"'), true);
	// The source is remembered so the listing can still show the package and enable can restore it.
	assert.deepStrictEqual(result.record, { '/profile': ['npm:pi-lens'] });
});

test('disable removes the declaration from the workspace settings when it is declared there', () => {
	const files = new Map<string, string>([[workspaceSettingsFile('/project'), WORKSPACE_SETTINGS]]);
	const fs = fakeFs(files);
	const result = disablePackageSource('./local-package', {
		profileDir: '/profile',
		workspaceDirs: ['/project'],
		fs,
		record: {},
	});

	assert.deepStrictEqual(result.changedFiles, [workspaceSettingsFile('/project')]);
	const written = JSON.parse(files.get(workspaceSettingsFile('/project'))!);
	assert.deepStrictEqual(written.packages, ['npm:pi-lens']);
	assert.strictEqual(written.autoupdate, true);
	assert.deepStrictEqual(result.record, { '/profile': ['./local-package'] });
});

test('disable declared in both scopes removes it from both and leaves a file without it untouched', () => {
	const files = new Map<string, string>([
		[profileSettingsFile('/profile'), PROFILE_SETTINGS],
		[workspaceSettingsFile('/project'), WORKSPACE_SETTINGS],
	]);
	const fs = fakeFs(files);
	const result = disablePackageSource('npm:pi-lens', {
		profileDir: '/profile',
		workspaceDirs: ['/project'],
		fs,
		record: {},
	});

	assert.deepStrictEqual(result.changedFiles.toSorted(), [profileSettingsFile('/profile'), workspaceSettingsFile('/project')]);
	assert.deepStrictEqual(JSON.parse(files.get(profileSettingsFile('/profile'))!).packages, ['git:github.com/user/repo']);
	assert.deepStrictEqual(JSON.parse(files.get(workspaceSettingsFile('/project'))!).packages, ['./local-package']);
});

test('disable records the source once per profile and never duplicates it', () => {
	const record = disabledRecordWith(disabledRecordWith({}, '/profile', 'npm:pi-lens'), '/profile', 'npm:pi-lens');
	assert.deepStrictEqual(record, { '/profile': ['npm:pi-lens'] });
	assert.deepStrictEqual(disabledRecordWithout(record, '/profile', 'npm:pi-lens'), {});
});

test('disable leaves a missing or malformed settings file alone', () => {
	const files = new Map<string, string>([[profileSettingsFile('/profile'), '{broken']]);
	const fs = fakeFs(files);
	const result = disablePackageSource('npm:pi-lens', { profileDir: '/profile', workspaceDirs: [], fs, record: {} });
	assert.deepStrictEqual(result.changedFiles, []);
	// The malformed file was not overwritten: disabling must never destroy settings it cannot read.
	assert.strictEqual(files.get(profileSettingsFile('/profile')), '{broken');
});

test('enable adds the source back to the profile settings, creating the file when it is missing', () => {
	const files = new Map<string, string>();
	const fs = fakeFs(files);
	const result = enablePackageSource('npm:pi-lens', {
		profileDir: '/profile',
		workspaceDirs: [],
		fs,
		record: { '/profile': ['npm:pi-lens'] },
	});

	assert.deepStrictEqual(result.changedFiles, [profileSettingsFile('/profile')]);
	assert.deepStrictEqual(JSON.parse(files.get(profileSettingsFile('/profile'))!), { packages: ['npm:pi-lens'] });
	assert.deepStrictEqual(result.record, {});
});

test('enable restores the declaration beside the settings that are already there', () => {
	const files = new Map<string, string>([[profileSettingsFile('/profile'), PROFILE_SETTINGS]]);
	const fs = fakeFs(files);
	const result = enablePackageSource('npm:pi-lens', { profileDir: '/profile', workspaceDirs: [], fs, record: { '/profile': ['npm:pi-lens'] } });

	assert.deepStrictEqual(JSON.parse(files.get(profileSettingsFile('/profile'))!).packages, ['npm:pi-lens', 'git:github.com/user/repo']);
	assert.deepStrictEqual(JSON.parse(files.get(profileSettingsFile('/profile'))!).theme, 'dark');
	assert.deepStrictEqual(result.record, {});
});

test('enable of a source that is already declared changes nothing', () => {
	const files = new Map<string, string>([[profileSettingsFile('/profile'), PROFILE_SETTINGS]]);
	const fs = fakeFs(files);
	const result = enablePackageSource('git:github.com/user/repo', { profileDir: '/profile', workspaceDirs: [], fs, record: {} });
	assert.deepStrictEqual(result.changedFiles, []);
	assert.strictEqual(files.get(profileSettingsFile('/profile')), PROFILE_SETTINGS);
});

test('the array editing helpers agree with the flows that use them', () => {
	const without = packagesArrayWithout(PROFILE_SETTINGS, 'npm:pi-lens');
	assert.strictEqual(without.changed, true);
	assert.deepStrictEqual(JSON.parse(without.text).packages, ['git:github.com/user/repo']);

	const withAdded = packagesArrayWith(without.text, 'npm:pi-lens');
	assert.strictEqual(withAdded.changed, true);
	assert.deepStrictEqual(JSON.parse(withAdded.text).packages, ['git:github.com/user/repo', 'npm:pi-lens']);

	// Adding what is already there, and removing what is not, change nothing.
	assert.strictEqual(packagesArrayWith(PROFILE_SETTINGS, 'npm:pi-lens').changed, false);
	assert.strictEqual(packagesArrayWithout(PROFILE_SETTINGS, 'npm:other').changed, false);

	// A declaration written as an object with a `source` is removed like a string one.
	const objectForm = '{"packages":["npm:a",{"source":"npm:b"}]}';
	assert.deepStrictEqual(JSON.parse(packagesArrayWithout(objectForm, 'npm:b').text).packages, ['npm:a']);

	// A missing file grows a minimal packages array; a broken one is refused.
	assert.deepStrictEqual(JSON.parse(packagesArrayWith(undefined, 'npm:a').text), { packages: ['npm:a'] });
	assert.strictEqual(packagesArrayWith('{broken', 'npm:a').changed, false);
	assert.strictEqual(packagesArrayWithout(undefined, 'npm:a').changed, false);
});

test('install paths cover the profile scope and every workspace scope', () => {
	assert.deepStrictEqual(packageInstallPaths('npm:pi-lens', '/profile', ['/project']), [
		path.join('/profile', 'npm', 'node_modules', 'pi-lens'),
		path.join('/project', '.pi', 'npm', 'node_modules', 'pi-lens'),
	]);
	assert.deepStrictEqual(packageInstallPaths('git:github.com/user/repo', '/profile', []), [
		path.join('/profile', 'git', 'github.com', 'user', 'repo'),
	]);
	assert.deepStrictEqual(packageInstallPaths('./local-package', '/profile', ['/project']), [
		path.join('/profile', 'local-package'),
		path.join('/project', 'local-package'),
	]);
	assert.deepStrictEqual(packageInstallPaths('npm:', '/profile', []), []);
});

test('the listing marks a declared package Enabled with its source and scope', () => {
	// The listing keys by the directory the scan resolved — built with the runtime's own
	// path rules, so the fixtures build theirs the same way.
	const dir = path.join('/profile', 'npm', 'node_modules', 'pi-lens');
	const info = packageDisplayInfo(
		[packageAt(dir, 'pi-lens', '1.2.0')],
		[userPackageScope('/profile', settingsOf(PROFILE_SETTINGS))],
		{},
		'/profile',
	);

	assert.deepStrictEqual(info.get(dir), {
		source: 'npm:pi-lens',
		state: 'enabled',
		scope: 'user',
	});
});

test('the listing still shows a disabled package, marked Disabled', () => {
	const dir = path.join('/profile', 'npm', 'node_modules', 'pi-lens');
	const disabled = packageAt(dir, 'pi-lens', '1.2.0');
	const info = packageDisplayInfo(
		[disabled],
		[userPackageScope('/profile', settingsOf(PROFILE_SETTINGS.replace('"npm:pi-lens",', '')))],
		{ '/profile': ['npm:pi-lens'] },
		'/profile',
	);

	// The declaration is gone from the settings, but the disabled record brings the row back.
	assert.deepStrictEqual(info.get(dir), {
		source: 'npm:pi-lens',
		state: 'disabled',
		scope: 'user',
	});
});

test('the listing reads the scope from where the declaration was found', () => {
	const dir = path.join('/project', 'local-package');
	const workspacePackage = packageAt(dir, 'local-package');
	const info = packageDisplayInfo(
		[workspacePackage],
		[
			userPackageScope('/profile', settingsOf(PROFILE_SETTINGS)),
			projectPackageScope('/project', settingsOf(WORKSPACE_SETTINGS)),
		],
		{},
		'/profile',
	);

	assert.deepStrictEqual(info.get(dir), {
		source: './local-package',
		state: 'enabled',
		scope: 'workspace',
	});
});

test('a package with no declaration and no record stays in the listing, Enabled', () => {
	const dir = path.join('/profile', 'npm', 'node_modules', 'orphan');
	const orphan = packageAt(dir, 'orphan');
	const info = packageDisplayInfo([orphan], [userPackageScope('/profile', settingsOf(PROFILE_SETTINGS))], {}, '/profile');
	// No source of its own, but the scope still reads from where its files live.
	assert.deepStrictEqual(info.get(dir), { state: 'enabled', scope: 'user' });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A fake filesystem over a map: the flows read and write exactly the files the map holds. */
function fakeFs(files: Map<string, string>) {
	return {
		readText: (file: string) => files.get(file),
		writeText: (file: string, text: string) => void files.set(file, text),
		exists: (file: string) => files.has(file),
	};
}

function settingsOf(text: string): Record<string, unknown> {
	return JSON.parse(text) as Record<string, unknown>;
}

/** One package as the listing receives it from the disk scan. */
function packageAt(dir: string, name: string, version?: string): {
	id: string;
	name: string;
	path: string;
	version?: string;
} {
	return version === undefined ? { id: name, name, path: dir } : { id: name, name, path: dir, version };
}
