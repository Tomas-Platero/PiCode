/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The package list, run on its own.
 *
 * The fixtures mirror a real profile: `settings.json` declares `npm:gentle-pi` and
 * `npm:gentle-engram`, and the `node_modules` those installs created holds ninety-five
 * directories of which only three are pi packages. Telling those three apart from a transitive
 * dependency — and from a declaration that was never installed — is the whole job, and it needs no
 * editor.
 */

import assert from 'assert';
import { test } from 'node:test';
import type { DirectoryEntry, FsReader } from '../src/customizations.ts';
import {
	installedPackages,
	isPiPackage,
	packageSkillDirs,
	parsePackageSource,
	parseSettings,
	piPackages,
	projectPackageScope,
	userPackageScope,
} from '../src/packages-data.ts';

/**
 * A made-up filesystem, keyed by `/`-separated paths: the discovery builds paths with `path.join`,
 * which uses `\` on Windows, and a test of a walk must not depend on which machine runs it.
 */
function fakeFs(files: Readonly<Record<string, string>>): FsReader {
	const normalized = new Map(Object.entries(files).map(([key, value]) => [toPosix(key), value]));
	return {
		entries(dir) {
			const prefix = `${toPosix(dir)}/`;
			const found = new Map<string, boolean>();
			for (const key of normalized.keys()) {
				if (!key.startsWith(prefix)) {
					continue;
				}
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf('/');
				found.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
			}
			return [...found].map(([name, directory]): DirectoryEntry => ({ name, directory })).sort((left, right) => left.name.localeCompare(right.name));
		},
		text: file => normalized.get(toPosix(file)),
		exists: target => {
			const wanted = toPosix(target);
			return normalized.has(wanted) || [...normalized.keys()].some(key => key.startsWith(`${wanted}/`));
		},
	};
}

function toPosix(target: string): string {
	return target.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The manifest of a real pi package: gentle-pi's own keys and paths. */
function manifest(name: string, extra: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({ name, version: '1.0.0', description: `${name} for pi`, keywords: ['pi-package'], ...extra });
}

const PROFILE = '/profile';
const FOLDER = '/project';

/* ------------------------------------------------------------------ *
 * The declarations
 * ------------------------------------------------------------------ */

test('parsePackageSource classifies the four spellings pi accepts', () => {
	assert.deepStrictEqual(parsePackageSource('npm:gentle-pi'), { kind: 'npm', name: 'gentle-pi', spec: 'gentle-pi' });
	assert.deepStrictEqual(parsePackageSource('npm:@scope/pkg@1.2.3'), { kind: 'npm', name: '@scope/pkg', spec: '@scope/pkg@1.2.3' });
	assert.deepStrictEqual(parsePackageSource('git:github.com/example/pi-tools@v1'), {
		kind: 'git',
		host: 'github.com',
		path: 'example/pi-tools',
		spec: 'git:github.com/example/pi-tools@v1',
	});
	assert.deepStrictEqual(parsePackageSource('./local-package'), { kind: 'local', path: './local-package', spec: './local-package' });
	// The object form of a settings entry carries the source as its `source` key.
	assert.deepStrictEqual(parsePackageSource({ source: 'npm:gentle-pi', skills: [] }), { kind: 'npm', name: 'gentle-pi', spec: 'gentle-pi' });
});

test('parsePackageSource refuses what it cannot resolve to a directory', () => {
	assert.strictEqual(parsePackageSource(undefined), undefined);
	assert.strictEqual(parsePackageSource(42), undefined);
	assert.strictEqual(parsePackageSource({ skills: [] }), undefined);
	assert.strictEqual(parsePackageSource('   '), undefined);
	// A `file:` URL is a local path for pi; rewriting a URL into a path here would be a guess.
	assert.strictEqual(parsePackageSource('file:///tmp/pkg'), undefined);
	// A git source with no repository path is not one either.
	assert.strictEqual(parsePackageSource('git:github.com'), undefined);
});

test('parseSettings reads the file pi writes, and refuses a malformed or non-object one', () => {
	// The shape on disk in a real profile.
	const settings = parseSettings('{\n\t"packages": [\n\t\t"npm:gentle-pi",\n\t\t"npm:gentle-engram"\n\t]\n}');
	assert.deepStrictEqual(settings?.['packages'], ['npm:gentle-pi', 'npm:gentle-engram']);

	assert.strictEqual(parseSettings(undefined), undefined);
	assert.strictEqual(parseSettings('{ half'), undefined);
	assert.strictEqual(parseSettings('["npm:gentle-pi"]'), undefined);
});

test('the two scopes install where pi installs', () => {
	const user = userPackageScope(PROFILE, parseSettings('{}'));
	assert.strictEqual(toPosix(user.npmRoot), '/profile/npm/node_modules');
	assert.strictEqual(toPosix(user.gitRoot), '/profile/git');

	const project = projectPackageScope(FOLDER, parseSettings('{}'));
	assert.strictEqual(toPosix(project.npmRoot), '/project/.pi/npm/node_modules');
	assert.strictEqual(toPosix(project.gitRoot), '/project/.pi/git');
});

/* ------------------------------------------------------------------ *
 * What is on disk
 * ------------------------------------------------------------------ */

test('a node_modules of dependencies yields only the packages that are pi packages', () => {
	const read = fakeFs({
		// The two the owner declared: a manifest, a keyword, conventional resource directories.
		'/profile/npm/node_modules/gentle-pi/package.json': manifest('gentle-pi', { pi: { skills: ['./skills'] } }),
		'/profile/npm/node_modules/gentle-pi/skills/gentle-ai/SKILL.md': '---\nname: gentle-ai\n---\nBody.',
		'/profile/npm/node_modules/gentle-engram/package.json': manifest('gentle-engram'),
		// A scoped third-party pi package, which is what pi-pretty is.
		'/profile/npm/node_modules/@heyhuynhgiabuu/pi-pretty/package.json': JSON.stringify({ name: '@heyhuynhgiabuu/pi-pretty', version: '0.6.27', keywords: ['pi-package'] }),
		// A package with no manifest signal, but with a conventional resource directory.
		'/profile/npm/node_modules/conventional/package.json': JSON.stringify({ name: 'conventional', version: '2.0.0' }),
		'/profile/npm/node_modules/conventional/prompts/review.md': 'A prompt.',
		// The transitive dependencies of the two: no `pi` key, no keyword, no resource directory.
		'/profile/npm/node_modules/agent-base/package.json': JSON.stringify({ name: 'agent-base', version: '7.1.0' }),
		'/profile/npm/node_modules/ansis/package.json': JSON.stringify({ name: 'ansis', version: '3.0.0', keywords: ['ansi', 'color'] }),
		'/profile/npm/node_modules/@aws/thing/package.json': JSON.stringify({ name: '@aws/thing', version: '1.0.0' }),
	});

	const packages = installedPackages('/profile/npm/node_modules', read);

	assert.deepStrictEqual(packages.map(found => found.name), ['@heyhuynhgiabuu/pi-pretty', 'conventional', 'gentle-engram', 'gentle-pi']);
	assert.strictEqual(packages[3].version, '1.0.0');
	assert.strictEqual(packages[3].description, 'gentle-pi for pi');
	assert.strictEqual(toPosix(packages[3].path), '/profile/npm/node_modules/gentle-pi');
});

test('isPiPackage needs a signal: a manifest, the keyword, or a resource directory', () => {
	const read = fakeFs({
		'/pkg/package.json': JSON.stringify({ name: 'pkg' }),
		'/pkg/skills/x/SKILL.md': '---\nname: x\n---\nBody.',
		'/deps/package.json': JSON.stringify({ name: 'dep', keywords: ['cli'] }),
	});

	assert.strictEqual(isPiPackage('/pkg', { name: 'pkg', pi: {} }, read), true);
	assert.strictEqual(isPiPackage('/pkg', { name: 'pkg', keywords: ['pi-package'] }, read), true);
	assert.strictEqual(isPiPackage('/pkg', { name: 'pkg' }, read), true);
	assert.strictEqual(isPiPackage('/deps', { name: 'dep', keywords: ['cli'] }, read), false);
	assert.strictEqual(isPiPackage('/nowhere', { name: 'gone' }, read), false);
	assert.strictEqual(isPiPackage('/pkg', undefined, read), false);
});

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

test('the declarations and the installed directories are one row per package', () => {
	const read = fakeFs({
		'/profile/package.json': '{}',
		'/profile/npm/node_modules/gentle-pi/package.json': manifest('gentle-pi'),
		'/profile/npm/node_modules/gentle-engram/package.json': manifest('gentle-engram'),
		'/profile/npm/node_modules/@heyhuynhgiabuu/pi-pretty/package.json': JSON.stringify({ name: '@heyhuynhgiabuu/pi-pretty', version: '0.6.27', keywords: ['pi-package'] }),
	});
	const scopes = [userPackageScope(PROFILE, parseSettings('{"packages":["npm:gentle-pi","npm:gentle-engram"]}'))];

	const result = piPackages(scopes, read);

	// gentle-pi and gentle-engram are declared *and* installed: one row each, not two.
	assert.deepStrictEqual(result.packages.map(found => found.name), ['@heyhuynhgiabuu/pi-pretty', 'gentle-engram', 'gentle-pi']);
	assert.deepStrictEqual(result.unresolved, []);
});

test('a declaration with nothing installed is reported, never listed', () => {
	const read = fakeFs({ '/profile/npm/node_modules/gentle-pi/package.json': manifest('gentle-pi') });
	const scopes = [userPackageScope(PROFILE, parseSettings('{"packages":["npm:gentle-pi","npm:not-installed"]}'))];

	const result = piPackages(scopes, read);

	assert.deepStrictEqual(result.packages.map(found => found.name), ['gentle-pi']);
	assert.deepStrictEqual(result.unresolved.map(toPosix), ['/profile/npm/node_modules/not-installed: declared, but nothing is installed there']);
});

test('a git checkout and a local package resolve to the directories pi keeps', () => {
	const read = fakeFs({
		'/profile/git/github.com/example/pi-tools/package.json': manifest('pi-tools'),
		'/profile/local-package/package.json': JSON.stringify({ name: 'local-package', version: '0.0.1', keywords: ['pi-package'] }),
	});
	const scopes = [userPackageScope(PROFILE, parseSettings('{"packages":["git:github.com/example/pi-tools@v1","./local-package"]}'))];

	const result = piPackages(scopes, read);

	assert.deepStrictEqual(result.packages.map(found => found.name), ['local-package', 'pi-tools']);
	assert.deepStrictEqual(result.unresolved, []);
});

test('a project package is looked for under the project, and the profile one under the profile', () => {
	const read = fakeFs({
		'/profile/npm/node_modules/gentle-pi/package.json': manifest('gentle-pi'),
		'/project/.pi/npm/node_modules/project-only/package.json': manifest('project-only'),
	});
	const scopes = [
		userPackageScope(PROFILE, parseSettings('{"packages":["npm:gentle-pi"]}')),
		projectPackageScope(FOLDER, parseSettings('{"packages":["npm:project-only"]}')),
	];

	const result = piPackages(scopes, read);

	assert.deepStrictEqual(result.packages.map(found => found.name), ['gentle-pi', 'project-only']);
	assert.deepStrictEqual(result.unresolved, []);
});

/* ------------------------------------------------------------------ *
 * The skills a package brings
 * ------------------------------------------------------------------ */

test('a package says where its skills are, or keeps them where pi looks', () => {
	const read = fakeFs({
		// gentle-pi declares `pi.skills: ["./skills"]`.
		'/pkgs/gentle-pi/package.json': manifest('gentle-pi', { pi: { skills: ['./skills'] } }),
		'/pkgs/gentle-pi/skills/gentle-ai/SKILL.md': '---\nname: gentle-ai\n---\nBody.',
		// A package that declares a glob: its literal part is the directory.
		'/pkgs/globbed/package.json': manifest('globbed', { pi: { skills: ['./resources/skills/*'] } }),
		'/pkgs/globbed/resources/skills/one/SKILL.md': '---\nname: one\n---\nBody.',
		// A package with no `pi` manifest at all: the conventional directory answers.
		'/pkgs/plain/package.json': manifest('plain'),
		'/pkgs/plain/skills/two/SKILL.md': '---\nname: two\n---\nBody.',
		// A package whose manifest points at nothing on disk contributes nothing.
		'/pkgs/broken/package.json': manifest('broken', { pi: { skills: ['./elsewhere'] } }),
	});

	assert.deepStrictEqual(packageSkillDirs('/pkgs/gentle-pi', read).map(toPosix), ['/pkgs/gentle-pi/skills']);
	assert.deepStrictEqual(packageSkillDirs('/pkgs/globbed', read).map(toPosix), ['/pkgs/globbed/resources/skills']);
	assert.deepStrictEqual(packageSkillDirs('/pkgs/plain', read).map(toPosix), ['/pkgs/plain/skills']);
	assert.deepStrictEqual(packageSkillDirs('/pkgs/broken', read), []);
});
