import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { PiSlashCommand } from "./protocol";
import { resolveOnPath } from "./runtime";

/**
 * Gentle AI, as far as PiCode can see it.
 *
 * gentle-pi is a pi package: a set of extensions that register commands and a
 * bundled `gentle-ai` binary. There is no API that says "gentle is active", but
 * there is something better than a guess — the running session's own command list.
 * If pi reports the gentle commands, the package loaded; if it does not, the package
 * is installed but not doing anything, which is a different state and worth showing
 * as one.
 *
 * Everything external is read-only except the actions the owner explicitly picks:
 * the review kill switch and the telemetry opt-out are theirs, not PiCode's.
 */

export const GENTLE_PACKAGE = "gentle-pi";
export const GENTLE_BINARY = "gentle-ai";

/**
 * The npm packages the Gentle AI layer is made of, in the order the panel lists them.
 *
 * `gentle-engram` is the memory provider the setup wizard installs beside the
 * orchestrator (`GENTLE_MEMORY_PACKAGE` in `onboarding.ts`). The string is written
 * twice on purpose: `onboarding.ts` reads this module for `GENTLE_PACKAGE`, so this one
 * may not read it back without a cycle, and an update check that forgot half the layer
 * would offer an update that leaves the memory provider behind.
 */
export const GENTLE_LAYER_PACKAGES: readonly string[] = [GENTLE_PACKAGE, "gentle-engram"];

/**
 * A version split into the two parts that decide its order.
 *
 * Build metadata (`+sha`) is dropped before splitting: semver says two versions that
 * differ only in it are the same version, and an update check that offered 1.2.3+abc
 * over 1.2.3 would be offering nothing.
 */
function parseVersion(value: string): { core: string[]; prerelease: string[] } | undefined {
  const text = value.trim().replace(/^v/i, "");
  if (text.length === 0) {
    return undefined;
  }

  const withoutBuild = text.split("+")[0];
  const dash = withoutBuild.indexOf("-");
  const coreText = dash < 0 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleaseText = dash < 0 ? "" : withoutBuild.slice(dash + 1);

  const core = coreText.split(".");
  // A core that is not dotted numbers is not a version this can order — "1.2.x" from a
  // hand-written field, say — so the caller falls back to comparing the text as it is
  // rather than ordering 1.2.x above 1.10.0 with invented rules.
  if (core.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }

  return { core, prerelease: prereleaseText.length === 0 ? [] : prereleaseText.split(".") };
}

/**
 * Compares the dot-separated numbers of a version, where a missing part counts as zero.
 *
 * Numeric comparison is the whole point: as text, "10" sorts below "9" and 0.10.0 would
 * look older than 0.9.9.
 */
function compareCorePart(left: string | undefined, right: string | undefined): number {
  const a = left ?? "0";
  const b = right ?? "0";
  const leftNumber = Number(a);
  const rightNumber = Number(b);
  if (leftNumber === rightNumber) {
    return 0;
  }
  return leftNumber < rightNumber ? -1 : 1;
}

/** One prerelease identifier, ordered the way semver orders them. */
function comparePrereleasePart(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  // A numeric identifier is always lower than an alphanumeric one: 1.0.0-alpha.1 <
  // 1.0.0-alpha.beta. Between two numeric ones the number decides, not the text.
  if (leftNumeric && rightNumeric) {
    return Number(left) < Number(right) ? -1 : 1;
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left < right ? -1 : 1;
}

/**
 * Compares two versions, for the one decision this panel has to make: is the published
 * one newer than the installed one.
 *
 * Negative when `left` is older, zero when the two are the same release, positive when
 * `left` is newer. Numeric fields are compared as numbers, so 0.10.0 is newer than
 * 0.9.9, a missing field counts as zero, build metadata is ignored, and a prerelease is
 * older than the release it leads to. A leading `v` is accepted because the versions
 * this reads come from other tools' output as much as from the registry.
 *
 * A value that cannot be read as a version falls back to a plain text comparison
 * instead of throwing: the caller is rendering a state, and a panel that shows an
 * unreadable version as unreadable is better than one that refuses to paint.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  const length = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < length; index += 1) {
    const difference = compareCorePart(a.core[index], b.core[index]);
    if (difference !== 0) {
      return difference;
    }
  }

  // Same numbers: 1.0.0-rc.1 precedes 1.0.0, and 1.0.0-rc.1 precedes 1.0.0-rc.2.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === 0 && b.prerelease.length === 0) {
      return 0;
    }
    return a.prerelease.length === 0 ? 1 : -1;
  }

  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    // A prerelease that ran out of identifiers is the lower one: 1.0.0-rc < 1.0.0-rc.1.
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    const difference = comparePrereleasePart(leftPart, rightPart);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Whether `candidate` is a newer release than `installed`. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0;
}

/**
 * The version an installed pi package declares in its own manifest.
 *
 * `pi list` reports a package's resolved location and no version, and the version that
 * matters for an update check is the npm package's — not the bundled binary's, which is
 * a different number and would be compared against the registry for nothing. Anything
 * unreadable is unknown rather than zero.
 */
export function readInstalledPackageVersion(packageRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" && manifest.version.length > 0
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commands a loaded gentle-pi registers.
 *
 * `get_commands` reports names without a leading slash, but the shape is not worth
 * betting on, so both forms are accepted.
 */
export function gentleCommands(commands: readonly PiSlashCommand[]): PiSlashCommand[] {
  return commands.filter((command) => command.name.replace(/^\//, "").startsWith("gentle:"));
}

export interface ReviewMode {
  /** Whether receipt-driven development is on, from gentle-ai's own words. */
  rdd: "on" | "off" | "unknown";
  global: string;
  cloneLocal: string;
}

/**
 * Parses `gentle-ai review mode status`, which answers with a sentence and then the
 * two scopes:
 *
 *     receipt-driven development: off (decided by global)
 *       global:      off
 *       clone-local: unset
 */
export function parseReviewMode(output: string): ReviewMode {
  let rdd: ReviewMode["rdd"] = "unknown";
  let global = "desconocido";
  let cloneLocal = "desconocido";

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const colon = line.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key.startsWith("receipt-driven development")) {
      if (/^on\b/.test(value)) {
        rdd = "on";
      } else if (/^off\b/.test(value)) {
        rdd = "off";
      }
    } else if (key === "global") {
      global = value;
    } else if (key === "clone-local") {
      cloneLocal = value;
    }
  }

  return { rdd, global, cloneLocal };
}

/** One line describing a tool's answer, for a row's label. */
export function firstMeaningfulLine(output: string, fallback = "sin respuesta"): string {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Progress spinners and empty lines are not an answer.
    if (line.length > 0 && !/^[.·•-]+$/.test(line)) {
      return line;
    }
  }
  return fallback;
}

/**
 * Finds the `gentle-ai` binary.
 *
 * PATH first, because that is what a user of the CLI has; otherwise the copy the
 * gentle-pi package bundles, which is why using gentle from pi never needs a Go
 * toolchain. `packageRoot` is the package path `pi list` reported.
 */
export function resolveGentleBinary(packageRoot?: string): string | undefined {
  const onPath = resolveOnPath(GENTLE_BINARY);
  if (onPath) {
    return onPath;
  }
  if (packageRoot === undefined) {
    return undefined;
  }
  return findBundledBinary(packageRoot);
}

function findBundledBinary(packageRoot: string): string | undefined {
  const bundled = path.join(packageRoot, ".gentle-ai");
  if (!existsSync(bundled)) {
    return undefined;
  }

  // Versioned directory, so the name is not known in advance.
  let versions: string[];
  try {
    versions = readdirSync(bundled).sort().reverse();
  } catch {
    return undefined;
  }

  for (const version of versions) {
    for (const name of [`${GENTLE_BINARY}.exe`, GENTLE_BINARY]) {
      const candidate = path.join(bundled, version, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export interface GentleState {
  /** The package appears in what pi reports as installed. */
  installed: boolean;
  /** The running session has gentle commands, which only a loaded package registers. */
  active: boolean;
  commandCount: number;
  /** The session's gentle commands, for the popup to offer directly. */
  commands: string[];
  binary?: string;
  version?: string;
  review: ReviewMode;
  telemetry: string;
  packageRoot?: string;
}

export function unknownGentleState(): GentleState {
  return {
    installed: false,
    active: false,
    commandCount: 0,
    commands: [],
    review: { rdd: "unknown", global: "desconocido", cloneLocal: "desconocido" },
    telemetry: "desconocido",
  };
}

/**
 * One package of the layer: what is installed here and what the registry publishes.
 *
 * Either side can be absent — a package the listing did not mention, a registry that did
 * not answer — and absence is what the wording below turns into a stated failure instead
 * of a blank.
 */
export interface GentleVersionPair {
  name: string;
  installed?: string;
  latest?: string;
}

/** What the panel knows about updates, once every package has been asked about. */
export interface GentleUpdateReport {
  packages: GentleVersionPair[];
  /** At least one package has a published version newer than the installed one. */
  available: boolean;
}

/**
 * Builds the report from the two readings.
 *
 * Pure and total: the comparison is the only decision, and a pair with a side missing
 * simply cannot claim an update — an unknown version is never treated as behind, which
 * is what would make the panel offer an update it cannot justify.
 */
export function buildUpdateReport(pairs: readonly GentleVersionPair[]): GentleUpdateReport {
  const packages = pairs.map((pair) => ({ ...pair }));
  const available = packages.some(
    (pair) =>
      pair.installed !== undefined &&
      pair.latest !== undefined &&
      isNewerVersion(pair.latest, pair.installed),
  );
  return { packages, available };
}

/** Whether this pair is behind its published version. */
export function hasUpdate(pair: GentleVersionPair): boolean {
  return (
    pair.installed !== undefined && pair.latest !== undefined && isNewerVersion(pair.latest, pair.installed)
  );
}

/**
 * The one line the panel shows above the versions, in one of three honest states: an
 * update exists, everything is current, or the check could not be completed.
 *
 * Only the current state carries numbers, because it is the one state with no
 * per-package line under it: the two installed versions are the whole answer, and this
 * is the single place they are said. When a package is behind, or a version could not
 * be read, `describeVersions` draws the line that holds the numbers — repeating them
 * here is exactly the duplication the panel is being trimmed of.
 *
 * There is deliberately no fourth silent state: a package whose version cannot be read
 * and a registry that does not answer are both reported as the check having failed, so
 * the panel never leaves the owner guessing whether "no update" means nothing was found
 * or nothing was asked.
 */
export function describeUpdate(report: GentleUpdateReport): string {
  if (report.packages.length === 0) {
    return "No se pudo comprobar si hay actualización.";
  }
  // The action wins over the incomplete check: an update that exists is something the
  // owner can do now, and the package whose version could not be read is named in its
  // own line below rather than allowed to hide it.
  if (report.packages.some(hasUpdate)) {
    return "Actualización disponible.";
  }
  if (report.packages.some(unreadableVersion)) {
    return "No se pudo comprobar si hay actualización.";
  }

  const current = report.packages.map((pair) => `${pair.name} ${pair.installed ?? ""}`).join(" · ");
  return `Todo al día: ${current}.`;
}

/** Whether one side of the pair is missing, which makes the whole check incomplete. */
function unreadableVersion(pair: GentleVersionPair): boolean {
  return pair.installed === undefined || pair.latest === undefined;
}

/**
 * One line per package that has something the headline cannot carry: an installed and
 * a published version that differ, or a side that could not be read.
 *
 * Empty when every package is settled. The headline already named both installed
 * versions in that case, and a line repeating them is the repetition the owner asked to
 * remove; when a package is behind or a version is unreadable, on the other hand, the
 * two numbers side by side are the detail that makes the verdict checkable.
 */
export function describeVersions(report: GentleUpdateReport): string[] {
  return report.packages
    .filter((pair) => !isSettled(pair))
    .map(
      (pair) =>
        `${pair.name}: instalada ${pair.installed ?? "desconocida"} · publicada ${
          pair.latest ?? "desconocida"
        }`,
    );
}

/** A pair the headline already covers: both versions read, and nothing newer published. */
function isSettled(pair: GentleVersionPair): boolean {
  return pair.installed !== undefined && pair.latest !== undefined && !hasUpdate(pair);
}

/**
 * The one line under the panel's own name.
 *
 * `summarizeGentle` is the popup's line: a quick-pick row has nowhere else to put the
 * version or the review switch, so it carries both. The panel states each of them once
 * in its own section — the version in the versions line, the review switch among the
 * actions — and repeating them in its header is the redundancy it is being trimmed of.
 * Here only the question a glance has to answer: is it working.
 */
export function summarizeGentlePanel(state: GentleState | undefined): string {
  if (!state) {
    return "leyendo…";
  }
  if (!state.installed && !state.active) {
    return "no instalado";
  }
  return state.active ? "activo" : "instalado, sin cargar";
}

/** The one line the category shows next to its name. */
export function summarizeGentle(state: GentleState | undefined): string {
  if (!state) {
    return "leyendo…";
  }
  if (!state.installed && !state.active) {
    return "no instalado";
  }
  const parts = [state.active ? "activo" : "instalado, sin cargar"];
  if (state.version) {
    parts.push(`v${state.version}`);
  }
  if (state.review.rdd !== "unknown") {
    parts.push(`revisión ${state.review.rdd}`);
  }
  return parts.join(" · ");
}

/**
 * The telemetry switch as a word the owner reads.
 *
 * `gentle-ai telemetry status` answers in English with its own bookkeeping attached —
 * `telemetry: disabled (source: state)` — and the only part of that which belongs on a
 * panel is whether the switch is on.
 */
function describeTelemetry(value: string): string {
  const text = value.toLowerCase();
  if (/\b(enabled|on|active)\b/.test(text)) {
    return "activada";
  }
  if (/\b(disabled|off|inactive)\b/.test(text)) {
    return "desactivada";
  }
  return "desconocida";
}

/**
 * The readings the status popup and the panel show, in the order they show them.
 *
 * Three readings and no more: whether the package is there, whether this session is
 * running it, and whether telemetry is on. The binary's path, its own version number
 * and the review pair with both of its scopes are internals — "¿dónde está?" is not a
 * question the owner asked, the version is stated once in the versions section, and the
 * review switch is already on its own button. The telemetry value is translated rather
 * than dropped because the two switch buttons alone do not say which state is in effect.
 */
export function describeGentle(state: GentleState): string[] {
  return [
    `paquete ${GENTLE_PACKAGE}: ${state.installed ? "instalado" : "no instalado"}`,
    `cargado en esta sesión: ${state.active ? `sí, ${state.commandCount} comandos` : "no"}`,
    `telemetría: ${describeTelemetry(state.telemetry)}`,
  ];
}
