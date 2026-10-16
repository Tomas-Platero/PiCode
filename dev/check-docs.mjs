#!/usr/bin/env node
// dev/check-docs.mjs — the documentation rule for folders.
//
// Two checks, both cheap:
//
//   1. STATIC (always): every folder listed in REQUIRED still has a README.md.
//      A documented folder that loses its file is a regression, not a style nit.
//
//   2. DIFF (--base <ref>): every folder NEW since that ref has a README.md.
//      New code in an existing folder does not trigger it; only a new folder
//      does, and the usual self-evident names (src, test, media, win32, ...)
//      inherit their parent's README instead of needing their own.
//
// Exemptions: .docsignore at the repository root, one path prefix per line,
// '#' for comments.
//
//   node dev/check-docs.mjs                 # static only (what CI runs on push)
//   node dev/check-docs.mjs --base origin/master   # static + new folders
//
// Exit 0 = fine, exit 1 = a folder needs its README.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The folders whose README is part of the contract. Losing one fails the check.
const REQUIRED = [
	'.github',
	'assets',
	'builder',
	'cloud',
	'cloud/sync-api',
	'dev',
	'dev/release-notes',
	'distribution',
	'docs',
	'upstream',
	'updates',
	'updates/experimental',
	'picode-source',
	'picode-source/src',
	'picode-source/cli',
	'picode-source/extensions',
	'picode-source/extensions/picode',
];

// Names that carry their parent's README rather than their own.
const INHERITS_PARENT = new Set([
	'src', 'lib', 'test', 'tests', 'media', 'fixtures', 'i18n', 'locales',
	'images', 'icons', 'fonts', 'examples', 'samples', 'Assets', 'typings',
	'workflows', 'ISSUE_TEMPLATE', 'docs', 'win32', 'linux', 'darwin', 'x64',
	'arm64',
]);

// Upstream or generated: never documented here. extensions/ keeps its one
// exception because extensions/picode is ours.
const UPSTREAM = [
	'picode-source/src',
	'picode-source/cli',
	'picode-source/build',
	'picode-source/scripts',
	'picode-source/resources',
	'picode-source/remote',
];

const MAX_DEPTH = 4;   // deeper folders inherit their ancestors' README

// Returns null instead of throwing: a checkout without git (or a ref that
// could not be fetched) degrades to "no diff", never to a crashed check.
const git = (cmd) => {
	try {
		return execSync(cmd, { cwd: ROOT, maxBuffer: 1 << 28 }).toString()
			.split('\n').filter(Boolean);
	} catch {
		return null;
	}
};

const ancestors = (files) => {
	const dirs = new Set();
	for (const f of files) {
		const parts = f.split('/');
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
	}
	return dirs;
};

const readExemptions = () => {
	try {
		return fs.readFileSync(path.join(ROOT, '.docsignore'), 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('#'));
	} catch {
		return [];
	}
};

const isUpstream = (dir) => UPSTREAM.some((u) => dir === u || dir.startsWith(`${u}/`));

const hasReadme = (dir) => {
	try {
		return fs.statSync(path.join(ROOT, dir, 'README.md')).size > 0;
	} catch {
		return false;
	}
};

function main() {
	const argv = process.argv.slice(2);
	const baseIdx = argv.indexOf('--base');
	const base = baseIdx === -1 ? null : argv[baseIdx + 1];
	const exemptions = readExemptions();
	const exempt = (dir) => exemptions.some((e) => dir === e || dir.startsWith(`${e}/`));

	const problems = [];

	// 1. The documented folders keep their README.
	for (const dir of REQUIRED) {
		if (!hasReadme(dir)) problems.push(`${dir}/  — listed in REQUIRED but has no README.md`);
	}

	// 2. Folders new since the base ref come with a README.
	if (base) {
		// --others so a folder created but not committed yet is caught locally too
		// (in CI every file is committed, and the flag changes nothing).
		const headFiles = git('git ls-files --cached --others --exclude-standard');
		const baseFiles = git(`git ls-tree -r --name-only ${base}`);
		if (!headFiles || !baseFiles) {
			console.error(`docs: could not read "${base}"; running the static check only.`);
		} else {
			const baseDirs = ancestors(baseFiles);
			const newDirs = [...ancestors(headFiles)]
				.filter((d) => !baseDirs.has(d))
				.sort();
			for (const dir of newDirs) {
				if (dir.split('/').length > MAX_DEPTH) continue;
				if (INHERITS_PARENT.has(path.basename(dir))) continue;
				if (dir === 'picode-source' || dir.startsWith('picode-source/extensions/picode/')) continue;
				if (isUpstream(dir)) continue;
				if (exempt(dir)) continue;
				if (!hasReadme(dir)) {
					problems.push(`${dir}/  — new folder without a README.md`);
				}
			}
		}
	}

	if (problems.length) {
		console.error('docs: folder documentation is missing.\n');
		for (const p of problems) console.error(`  ✗ ${p}`);
		console.error('\nEvery folder says what it does in one paragraph: see docs/MAPA.md.');
		console.error('Need an exemption? Add the path to .docsignore.');
		process.exit(1);
	}

	console.log(`docs: ${REQUIRED.length} documented folders ok${base ? `, no undocumented new folders since ${base}` : ''}.`);
}

main();
