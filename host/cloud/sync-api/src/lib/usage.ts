/**
 * Anonymous usage counting, as pure rules (no Firestore here; the I/O is in `usage-store.ts`).
 *
 * What is counted is the update check every PiCode already makes. The editor asks
 * `<updateUrl>/<quality>/<platform>/<arch>[/<target>]/latest.json`; this API answers with a
 * redirect to the real feed on raw.githubusercontent.com and, on the way, adds one to a few daily
 * counters. Nothing identifies a person or a machine: no id, no IP, no stored request. The only
 * things read are the path (channel, OS, architecture, package), the PiCode version header and the
 * "first check of the day/week/month" flags the editor works out locally.
 */

export const FEED_BRANCHES = ["HEAD", "master", "beta", "experimental"] as const;
export type FeedBranch = (typeof FEED_BRANCHES)[number];

// One per release channel (ADR-015); `insider` is upstream's and stays for old clients.
const QUALITIES = new Set(["stable", "beta", "experimental", "insider"]);
const PLATFORMS = new Set(["win32", "linux", "darwin"]);
const ARCHITECTURES = /^[a-z0-9]{2,12}$/;
const TARGETS = /^[a-z0-9-]{2,16}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9]{1,16})?$/;

/** Where the real feed lives; the editor's path is appended under `<branch>/updates/`. */
export const FEED_ORIGIN = "https://raw.githubusercontent.com/Tomas-Platero/PiCode";

/** The editor sends these headers; both are optional (an old or foreign client sends neither). */
export const VERSION_HEADER = "x-picode-version";
export const ACTIVE_HEADER = "x-picode-active";

export interface FeedRequest {
  branch: FeedBranch;
  quality: string;
  platform: string;
  arch: string;
  target?: string;
}

export interface ActiveFlags {
  day: boolean;
  week: boolean;
  month: boolean;
}

export interface UsageSample {
  channel: string;
  platform: string;
  arch: string;
  target?: string;
  version?: string;
  active: ActiveFlags;
}

/** Parses `<branch>/updates/<quality>/<platform>/<arch>[/<target>]/latest.json`; anything else is null. */
export function parseFeedPath(segments: readonly string[]): FeedRequest | null {
  const [branch, updates, quality, platform, arch, ...rest] = segments;
  if (!FEED_BRANCHES.includes(branch as FeedBranch) || updates !== "updates") {
    return null;
  }
  if (!quality || !QUALITIES.has(quality) || !platform || !PLATFORMS.has(platform)) {
    return null;
  }
  if (!arch || !ARCHITECTURES.test(arch)) {
    return null;
  }
  if (rest.length === 1 && rest[0] === "latest.json") {
    return { branch: branch as FeedBranch, quality, platform, arch };
  }
  if (rest.length === 2 && rest[1] === "latest.json" && rest[0] && TARGETS.test(rest[0])) {
    return { branch: branch as FeedBranch, quality, platform, arch, target: rest[0] };
  }
  return null;
}

/** The real document the editor asked for. */
export function feedUrl(request: FeedRequest): string {
  const path = [request.quality, request.platform, request.arch, request.target, "latest.json"]
    .filter((part): part is string => part !== undefined)
    .join("/");
  return `${FEED_ORIGIN}/${request.branch}/updates/${path}`;
}

/**
 * The channel a build was sealed for. The branch carries it (`dev/build.sh` rewrites it per
 * channel); `HEAD` is an unsealed tree build and `master` is the stable branch.
 */
export function channelOf(branch: FeedBranch): string {
  switch (branch) {
    case "master":
      return "stable";
    case "HEAD":
      return "dev";
    default:
      return branch;
  }
}

export function readVersion(value: string | null): string | undefined {
  const version = value?.trim();
  return version && VERSION.test(version) ? version : undefined;
}

/** `day,week,month` (any subset, any order); unknown words are ignored. */
export function readActive(value: string | null): ActiveFlags {
  const words = new Set((value ?? "").split(",").map((word) => word.trim().toLowerCase()));
  return { day: words.has("day"), week: words.has("week"), month: words.has("month") };
}

export function sampleOf(request: FeedRequest, headers: { get(name: string): string | null }): UsageSample {
  return {
    channel: channelOf(request.branch),
    platform: request.platform,
    arch: request.arch,
    target: request.target,
    version: readVersion(headers.get(VERSION_HEADER)),
    active: readActive(headers.get(ACTIVE_HEADER)),
  };
}

/** UTC calendar day, which is also the counter document's id. */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Firestore treats `.` in a field path as nesting, so a version becomes `0_2_7`. */
export function fieldKey(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, "_");
}

/**
 * The increments one check adds to its day's document, as dotted field paths.
 *
 * Every check counts in `checks`. The breakdowns (version, OS, channel, package) count only the
 * first check of the day, so each one adds up to the day's active installs instead of growing
 * with how often a running editor polls.
 */
export function increments(sample: UsageSample): Record<string, number> {
  const fields: Record<string, number> = { checks: 1 };
  if (sample.active.day) {
    fields["active.day"] = 1;
    fields[`os.${fieldKey(sample.platform)}`] = 1;
    fields[`arch.${fieldKey(sample.arch)}`] = 1;
    fields[`channel.${fieldKey(sample.channel)}`] = 1;
    fields[`version.${fieldKey(sample.version ?? "unknown")}`] = 1;
    if (sample.target) {
      fields[`package.${fieldKey(sample.target)}`] = 1;
    }
  }
  if (sample.active.week) {
    fields["active.week"] = 1;
  }
  if (sample.active.month) {
    fields["active.month"] = 1;
  }
  return fields;
}

/** One day's document as stored. */
export interface UsageDay {
  checks?: number;
  active?: Partial<Record<"day" | "week" | "month", number>>;
  os?: Record<string, number>;
  arch?: Record<string, number>;
  channel?: Record<string, number>;
  version?: Record<string, number>;
  package?: Record<string, number>;
}

export interface UsageStats {
  days: { date: string; active: number }[];
  activeToday: number;
  activeLast7Days: number;
  activeLast30Days: number;
  os: Record<string, number>;
  channel: Record<string, number>;
  version: Record<string, number>;
  package: Record<string, number>;
}

function addInto(target: Record<string, number>, source: Record<string, number> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}

/** The day `n` days before `day` (both `YYYY-MM-DD`). */
export function daysBefore(day: string, n: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - n);
  return dayKey(at);
}

/**
 * The public summary over the 30 days ending `today`.
 *
 * "Active in the last 7/30 days" sums the first-check-of-the-week/month flags, so an install
 * counts once per calendar week or month it was used in. Across a week or month boundary inside
 * the window that can count one install twice, which is the price of storing no identity: the
 * figure is an estimate. The breakdowns are the last whole day's, the closest thing to "what
 * people run now".
 */
export function summarize(today: string, stored: ReadonlyMap<string, UsageDay>): UsageStats {
  const days: { date: string; active: number }[] = [];
  let week = 0;
  let month = 0;
  for (let n = 29; n >= 0; n--) {
    const date = daysBefore(today, n);
    const day = stored.get(date);
    days.push({ date, active: day?.active?.day ?? 0 });
    month += day?.active?.month ?? 0;
    if (n < 7) {
      week += day?.active?.week ?? 0;
    }
  }

  // Today is still filling up; yesterday is the last whole day, so it describes the mix better.
  const latest = stored.get(daysBefore(today, 1)) ?? stored.get(today) ?? {};
  const os: Record<string, number> = {};
  const channel: Record<string, number> = {};
  const version: Record<string, number> = {};
  const pkg: Record<string, number> = {};
  addInto(os, latest.os);
  addInto(channel, latest.channel);
  addInto(pkg, latest.package);
  for (const [key, value] of Object.entries(latest.version ?? {})) {
    version[key.replace(/_/g, ".")] = value;
  }

  return {
    days,
    activeToday: stored.get(today)?.active?.day ?? 0,
    activeLast7Days: week,
    activeLast30Days: month,
    os,
    channel,
    version,
    package: pkg,
  };
}
