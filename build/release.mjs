#!/usr/bin/env node
/*
 * release -- what a release publishes.
 *
 * The release page's "what changed" section, grouped by kind of change, and the
 * static update feed every channel reads to learn it has a new version.
 *
 * Usage:
 *   node build/release.mjs update-feed
 *   node build/release.mjs release-notes
 *
 * One file per domain: the scripts that used to sit side by side in build/ were fused
 * here, each keeping its own explanation directly above the code it runs. Commands are
 * functions, so this file can also be imported (build/checks.mjs imports resolvePack)
 * without anything running.
 */

import { pathToFileURL } from 'node:url';
	// update-feed -- was build/update-feed.mjs
	/*
	 * Writes the static update feed a PiCode release needs.
	 *
	 * Why a feed at all: the editor's updater (VSCodium's `11-update-use-github-release`
	 * change, baked into the source tree) reads a JSON document per platform from
	 *
	 *     <updateUrl>/<quality>/<platform>/<architecture>[/<target>]/latest.json
	 *
	 * and compares `productVersion` against the running build. The GitHub Releases API does
	 * not answer in that shape, so `updateUrl` cannot point at it directly; this file is what
	 * turns one published release into the document the updater expects. Serving it from
	 * `raw.githubusercontent.com` means there is no server to run.
	 *
	 * The one failure this generator refuses to produce is the known "an update is always
	 * available" bug: a feed whose `productVersion` is not newer than what is installed makes
	 * the toolbar permanently claim an update. When the caller passes `--installed`, that is
	 * checked before anything is written.
	 *
	 * Usage:
	 *   node build/release.mjs update-feed \
	 *     --version 1.135.1 --commit <sha> \
	 *     --url https://github.com/TomasPlatero/PiCode/releases/download/v1.135.1/PiCode-win32-x64-1.135.1.zip \
	 *     --sha256 <hex> --platform win32 --arch x64 [--target user] \
	 *     [--picode-version 0.1.0-beta] [--installed 1.135.0] [--out updates] [--force]
	 *
	 * `--version` is the editor's number the updater compares; `--picode-version` is PiCode's own
	 * number the updater UI shows. They are different on purpose (see updates/README.md).
	 */
	async function cmdUpdateFeed(cli) {
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const path = await import('node:path');
	// The channels a feed can be cut for. `stable` is the RC channel (versions 1.0.0+);
	// `beta` and `experimental` are the channels ahead of it (owner's decision, 2026-10-08,
	// ADR-015 in `docs/DECISIONS.md`): a build ships with its channel in product.json's
	// `quality`, and reads its own feed — one channel is never offered another's build.
	// `insider` stays accepted because upstream tooling may still name it.
	// One channel per branch — the relation is the owner's, 2026-10-08:
	//   stable <-> master    beta <-> beta    experimental <-> experimental
	// `insider` is not one of ours: it is upstream's own quality, kept here because a
	// feed can be cut for it and because the version-suffix rule keys off it.
	const QUALITIES = new Set(["stable", "insider", "beta", "experimental"]);
	const PLATFORMS = new Set([
	  "aix",
	  "android",
	  "darwin",
	  "freebsd",
	  "haiku",
	  "linux",
	  "openbsd",
	  "sunos",
	  "win32",
	  "cygwin",
	  "netbsd",
	]);
	const ARCHITECTURES = new Set([
	  "arm",
	  "arm64",
	  "ia32",
	  "loong64",
	  "mips",
	  "mipsel",
	  "ppc",
	  "ppc64",
	  "riscv64",
	  "s390",
	  "s390x",
	  "x64",
	]);
	const TARGETS = new Set(["archive", "msi", "system", "user"]);

	function usage(message) {
	  if (message) {
	    console.error(`error: ${message}`);
	  }
	  console.error("usage: node build/release.mjs update-feed --version <v> --commit <sha> --url <asset> --sha256 <hex> --platform <p> --arch <a> [--target <t>] [--picode-version <v>] [--quality stable] [--installed <v>] [--out updates] [--force]");
	  process.exit(2);
	}

	function parseArgs(argv) {
	  const flags = {};
	  for (let index = 0; index < argv.length; index += 1) {
	    const token = argv[index];
	    if (!token.startsWith("--")) {
	      usage(`unexpected argument "${token}"`);
	    }
	    const name = token.slice(2);
	    if (name === "force") {
	      flags.force = true;
	      continue;
	    }
	    const value = argv[index + 1];
	    if (value === undefined || value.startsWith("--")) {
	      usage(`--${name} needs a value`);
	    }
	    flags[name] = value;
	    index += 1;
	  }
	  return flags;
	}

	/**
	 * Compares two dotted versions numerically.
	 *
	 * Deliberately not `semver`: the versions involved are VS Code's, and PiCode's own
	 * builds carry a four-part form (`1.135.06055`) that `semver` rejects. Returns a positive
	 * number when `left` is newer, a negative one when it is older, and `0` when equal.
	 */
	function compareVersions(left, right) {
	  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
	  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
	  const length = Math.max(a.length, b.length);
	  for (let index = 0; index < length; index += 1) {
	    const diff = (a[index] ?? 0) - (b[index] ?? 0);
	    if (diff !== 0) {
	      return diff;
	    }
	  }
	  return 0;
	}

	function required(flags, name) {
	  const value = flags[name];
	  if (typeof value !== "string" || value.trim() === "") {
	    usage(`--${name} is required`);
	  }
	  return value.trim();
	}

	function main() {
	  const flags = parseArgs(cli);

	  const version = required(flags, "version");
	  const commit = required(flags, "commit");
	  const url = required(flags, "url");
	  const sha256 = required(flags, "sha256");
	  const platform = required(flags, "platform");
	  const architecture = required(flags, "arch");
	  const quality = flags.quality ?? "stable";
	  const out = flags.out ?? "updates";

	  if (!QUALITIES.has(quality)) {
	    usage(`--quality must be one of ${[...QUALITIES].join(", ")}`);
	  }
	  if (!PLATFORMS.has(platform)) {
	    usage(`--platform must be one of ${[...PLATFORMS].join(", ")}`);
	  }
	  if (!ARCHITECTURES.has(architecture)) {
	    usage(`--arch must be one of ${[...ARCHITECTURES].join(", ")}`);
	  }
	  if (flags.target !== undefined && !TARGETS.has(flags.target)) {
	    usage(`--target must be one of ${[...TARGETS].join(", ")}`);
	  }
	  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
	    usage("--sha256 must be 64 hexadecimal characters");
	  }

	  // The bug this prevents is not hypothetical: a feed that is not newer makes the editor
	  // offer the same update forever. Refusing to write it is the honest answer, and
	  // `--force` exists only for republishing a corrected feed for the version already out.
	  if (flags.installed !== undefined && !flags.force) {
	    const order = compareVersions(version, flags.installed);
	    if (order <= 0) {
	      console.error(
	        `error: the feed's version ${version} is not newer than the installed ${flags.installed}; ` +
	          "writing it would make the editor offer an update that is not one. Pass --force to publish anyway.",
	      );
	      process.exit(1);
	    }
	  }

	  const directory = [out, quality, platform, architecture, ...(flags.target ? [flags.target] : [])];
	  const feed = {
	    version: commit,
	    productVersion: version,
	    ...(flags["picode-version"] === undefined ? {} : { picodeVersion: flags["picode-version"].trim() }),
	    timestamp: Date.now(),
	    url,
	    sha256hash: sha256,
	  };

	  const target = path.join(...directory, "latest.json");
	  mkdirSync(path.dirname(target), { recursive: true });
	  writeFileSync(target, `${JSON.stringify(feed, null, 2)}\n`);

	  console.log(`wrote ${target}`);
	  console.log(`served at ${["<updateUrl>", ...directory.slice(1), "latest.json"].join("/")}`);
	}

	main();
	}

	// release-notes -- was build/release-notes.mjs
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
	 * Usage: node build/release.mjs release-notes --from <tag> --to <tag> [--max <n>]
	 * Emits Markdown on stdout; a gap it cannot bridge (no tags, no commits) prints
	 * nothing and exits 0 — the caller then ships the page without the section.
	 */
	async function cmdReleaseNotes(cli) {
	const { execFileSync } = await import('node:child_process');
	const args = cli;
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
	const NOISE = /^(release|chore|ci|docs|test|style|merge)(\(|:)/i;

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
	for (const { title } of [...GROUPS, FALLBACK]) {
		const entries = groups.get(title);
		if (!entries) continue;
		lines.push(`### ${title}`, '');
		for (const entry of entries) lines.push(`- ${entry}`);
		lines.push('');
	}
	process.stdout.write(lines.join('\n'));
	}


const USAGE = `usage: node build/release.mjs <update-feed|release-notes>\n`;
const cli = process.argv.slice(2);

async function dispatch() {
	switch (cli[0]) {
		case 'update-feed':
			return cmdUpdateFeed(cli.slice(1));
		case 'release-notes':
			return cmdReleaseNotes(cli.slice(1));
		default:
			process.stderr.write(USAGE);
			return process.exit(2);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await dispatch();
}
