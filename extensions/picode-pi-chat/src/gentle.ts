import { existsSync, readdirSync } from "node:fs";
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

/** The lines the status popup shows, in the order it shows them. */
export function describeGentle(state: GentleState): string[] {
  return [
    `paquete ${GENTLE_PACKAGE}: ${state.installed ? "instalado" : "no instalado"}`,
    `cargado en esta sesión: ${state.active ? `sí, ${state.commandCount} comandos` : "no"}`,
    `binario ${GENTLE_BINARY}: ${state.binary ?? "no encontrado"}`,
    `versión: ${state.version ?? "desconocida"}`,
    `revisión (RDD): ${state.review.rdd} · global ${state.review.global}, clon ${state.review.cloneLocal}`,
    `telemetría: ${state.telemetry}`,
  ];
}
