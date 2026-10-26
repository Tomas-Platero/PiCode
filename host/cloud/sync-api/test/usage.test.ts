/*
 * The anonymous usage rules: which feed paths are accepted, what one update check adds, and the
 * public summary. Pure functions, no Firestore.
 *
 *   node --experimental-strip-types --test test/*.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { channelOfTag, downloadsByChannel } from "../src/lib/downloads.ts";
import { isStatsCaller } from "../src/lib/stats-auth.ts";
import {
  feedUrl,
  increments,
  parseFeedPath,
  readActive,
  readVersion,
  sampleOf,
  summarize,
  type UsageDay,
} from "../src/lib/usage.ts";

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

test("a feed path with a target is parsed and redirected to the same document", () => {
  const feed = parseFeedPath(["master", "updates", "stable", "win32", "x64", "archive", "latest.json"]);
  assert.deepEqual(feed, { branch: "master", quality: "stable", platform: "win32", arch: "x64", target: "archive" });
  assert.equal(
    feedUrl(feed!),
    "https://raw.githubusercontent.com/Tomas-Platero/PiCode/master/updates/stable/win32/x64/archive/latest.json",
  );
});

test("a feed path without a target", () => {
  const feed = parseFeedPath(["beta", "updates", "insider", "linux", "arm64", "latest.json"]);
  assert.equal(feed?.target, undefined);
  assert.equal(feedUrl(feed!), "https://raw.githubusercontent.com/Tomas-Platero/PiCode/beta/updates/insider/linux/arm64/latest.json");
});

test("anything that is not a feed path is refused", () => {
  for (const path of [
    ["main", "updates", "stable", "win32", "x64", "latest.json"],
    ["master", "other", "stable", "win32", "x64", "latest.json"],
    ["master", "updates", "stable", "win32", "x64", "..", "latest.json"],
    ["master", "updates", "stable", "win32", "x64", "user", "other.json"],
    ["master", "updates", "nightly", "win32", "x64", "latest.json"],
    ["master", "updates", "stable", "win32", "x64"],
  ]) {
    assert.equal(parseFeedPath(path), null, path.join("/"));
  }
});

test("only a well-formed version is kept", () => {
  assert.equal(readVersion("0.2.7"), "0.2.7");
  assert.equal(readVersion("0.2.7-beta"), "0.2.7-beta");
  assert.equal(readVersion("../../etc"), undefined);
  assert.equal(readVersion(null), undefined);
});

test("active flags are read in any order, unknown words ignored", () => {
  assert.deepEqual(readActive("month, DAY,other"), { day: true, week: false, month: true });
  assert.deepEqual(readActive(null), { day: false, week: false, month: false });
});

test("a repeat check of the day only counts as a check", () => {
  const feed = parseFeedPath(["master", "updates", "stable", "win32", "x64", "user", "latest.json"])!;
  assert.deepEqual(increments(sampleOf(feed, headers({ "x-picode-version": "0.2.7" }))), { checks: 1 });
});

test("the first check of the day fills the breakdowns", () => {
  const feed = parseFeedPath(["master", "updates", "stable", "win32", "x64", "user", "latest.json"])!;
  const sample = sampleOf(feed, headers({ "x-picode-version": "0.2.7-beta", "x-picode-active": "day,week" }));
  assert.deepEqual(increments(sample), {
    checks: 1,
    "active.day": 1,
    "active.week": 1,
    "os.win32": 1,
    "arch.x64": 1,
    "channel.stable": 1,
    "version.0_2_7-beta": 1,
    "package.user": 1,
  });
});

test("the summary covers 30 days and takes the mix from the last whole day", () => {
  const stored = new Map<string, UsageDay>([
    ["2026-10-26", { active: { day: 3, week: 1 } }],
    ["2026-10-25", { active: { day: 5, week: 2, month: 1 }, os: { win32: 5 }, version: { "0_2_7": 5 } }],
    ["2026-10-01", { active: { day: 4, month: 4 } }],
    ["2026-09-20", { active: { day: 9, week: 9, month: 9 } }],
  ]);
  const stats = summarize("2026-10-26", stored);
  assert.equal(stats.days.length, 30);
  assert.equal(stats.days.at(-1)?.date, "2026-10-26");
  assert.equal(stats.days[0]?.date, "2026-09-27");
  assert.equal(stats.activeToday, 3);
  assert.equal(stats.activeLast7Days, 3);
  assert.equal(stats.activeLast30Days, 5);
  assert.deepEqual(stats.os, { win32: 5 });
  assert.deepEqual(stats.version, { "0.2.7": 5 });
});

test("downloads keep each channel's newest release", () => {
  assert.equal(channelOfTag("v0.2.7"), "stable");
  assert.equal(channelOfTag("v0.2.2-beta"), "beta");
  assert.deepEqual(
    downloadsByChannel([
      { tag_name: "v0.2.8-beta", assets: [{ download_count: 2 }, { download_count: 3 }] },
      { tag_name: "v0.2.7", assets: [{ download_count: 10 }] },
      { tag_name: "v0.2.6", assets: [{ download_count: 99 }] },
    ]),
    { beta: { tag: "v0.2.8-beta", downloads: 5 }, stable: { tag: "v0.2.7", downloads: 10 } },
  );
});

test("only the holder of the stats token may read the stats", () => {
  assert.equal(isStatsCaller("Bearer s3cret", "s3cret"), true);
  assert.equal(isStatsCaller("Bearer wrong!", "s3cret"), false);
  assert.equal(isStatsCaller("Bearer s3cre", "s3cret"), false);
  assert.equal(isStatsCaller("s3cret", "s3cret"), false);
  assert.equal(isStatsCaller(null, "s3cret"), false);
});

test("with no token configured nobody may read the stats", () => {
  assert.equal(isStatsCaller("Bearer ", undefined), false);
  assert.equal(isStatsCaller("Bearer anything", undefined), false);
  assert.equal(isStatsCaller("Bearer anything", ""), false);
});
