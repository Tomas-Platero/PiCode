#!/usr/bin/env node
/*
 * docs -- folder documentation.
 *
 * The rule from AGENTS.md made executable: every folder says what it does in one
 * README.md, and docs/MAPA.md is generated from those READMEs rather than written
 * by hand.
 *
 * Usage:
 *   node build/docs.mjs check
 *   node build/docs.mjs map
 *
 * One file per domain: the scripts that used to sit side by side in build/ were fused
 * here, each keeping its own explanation directly above the code it runs. Commands are
 * functions, so this file can also be imported (build/checks.mjs imports resolvePack)
 * without anything running.
 */

import { pathToFileURL } from 'node:url';
	// check -- was build/check-docs.mjs
	// build/docs.mjs check — the documentation rule for folders.
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
	//   node build/docs.mjs check                 # static only (what CI runs on push)
	//   node build/docs.mjs check --base origin/master   # static + new folders
	//
	// Exit 0 = fine, exit 1 = a folder needs its README.
	async function cmdCheck(cli) {
	const fs = (await import('node:fs')).default;
	const path = (await import('node:path')).default;
	const { execSync } = await import('node:child_process');
	const { fileURLToPath } = await import('node:url');
	const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

	// The folders whose README is part of the contract. Losing one fails the check.
	// updates/<channel> is deliberately absent: each branch carries a different one
	// (updates/stable, updates/beta, updates/experimental), so a name pinned here
	// would fail the moment this file runs on another channel's branch. The DIFF
	// half below still asks for a README the first time a channel's folder appears.
	const REQUIRED = [
		'.github',
		'build',
		'cli',
		'cloud',
		'cloud/sync-api',
		'docs',
		'durable',
		'durable-acp-client',
		'durable-bridge',
		'extensions',
		'extensions/picode',
		'resources/picode',
		'updates',
		'upstream',
	];

	// Names that carry their parent's README rather than their own.
	const INHERITS_PARENT = new Set([
		'src', 'lib', 'test', 'tests', 'media', 'fixtures', 'i18n', 'locales',
		'images', 'icons', 'fonts', 'examples', 'samples', 'Assets', 'typings',
		'workflows', 'ISSUE_TEMPLATE', 'docs', 'win32', 'linux', 'darwin', 'x64',
		'arm64',
		// The editor's own build tooling, inherited alongside build/'s README.
		'checker', 'checksums', 'codex', 'dictation-runtime', 'next', 'rspack',
		'vite', 'npm', 'agent-sdk', 'monaco', 'web',
	]);

	// The editor's own source, now living at the repository root, plus everything
	// generated or installed: none of it is ours to document folder by folder.
	// resources/ carries its one exception because resources/picode is ours, which
	// REQUIRED above still holds to its own README.
	const UPSTREAM = [
		'src',
		'cli',
		'scripts',
		'remote',
		'resources',
		'out',
		'out-build',
		'out-vscode-min',
		'bin',
		'obj',
		'node_modules',
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
		const argv = cli;
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
					if (dir.startsWith('extensions/picode/')) continue;
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
	}

	// map -- was build/map-docs.mjs
	// build/docs.mjs map — regenerate docs/MAPA.md, the map of the repository.
	//
	// Sources of truth, and the only two:
	//   - a folder's own README.md  -> its one-line description (the first paragraph)
	//   - ROOT_FILES below           -> the root-level files
	//
	// Only versioned content is mapped (`git ls-files`): local leftovers, build
	// output and dependencies never show up, so the map is the repository rather
	// than whatever happens to be on this disk.
	//
	// The tree is therefore documentation that cannot drift: a folder that gains a
	// README appears described on the next run, and a folder without one is listed
	// under the gaps instead of being silently skipped.
	//
	//   node build/docs.mjs map           # write docs/MAPA.md
	//   node build/docs.mjs map --stdout  # print, write nothing
	async function cmdMap(cli) {
	const fs = (await import('node:fs')).default;
	const path = (await import('node:path')).default;
	const { execSync } = await import('node:child_process');
	const { fileURLToPath } = await import('node:url');
	const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const OUT_REL = 'docs/MAPA.md';
	const MAX_DEPTH = 6;
	const DESC_MAX = 150;
	const FILES_PER_DIR = 24;

	// Generated trees, dependencies and packed output: never walked, never a gap.
	const SKIP_DIRS = new Set([
		'node_modules', 'out', 'out-build', 'out-vscode-min', 'bin', 'obj', 'dist',
		'.next', '.vercel', 'target', '__pycache__', '.ruff_cache', '.scratch',
		'.codegraph', '.atl', '.cache', '.git',
	]);

	// Dot entries are local state, not layout. Only these are part of the repo
	// story and shown at the root.
	const ROOT_DOT = new Set(['.github']);

	const skipDir = (name) =>
		SKIP_DIRS.has(name) || name.startsWith('out-') ||
		name.startsWith('PiCode-') || name.startsWith('.update');

	// What git tracks: files (exact) and every ancestor folder of a tracked file.
	const TRACKED = new Set();
	const TRACKED_DIRS = new Set();
	try {
		for (const f of execSync('git ls-files', { cwd: ROOT, maxBuffer: 1 << 28 }).toString().split('\n')) {
			if (!f) continue;
			TRACKED.add(f);
			const parts = f.split('/');
			for (let i = 1; i < parts.length; i++) TRACKED_DIRS.add(parts.slice(0, i).join('/'));
		}
	} catch {
		// Not a git checkout: map what is on disk instead of refusing to run.
		TRACKED.clear();
		TRACKED_DIRS.clear();
	}
	const gitAware = TRACKED.size > 0;

	// Folder names whose contents are self-evident (icons, fixtures, templates):
	// they inherit their parent's README and are not reported as gaps.
	const NOISE_DIRS = new Set([
		'media', 'test', 'tests', 'fixtures', 'i18n', 'locales', 'images', 'icons',
		'fonts', 'examples', 'samples', 'Assets', 'ISSUE_TEMPLATE', 'workflows',
		'typings', 'docs',
		// Self-evident names: they carry their parent's README instead of their own.
		'src', 'lib', 'win32', 'linux', 'darwin', 'x64', 'arm64',
	]);

	// Zones: how far the map opens a folder up.
	//   opaque        - upstream or generated bulk: the folder is named and described, its children are not listed
	//   only [names]  - mostly upstream with a list of the children that are ours
	const ZONES = {
		'src': { kind: 'opaque' },
		'cli': { kind: 'opaque' },
		'scripts': { kind: 'opaque' },
		'remote': { kind: 'opaque' },
		'resources': { kind: 'only', keep: ['picode'] },
		'extensions': { kind: 'only', keep: ['picode'] },
	};

	// Root-level files: one line each, stable names.
	const ROOT_FILES = {
		'.gitattributes': 'Git rules per file type (binaries, line endings).',
		'.gitignore': 'What is never versioned: dependencies, build output, keys, profiles.',
		'.gitleaks.toml': 'Settings for the secret scanner (Gitleaks) that runs in CI.',
		'.nvmrc': 'Node version pinned for the whole project (CI and the build read it).',
		'.pi-lens.json': 'What pi-lens does not lint: the upstream zones and the generated output.',
		'AGENTS.md': '📋 The owner\'s phrases: product, UI, architecture and working rules.',
		'CODE_OF_CONDUCT.md': '🤝 The repository\'s code of conduct.',
		'CONTRIBUTING.md': '🤝 How to contribute and how the tree of our own is published.',
		'LICENSE': 'The product\'s MIT license.',
		'README.md': '🌍 Public face: what PiCode is, downloads and how to build it.',
		'SECURITY.md': '🛡️ How to report a vulnerability.',
		'_typos.toml': 'False positives of the `typos` spell checker.',
		'repomix.config.json': 'Settings for the repository dump for LLMs.',
	};

	const strip = (md) => md
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // images
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // links -> text
		.replace(/[*_`~]/g, '')                     // emphasis markers
		.replace(/<[^>]+>/g, '')                    // html
		.replace(/\s+/g, ' ')
		.trim();

	const truncate = (s) => s.length <= DESC_MAX
		? s
		: s.slice(0, s.slice(0, DESC_MAX).lastIndexOf(' ') || DESC_MAX) + '…';

	// The README's first paragraph: skip the heading, take the block before the
	// next blank line or before a table/fence/heading breaks it.
	function firstParagraph(md) {
		const lines = md.split(/\r?\n/);
		let i = lines.findIndex((l) => /^#\s/.test(l));
		i = i === -1 ? 0 : i + 1;
		const out = [];
		for (; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) { if (out.length) break; continue; }
			if (/^(#|\||```|---|>)/.test(line)) break;
			out.push(line);
		}
		return out.join(' ');
	}

	function dirDesc(rel) {
		try {
			const md = fs.readFileSync(path.join(ROOT, rel, 'README.md'), 'utf8');
			const p = firstParagraph(md);
			return p ? truncate(strip(p)) : null;
		} catch {
			return null;
		}
	}

	function skipFile(name) {
		return name.startsWith('.') || name.endsWith('.tsbuildinfo') ||
			name.endsWith('.bak') || name.endsWith('.log');
	}

	function collect(rel, depth) {
		const abs = path.join(ROOT, rel);
		let entries;
		try {
			entries = fs.readdirSync(abs, { withFileTypes: true });
		} catch {
			return { dirs: [], files: [] };
		}
		const isRoot = depth === 0;
		const dirs = [];
		const files = [];
		for (const e of entries) {
			if (e.name.startsWith('.') && !(isRoot && ROOT_DOT.has(e.name))) continue;
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (skipDir(e.name)) continue;
				if (gitAware && !TRACKED_DIRS.has(child)) continue;
				dirs.push(e.name);
			} else if (!skipFile(e.name)) {
				if (gitAware && !TRACKED.has(child)) continue;
				files.push(e.name);
			}
		}
		dirs.sort((a, b) => a.localeCompare(b));
		files.sort((a, b) => a.localeCompare(b));
		return { dirs, files };
	}

	function isGap(rel, name) {
		if (rel.split('/').length > 2) return false;      // depth <= 2
		if (NOISE_DIRS.has(name)) return false;
		const child = rel ? `${rel}/${name}` : name;
		if (ZONES[rel] || ZONES[child]) return false;     // upstream zones speak for themselves
		return true;
	}

	function main() {
		const documented = [];
		const gaps = [];
		const tree = [];

		const walk = (rel, prefix, depth) => {
			const { dirs, files } = collect(rel, depth);
			const zone = ZONES[rel];

			let shownDirs = dirs;
			let zoneNote = null;
			if (zone?.kind === 'only') {
				shownDirs = dirs.filter((d) => zone.keep.includes(d));
				const other = dirs.length - shownDirs.length;
				if (other > 0) zoneNote = `… and ${other} upstream built-in extensions (only picode/ is ours)`;
			}

			const items = [
				...shownDirs.map((d) => ({ name: d, isDir: true })),
				...files.map((f) => ({ name: f, isDir: false })),
			];

			items.forEach((item, idx) => {
				const last = idx === items.length - 1 && !zoneNote;
				const branch = last ? '└── ' : '├── ';
				const childRel = rel ? `${rel}/${item.name}` : item.name;

				if (item.isDir) {
					const desc = dirDesc(childRel);
					const note = ZONES[childRel]?.kind === 'opaque' ? ' · ⬆️ upstream, no breakdown' : '';
					// Only depth 1-2 carries the warning: deeper folders inherit their parent's README.
					const shallow = rel.split('/').length <= 1;
					if (desc) {
						documented.push({ rel: childRel, desc });
						tree.push(`${prefix}${branch}${item.name}/ — ${desc}${note}`);
					} else {
						const gap = isGap(rel, item.name);
						if (gap) gaps.push(childRel);
						tree.push(`${prefix}${branch}${item.name}/${gap && shallow ? ' — ⚠️ no README' : note}`);
					}
					if (ZONES[childRel]?.kind !== 'opaque' && depth + 1 <= MAX_DEPTH) {
						walk(childRel, prefix + (last ? '    ' : '│   '), depth + 1);
					}
				} else {
					const desc = depth === 0 ? ROOT_FILES[item.name] : null;
					tree.push(`${prefix}${branch}${item.name}${desc ? ` — ${desc}` : ''}`);
				}
			});

			if (zoneNote) tree.push(`${prefix}└── ${zoneNote}`);
			if (files.length > FILES_PER_DIR) {
				tree.push(`${prefix}└── … ${files.length} files in total`);
			}
		};

		walk('', '', 0);

		const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
			.filter((e) => e.isFile() && ROOT_FILES[e.name])
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));

		const md = [
			'# 🗺️ Repository map',
			'',
			'> **Generated** with `node build/docs.mjs map` — do not edit by hand.',
			'> Each folder is described by **the first line of its own `README.md`**:',
			'> if it says "no README" here, the gap is listed below.',
			'',
			'## 📊 Status',
			'',
			`- **${documented.length}** folders documented · **${gaps.length}** without a README.`,
			'- Root files described: ' + rootFiles.length + '.',
			'',
			'## 🌳 Tree',
			'',
			'```text',
			...tree,
			'```',
			'',
			'## ⚠️ Folders without a README',
			'',
			...(gaps.length
				? gaps.map((g) => `- \`${g}/\``)
				: ['None: every folder in the map has its card.']),
			'',
			'## 📖 How the documentation is organized',
			'',
			'- `docs/` — the internal papers (vision, design, decisions, tasks): index in [`docs/README.md`](README.md).',
			'- `README.md` of each folder — what that folder does and what is inside it.',
			'- File level: only when the name does not explain the file, a two-line header.',
			'- The "who calls whom" lives in the code graph (`.codegraph/`), not here.',
			'',
		].join('\n');

		if (cli.includes('--stdout')) {
			process.stdout.write(md);
			return;
		}
		fs.writeFileSync(path.join(ROOT, OUT_REL), md);
		console.log(`docs/MAPA.md — ${documented.length} folders documented, ${gaps.length} without a README.`);
	}

	main();
	}


const USAGE = `usage: node build/docs.mjs <check|map>\n`;
const cli = process.argv.slice(2);

async function dispatch() {
	switch (cli[0]) {
		case 'check':
			return cmdCheck(cli.slice(1));
		case 'map':
			return cmdMap(cli.slice(1));
		default:
			process.stderr.write(USAGE);
			return process.exit(2);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await dispatch();
}
