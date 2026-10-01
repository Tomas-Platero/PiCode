#!/usr/bin/env node
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
 *   node dev/update-feed.mjs \
 *     --version 1.135.1 --commit <sha> \
 *     --url https://github.com/TomasPlatero/PiCode/releases/download/v1.135.1/PiCode-win32-x64-1.135.1.zip \
 *     --sha256 <hex> --platform win32 --arch x64 [--target user] \
 *     [--installed 1.135.0] [--out updates] [--force]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const QUALITIES = new Set(["stable", "insider"]);
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
  console.error("usage: node dev/update-feed.mjs --version <v> --commit <sha> --url <asset> --sha256 <hex> --platform <p> --arch <a> [--target <t>] [--quality stable] [--installed <v>] [--out updates] [--force]");
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
  const flags = parseArgs(process.argv.slice(2));

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
