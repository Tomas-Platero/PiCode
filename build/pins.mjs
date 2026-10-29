#!/usr/bin/env node
/*
 * pins -- keeps the Gentle AI pieces the product pins up to date, without letting them float.
 *
 * PiCode pins four pieces at exact versions (ADR-031, ADR-033): the pi packages gentle-pi,
 * gentle-engram and pi-intercom (`extensions/picode/src/product-packages.ts`) and the memory
 * engine itself (`build/distribution/engram.json`). A pin means nobody gets a release nobody
 * tried; it also means that, without help, every new upstream release waits for someone to
 * notice it. This file is that help: it finds the newer release, reads what changed between the
 * two published artifacts, and says whether the step is one a machine may take on its own.
 *
 * A step is **safe** only when none of these hold, and **review** otherwise:
 *   - the version moves a major (or the minor of a 0.x): the author says it may break;
 *   - a package gains an extension entry point: a new extension is new code pi loads, and a
 *     terminal-only one (as in gentle-pi 4.4.0) has to be filtered out before it ships;
 *   - its pi manifest, install scripts or dependency names change;
 *   - its peer range for pi no longer includes the pi this product ships (`runtime.json`);
 *   - it is the memory engine: its store (`~/.engram`) is shared with every other agent on the
 *     machine, and a new engine can migrate it. That step never goes in a small update (ADR-034).
 *
 * Only stable releases at least `--min-age` hours old are taken (24 by default): a compromised
 * or broken publish is usually pulled within hours, and the pin should not catch it. An npm
 * package is never taken past its `latest` tag (a `candidate` or `next` is not finished).
 *
 * Usage:
 *   node build/pins.mjs check [--min-age <hours>] [--json]
 *   node build/pins.mjs bump <name> [--min-age <hours>] [--report <file>] [--github-output <file>]
 *   node build/pins.mjs audit <name> <from> <to>
 *
 * `bump` writes the new pin (and the tests that name it) and, with `--report`, the pull request
 * body. With `--github-output` it appends `changed`, `verdict`, `from`, `to` and `title` for the
 * workflow (`.github/workflows/pins.yml`). It exits 0 when there is nothing to do.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO = resolve(import.meta.dirname, '..');
const PRODUCT_PACKAGES = join(REPO, 'extensions', 'picode', 'src', 'product-packages.ts');
const CONNECTOR_TESTS = join(REPO, 'extensions', 'picode', 'test');
const ENGRAM_PIN = join(REPO, 'build', 'distribution', 'engram.json');
const RUNTIME_PIN = join(REPO, 'build', 'distribution', 'runtime.json');
const ENGRAM_REPO = 'Gentleman-Programming/engram';

/** The pieces this file looks after. */
const PINS = [
	{ name: 'gentle-pi', kind: 'npm' },
	{ name: 'gentle-engram', kind: 'npm' },
	{ name: 'pi-intercom', kind: 'npm' },
	{ name: 'engram', kind: 'github' },
];

// ---------------------------------------------------------------------------------------------
// Versions

function parseVersion(text) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(text).trim());
	return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : undefined;
}

function compareVersions(a, b) {
	const x = typeof a === 'string' ? parseVersion(a) : a;
	const y = typeof b === 'string' ? parseVersion(b) : b;
	return x.major - y.major || x.minor - y.minor || x.patch - y.patch
		|| (x.pre === undefined ? (y.pre === undefined ? 0 : 1) : (y.pre === undefined ? -1 : x.pre.localeCompare(y.pre)));
}

/** True when the author marks the step as one that may break (semver: a major, or the minor of a 0.x). */
function isBreakingStep(from, to) {
	const a = parseVersion(from);
	const b = parseVersion(to);
	return a.major !== b.major || (a.major === 0 && a.minor !== b.minor);
}

/**
 * Whether `version` satisfies an npm range. Covers the forms peer ranges use (`*`, `x`, `>=1.2.0`,
 * `^1.2.0`, `~1.2.0`, `1.2.x`, `a || b`, space-joined comparators); `undefined` for anything else,
 * which the caller treats as a reason to review.
 */
function satisfies(version, range) {
	const v = parseVersion(version);
	const text = String(range ?? '').trim();
	if (text === '' || text === '*' || text === 'x' || text === 'latest') {
		return true;
	}
	let unreadable = false;
	const any = text.split('||').some(part => {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		return tokens.length > 0 && tokens.every(token => {
			const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/.exec(token);
			if (!m) {
				unreadable = true;
				return false;
			}
			const [, op = '', ...parts] = m;
			const nums = parts.map(p => (p === undefined || p === 'x' || p === '*') ? undefined : +p);
			if (nums[0] === undefined) {
				return true;
			}
			const floor = { major: nums[0], minor: nums[1] ?? 0, patch: nums[2] ?? 0 };
			const c = compareVersions(v, floor);
			switch (op) {
				case '>=': return c >= 0;
				case '>': return c > 0;
				case '<=': return c <= 0;
				case '<': return c < 0;
				case '^': {
					const ceiling = floor.major > 0 ? { major: floor.major + 1, minor: 0, patch: 0 }
						: floor.minor > 0 || nums[2] === undefined ? { major: 0, minor: floor.minor + 1, patch: 0 }
							: { major: 0, minor: 0, patch: floor.patch + 1 };
					return c >= 0 && compareVersions(v, ceiling) < 0;
				}
				case '~': {
					const ceiling = nums[1] === undefined ? { major: floor.major + 1, minor: 0, patch: 0 } : { major: floor.major, minor: floor.minor + 1, patch: 0 };
					return c >= 0 && compareVersions(v, ceiling) < 0;
				}
				default: {
					if (nums[1] === undefined) {
						return v.major === floor.major;
					}
					if (nums[2] === undefined) {
						return v.major === floor.major && v.minor === floor.minor;
					}
					return c === 0;
				}
			}
		});
	});
	return any ? true : unreadable ? undefined : false;
}

// ---------------------------------------------------------------------------------------------
// Reading what is pinned

function pinnedNpmVersion(name) {
	const source = readFileSync(PRODUCT_PACKAGES, 'utf8');
	const m = new RegExp(`\\{ name: '${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}', version: '([^']+)'`).exec(source);
	if (!m) {
		throw new Error(`${name} is not pinned in product-packages.ts`);
	}
	return m[1];
}

function pinnedVersion(pin) {
	return pin.kind === 'npm' ? pinnedNpmVersion(pin.name) : JSON.parse(readFileSync(ENGRAM_PIN, 'utf8')).version;
}

function shippedPiVersion() {
	return JSON.parse(readFileSync(RUNTIME_PIN, 'utf8')).version;
}

// ---------------------------------------------------------------------------------------------
// Upstream

async function fetchOk(url, init) {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`${url} answered ${response.status}`);
	}
	return response;
}

function githubHeaders() {
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

const packuments = new Map();
async function packument(name) {
	if (!packuments.has(name)) {
		packuments.set(name, await (await fetchOk(`https://registry.npmjs.org/${name.replace('/', '%2f')}`)).json());
	}
	return packuments.get(name);
}

/** The newest stable release at least `minAgeHours` old: `{ version, date }`. */
async function latestRelease(pin, minAgeHours) {
	const cutoff = Date.now() - minAgeHours * 3600_000;
	if (pin.kind === 'npm') {
		const doc = await packument(pin.name);
		// Never past the author's `latest` tag: a version published under `next` or `candidate`
		// is one they have not called finished yet.
		const ceiling = doc['dist-tags']?.latest;
		const candidates = Object.keys(doc.versions)
			.filter(v => parseVersion(v) && parseVersion(v).pre === undefined && !doc.versions[v].deprecated)
			.filter(v => ceiling === undefined || compareVersions(v, ceiling) <= 0)
			.filter(v => doc.time?.[v] && Date.parse(doc.time[v]) <= cutoff)
			.sort(compareVersions);
		const version = candidates.at(-1);
		return version ? { version, date: doc.time[version] } : undefined;
	}
	const releases = await (await fetchOk(`https://api.github.com/repos/${ENGRAM_REPO}/releases?per_page=30`, { headers: githubHeaders() })).json();
	const stable = releases
		.filter(r => !r.draft && !r.prerelease && parseVersion(r.tag_name) && parseVersion(r.tag_name).pre === undefined && Date.parse(r.published_at) <= cutoff)
		.sort((a, b) => compareVersions(a.tag_name, b.tag_name));
	const release = stable.at(-1);
	return release ? { version: release.tag_name.replace(/^v/, ''), date: release.published_at, release } : undefined;
}

/** The file paths inside an npm tarball, without the leading `package/`. */
function tarFiles(gz) {
	const buf = gunzipSync(gz);
	const files = [];
	let offset = 0;
	let longName;
	while (offset + 512 <= buf.length) {
		const header = buf.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) {
			break;
		}
		const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0[\s\S]*$/, '');
		const size = parseInt(field(124, 136).trim() || '0', 8);
		const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
		const body = buf.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === 'x') {
			longName = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
			continue;
		}
		if (type === 'L') {
			longName = body.toString('utf8').replace(/\0[\s\S]*$/, '');
			continue;
		}
		if (type === 'g') {
			continue;
		}
		const prefix = field(345, 500);
		const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
		longName = undefined;
		if (type === '0' || type === '7') {
			files.push(name.replace(/^[^/]+\//, ''));
		}
	}
	return files;
}

/** What pi would load as extensions: each declared file, and each top-level entry of a declared folder. */
function extensionEntryPoints(manifest, files) {
	const declared = manifest.pi?.extensions ?? [];
	const entries = new Set();
	for (const item of declared) {
		const path = String(item).replace(/^\.\//, '').replace(/\/$/, '');
		if (files.includes(path)) {
			entries.add(path);
			continue;
		}
		for (const file of files) {
			if (file.startsWith(`${path}/`)) {
				const rest = file.slice(path.length + 1);
				entries.add(`${path}/${rest.includes('/') ? `${rest.split('/')[0]}/` : rest}`);
			}
		}
	}
	return [...entries].sort();
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** Reads two published versions of an npm package and says what the step from one to the other changes. */
async function auditNpm(name, from, to) {
	const doc = await packument(name);
	const [a, b] = [doc.versions[from], doc.versions[to]];
	if (!a || !b) {
		throw new Error(`${name}: ${!a ? from : to} is not published`);
	}
	const [filesA, filesB] = await Promise.all([a, b].map(async manifest => tarFiles(Buffer.from(await (await fetchOk(manifest.dist.tarball)).arrayBuffer()))));
	const review = [];
	const notes = [];

	if (isBreakingStep(from, to)) {
		review.push(`The version moves ${from} → ${to}: by its own numbering the author says it may break.`);
	}

	const entriesA = extensionEntryPoints(a, filesA);
	const entriesB = extensionEntryPoints(b, filesB);
	const added = entriesB.filter(entry => !entriesA.includes(entry));
	const removed = entriesA.filter(entry => !entriesB.includes(entry));
	if (added.length > 0) {
		review.push(`New extensions pi would load: ${added.map(e => `\`${e}\``).join(', ')}. Check each one belongs in an editor; one that only makes sense in a terminal goes in the package filter (\`product-packages.ts\`).`);
	}
	if (removed.length > 0) {
		notes.push(`Extensions it no longer ships: ${removed.map(e => `\`${e}\``).join(', ')}. A filter line naming one of them can go.`);
	}

	const strip = manifest => JSON.stringify({ ...(manifest.pi ?? {}), image: undefined });
	if (strip(a) !== strip(b)) {
		review.push(`Its pi manifest changed: \`${JSON.stringify(a.pi ?? {})}\` → \`${JSON.stringify(b.pi ?? {})}\`.`);
	}

	for (const script of INSTALL_SCRIPTS) {
		if ((a.scripts?.[script] ?? '') !== (b.scripts?.[script] ?? '')) {
			review.push(`Its \`${script}\` script changed: \`${a.scripts?.[script] ?? '(none)'}\` → \`${b.scripts?.[script] ?? '(none)'}\`. It runs on every install.`);
		}
	}

	const depsA = Object.keys(a.dependencies ?? {});
	const depsB = Object.keys(b.dependencies ?? {});
	const newDeps = depsB.filter(dep => !depsA.includes(dep));
	if (newDeps.length > 0) {
		review.push(`New dependencies: ${newDeps.map(dep => `\`${dep}@${b.dependencies[dep]}\``).join(', ')}.`);
	}
	const movedDeps = depsB.filter(dep => depsA.includes(dep) && a.dependencies[dep] !== b.dependencies[dep]);
	if (movedDeps.length > 0) {
		notes.push(`Dependencies that moved: ${movedDeps.map(dep => `\`${dep}\` ${a.dependencies[dep]} → ${b.dependencies[dep]}`).join(', ')}.`);
	}

	const pi = shippedPiVersion();
	const peer = b.peerDependencies?.['@earendil-works/pi-coding-agent'];
	if (peer !== undefined) {
		const ok = satisfies(pi, peer);
		if (ok === false) {
			review.push(`It asks for pi \`${peer}\`, and the product ships pi ${pi}.`);
		} else if (ok === undefined) {
			review.push(`Its pi range \`${peer}\` could not be read; check it includes pi ${pi}.`);
		}
	}
	if (JSON.stringify(a.engines ?? {}) !== JSON.stringify(b.engines ?? {})) {
		notes.push(`Its engines moved: \`${JSON.stringify(a.engines ?? {})}\` → \`${JSON.stringify(b.engines ?? {})}\`.`);
	}

	notes.push(`Files: ${filesA.length} → ${filesB.length}. Compare: https://npmdiff.dev/${encodeURIComponent(name)}/${from}/${to}/`);
	return { review, notes };
}

/** Reads the engine's release, checks its published sums against the downloaded archives, and returns the new pin. */
async function auditEngram(from, to, release) {
	const assets = new Map(release.assets.map(asset => [asset.name, asset]));
	const sums = assets.get('checksums.txt');
	if (!sums) {
		throw new Error(`engram ${to} publishes no checksums.txt`);
	}
	const published = new Map((await (await fetchOk(sums.browser_download_url)).text())
		.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2).map(([hash, file]) => [file.replace(/^\*/, ''), hash.toLowerCase()]));
	const pin = {};
	for (const [assetKey, shaKey, arch] of [['asset', 'sha256', 'amd64'], ['assetArm64', 'sha256Arm64', 'arm64']]) {
		const file = `engram_${to}_windows_${arch}.zip`;
		const asset = assets.get(file);
		if (!asset || !published.has(file)) {
			throw new Error(`engram ${to} has no ${file} with a published sum`);
		}
		const hash = createHash('sha256').update(Buffer.from(await (await fetchOk(asset.browser_download_url)).arrayBuffer())).digest('hex');
		if (hash !== published.get(file)) {
			throw new Error(`${file} does not match its published sum`);
		}
		pin[assetKey] = file;
		pin[shaKey] = hash;
	}
	const review = [
		`It is the memory engine. Its store, \`~/.engram\`, is shared with every other agent on the machine, and a new engine may migrate it — so this step is never taken on its own, and it ships in a full release, not a small update (ADR-034).`,
	];
	if (isBreakingStep(from, to)) {
		review.push(`The version moves ${from} → ${to}: by its own numbering the author says it may break.`);
	}
	const notes = [
		`Both Windows archives were downloaded and match the release's \`checksums.txt\`.`,
		`Release notes: ${release.html_url}`,
		`The \`note\` in \`build/distribution/engram.json\` still describes ${from}; rewrite it before merging.`,
	];
	return { review, notes, pin };
}

// ---------------------------------------------------------------------------------------------
// Writing the pin

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Moves an npm pin in `product-packages.ts` and in the connector tests that name the pinned version. */
function writeNpmPin(name, from, to) {
	const source = readFileSync(PRODUCT_PACKAGES, 'utf8');
	const pattern = new RegExp(`(\\{ name: '${escapeRegExp(name)}', version: ')${escapeRegExp(from)}'`);
	writeFileSync(PRODUCT_PACKAGES, source.replace(pattern, `$1${to}'`));
	const touched = [];
	for (const file of readdirSync(CONNECTOR_TESTS).filter(f => f.endsWith('.test.ts'))) {
		const path = join(CONNECTOR_TESTS, file);
		const text = readFileSync(path, 'utf8');
		const next = text.replace(new RegExp(`(?<![\\w-])${escapeRegExp(name)}@${escapeRegExp(from)}(?![\\w.])`, 'g'), `${name}@${to}`);
		if (next !== text) {
			writeFileSync(path, next);
			touched.push(file);
		}
	}
	return touched;
}

function writeEngramPin(to, pin) {
	const current = JSON.parse(readFileSync(ENGRAM_PIN, 'utf8'));
	writeFileSync(ENGRAM_PIN, `${JSON.stringify({ ...current, version: to, ...pin }, undefined, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Commands

function option(cli, name, fallback) {
	const i = cli.indexOf(`--${name}`);
	return i >= 0 && cli[i + 1] !== undefined ? cli[i + 1] : fallback;
}

async function cmdCheck(cli) {
	const minAge = Number(option(cli, 'min-age', '24'));
	const rows = [];
	for (const pin of PINS) {
		const current = pinnedVersion(pin);
		const latest = await latestRelease(pin, minAge);
		rows.push({ name: pin.name, pinned: current, latest: latest?.version ?? current, outdated: latest !== undefined && compareVersions(latest.version, current) > 0 });
	}
	if (cli.includes('--json')) {
		process.stdout.write(`${JSON.stringify(rows, undefined, '\t')}\n`);
		return;
	}
	for (const row of rows) {
		process.stdout.write(`${row.outdated ? 'update' : 'ok    '}  ${row.name.padEnd(14)} ${row.pinned}${row.outdated ? ` → ${row.latest}` : ''}\n`);
	}
}

async function cmdBump(cli) {
	const name = cli[0];
	const pin = PINS.find(p => p.name === name);
	if (!pin) {
		process.stderr.write(`error: unknown pin '${name ?? ''}'; one of ${PINS.map(p => p.name).join(', ')}\n`);
		process.exit(2);
	}
	const minAge = Number(option(cli, 'min-age', '24'));
	const output = option(cli, 'github-output');
	const emit = values => {
		if (output) {
			appendFileSync(output, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
		}
	};

	const from = pinnedVersion(pin);
	const latest = await latestRelease(pin, minAge);
	if (!latest || compareVersions(latest.version, from) <= 0) {
		process.stdout.write(`${name} ${from} is the newest release at least ${minAge} h old\n`);
		emit({ changed: 'false' });
		return;
	}
	const to = latest.version;

	let audit;
	let touched = [];
	if (pin.kind === 'npm') {
		audit = await auditNpm(name, from, to);
		touched = writeNpmPin(name, from, to);
	} else {
		audit = await auditEngram(from, to, latest.release);
		writeEngramPin(to, audit.pin);
	}
	const verdict = audit.review.length === 0 ? 'safe' : 'review';
	const title = `deps(gentle): update ${name} to ${to}`;

	const report = [
		`Moves the **${name}** pin from **${from}** to **${to}** (published ${latest.date.slice(0, 10)}).`,
		'',
		verdict === 'safe'
			? '✅ **Safe step.** Nothing in the published package asks for a person: it merges itself once the connector tests pass, and ships with the next release.'
			: '🔎 **Needs a look before merging.**',
		'',
		...(audit.review.length > 0 ? ['### 🔎 Why it waits', '', ...audit.review.map(line => `- ${line}`), ''] : []),
		'### 📋 What changed',
		'',
		...audit.notes.map(line => `- ${line}`),
		...(touched.length > 0 ? [`- Tests that name the pin, moved with it: ${touched.map(f => `\`${f}\``).join(', ')}.`] : []),
		'',
		'Opened by `build/pins.mjs` (ADR-035).',
	].join('\n');

	process.stdout.write(`${name} ${from} → ${to}: ${verdict}\n`);
	for (const line of audit.review) {
		process.stdout.write(`  review: ${line}\n`);
	}
	const reportFile = option(cli, 'report');
	if (reportFile) {
		writeFileSync(reportFile, `${report}\n`);
	}
	emit({ changed: 'true', verdict, from, to, title });
}

/** Reads the step between two published versions of an npm pin, without writing anything. */
async function cmdAudit(cli) {
	const [name, from, to] = cli;
	if (!PINS.some(p => p.name === name && p.kind === 'npm') || !parseVersion(from ?? '') || !parseVersion(to ?? '')) {
		process.stderr.write(`usage: node build/pins.mjs audit <${PINS.filter(p => p.kind === 'npm').map(p => p.name).join('|')}> <from> <to>\n`);
		process.exit(2);
	}
	const audit = await auditNpm(name, from, to);
	process.stdout.write(`${name} ${from} → ${to}: ${audit.review.length === 0 ? 'safe' : 'review'}\n`);
	for (const line of audit.review) {
		process.stdout.write(`  review: ${line}\n`);
	}
	for (const line of audit.notes) {
		process.stdout.write(`  note:   ${line}\n`);
	}
}

const USAGE = 'usage: node build/pins.mjs <check|bump <name>|audit <name> <from> <to>> [--min-age <hours>] [--report <file>] [--github-output <file>] [--json]\n';
const cli = process.argv.slice(2);

async function dispatch() {
	switch (cli[0]) {
		case 'check':
			return cmdCheck(cli.slice(1));
		case 'bump':
			return cmdBump(cli.slice(1));
		case 'audit':
			return cmdAudit(cli.slice(1));
		default:
			process.stderr.write(USAGE);
			process.exit(2);
	}
}

// Run only as a command: the tests import the pure helpers below.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	dispatch().catch(error => {
		process.stderr.write(`error: ${error.message}\n`);
		process.exit(1);
	});
}

export { extensionEntryPoints, isBreakingStep, satisfies, tarFiles };
