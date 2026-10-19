#!/usr/bin/env node
/**
 * The release page's "what changed" section, built from the commits the release
 * carries.
 *
 * The updater's audience is the owner and the users of a channel: what they want
 * from the release page is a short, grouped, honest list — features, fixes, the
 * rest — above the raw changelog GitHub generates. The commit subjects already
 * speak plainly (conventional prefixes), so the grouping is mechanical and the
 * output is only as creative as the history is.
 *
 * Usage: node dev/release-notes.mjs --from <tag> --to <tag> [--max <n>]
 * Emits Markdown on stdout; a gap it cannot bridge (no tags, no commits) prints
 * nothing and exits 0 — the caller then ships the page without the section.
 */

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const from = arg('from');
const to = arg('to');
const max = Number(arg('max', '60'));
if (!from || !to) {
	// No previous release: the section would have nothing to compare, and the
	// generated changelog already covers the whole history. Silence is correct.
	process.exit(0);
}

const range = `${from}..${to}`;
let log;
try {
	log = execFileSync('git', [
		'log', range, '--no-merges', '--pretty=%s',
	], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
} catch {
	process.exit(0);
}

/** One group per kind of change, in the order the page shows them. */
const GROUPS = [
	{ match: /^feat(\(|:)/, title: '✨ New' },
	{ match: /^fix(\(|:)/, title: '🐛 Fixed' },
	{ match: /^perf(\(|:)/, title: '⚡ Faster' },
	{ match: /^editor(\(|:)/, title: '🎨 Editor' },
	{ match: /^security(\(|:)/, title: '🔒 Security' },
];
const FALLBACK = { match: /.*/, title: '🔧 Other changes' };

/** Feed-and-housekeeping commits never tell a user anything. */
const NOISE = /^(release:|chore\(release\)|release: feed)/i;

const seen = new Set();
const groups = new Map();
for (const subject of log.split('\n').map(line => line.trim()).filter(Boolean)) {
	if (NOISE.test(subject) || seen.has(subject)) continue;
	seen.add(subject);
	const group = GROUPS.find(g => g.match.test(subject)) ?? FALLBACK;
	if (!groups.has(group.title)) groups.set(group.title, []);
	if (groups.get(group.title).length >= max) continue;
	// The prefix is the grouping; the sentence after it is what the page says.
	groups.get(group.title).push(subject.replace(/^[a-z]+(\([^)]*\))?:\s*/, ''));
}

if (seen.size === 0) process.exit(0);

const lines = ['## What changed', ''];
for (const [title, entries] of groups) {
	lines.push(`### ${title}`, '');
	for (const entry of entries) lines.push(`- ${entry}`);
	lines.push('');
}
process.stdout.write(lines.join('\n'));
