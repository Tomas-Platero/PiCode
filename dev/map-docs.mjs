#!/usr/bin/env node
// dev/map-docs.mjs — regenerate docs/MAPA.md, the map of the repository.
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
//   node dev/map-docs.mjs           # write docs/MAPA.md
//   node dev-docs.mjs --stdout  # print, write nothing

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
	'picode-source/src': { kind: 'opaque' },
	'picode-source/cli': { kind: 'opaque' },
	'picode-source/build': { kind: 'opaque' },
	'picode-source/resources': { kind: 'opaque' },
	'picode-source/scripts': { kind: 'opaque' },
	'picode-source/remote': { kind: 'opaque' },
	'picode-source/extensions': { kind: 'only', keep: ['picode'] },
};

// Root-level files: one line each, in Spanish, stable names.
const ROOT_FILES = {
	'.gitattributes': 'Reglas de Git por tipo de fichero (binarios, fin de línea).',
	'.gitignore': 'Lo que no se versiona: dependencias, salidas de build, claves, perfiles.',
	'.gitleaks.toml': 'Configuración del escáner de secretos (Gitleaks) que corre en CI.',
	'.nvmrc': 'Versión de Node fija para todo el proyecto (la lee CI y la build).',
	'AGENTS.md': '📋 Las frases del dueño: reglas de producto, UI, arquitectura y forma de trabajar.',
	'CODE_OF_CONDUCT.md': '🤝 Código de conducta del repositorio.',
	'CONTRIBUTING.md': '🤝 Cómo se contribuye y cómo se publica el árbol propio.',
	'LICENSE': 'Licencia MIT del producto.',
	'README.md': '🌍 Cara pública: qué es PiCode, descargas y cómo compilarlo.',
	'SECURITY.md': '🛡️ Cómo se reporta una vulnerabilidad.',
	'_typos.toml': 'Falsos positivos del corrector ortográfico `typos`.',
	'repomix.config.json': 'Configuración del volcado del repositorio para LLMs.',
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
			if (other > 0) zoneNote = `… y ${other} extensiones built-in de upstream (solo picode/ es nuestra)`;
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
				const note = ZONES[childRel]?.kind === 'opaque' ? ' · ⬆️ upstream, sin desglose' : '';
				// Only depth 1-2 carries the warning: deeper folders inherit their parent's README.
				const shallow = rel.split('/').length <= 1;
				if (desc) {
					documented.push({ rel: childRel, desc });
					tree.push(`${prefix}${branch}${item.name}/ — ${desc}${note}`);
				} else {
					const gap = isGap(rel, item.name);
					if (gap) gaps.push(childRel);
					tree.push(`${prefix}${branch}${item.name}/${gap && shallow ? ' — ⚠️ sin README' : note}`);
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
			tree.push(`${prefix}└── … ${files.length} ficheros en total`);
		}
	};

	walk('', '', 0);

	const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
		.filter((e) => e.isFile() && ROOT_FILES[e.name])
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b));

	const md = [
		'# 🗺️ Mapa del repositorio',
		'',
		'> **Generado** con `node dev/map-docs.mjs` — no editar a mano.',
		'> Cada carpeta se describe con **la primera línea de su propio `README.md`**:',
		'> si aquí pone «sin README», el hueco está en la lista de abajo.',
		'',
		'## 📊 Estado',
		'',
		`- **${documented.length}** carpetas documentadas · **${gaps.length}** sin README.`,
		'- Ficheros de la raíz descritos: ' + rootFiles.length + '.',
		'',
		'## 🌳 Árbol',
		'',
		'```text',
		...tree,
		'```',
		'',
		'## ⚠️ Carpetas sin README',
		'',
		...(gaps.length
			? gaps.map((g) => `- \`${g}/\``)
			: ['Ninguna: todas las carpetas del mapa tienen su ficha.']),
		'',
		'## 📖 Cómo está organizada la documentación',
		'',
		'- `docs/` — los papeles internos (visión, diseño, decisiones, tareas): índice en [`docs/README.md`](README.md).',
		'- `README.md` de cada carpeta — qué hace esa carpeta y qué hay dentro.',
		'- Nivel fichero: solo cuando el nombre no explica el fichero, una cabecera de dos líneas.',
		'- El «quién llama a quién» está en el grafo de código (`.codegraph/`), no aquí.',
		'',
	].join('\n');

	if (process.argv.includes('--stdout')) {
		process.stdout.write(md);
		return;
	}
	fs.writeFileSync(path.join(ROOT, OUT_REL), md);
	console.log(`docs/MAPA.md — ${documented.length} carpetas documentadas, ${gaps.length} sin README.`);
}

main();
