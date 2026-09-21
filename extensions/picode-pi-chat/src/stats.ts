import type { UsageTotals } from "./usage";
import { contextPercent, formatCost, formatTokens } from "./usage";

/**
 * The figures the stats column and the stats strip show.
 *
 * This module produces values with their units and nothing else. Labels (`MCP`,
 * `caché`, `ses`, `ctx`, ...) are the layout's business: the renderer decides what a
 * figure is called and where it sits, so the same numbers can move without being
 * rebuilt. The panel's left column takes the live figures, which change with every
 * reply; the strip at the bottom takes the environment figures, which almost never do.
 */

/** What changes with every reply, shown in the panel's left column. */
export interface LiveStats {
  /** Context window pressure, as a bare percentage with its unit: `62 %`. */
  context?: string;
  /** Accumulated cost, formatted by the bill's own formatter: `1,42 $`. */
  cost?: string;
  /** Input and output tokens together, abbreviated: `505,7k`. */
  tokens?: string;
  /** Share of what the model read that came from cache: `78 %`. */
  cache?: string;
}

/** What describes where the agent runs and almost never changes, shown at the bottom. */
export interface EnvironmentStats {
  /** How many MCP servers are configured: `6`. */
  mcps?: string;
  /** How many conversations this project has: `12`. */
  sessions?: string;
  /** The project folder's name: `PiCode`. */
  project?: string;
  /** The current git branch: `feat/picode-distribution`. */
  branch?: string;
}

/**
 * How much of what the model read came from cache.
 *
 * Cache reads bill differently from fresh input, so this is the figure a bill cares
 * about: `cacheRead / (cacheRead + input)`. It is deliberately not `cacheWrite`,
 * which is what was written into the cache, not what was read from it. Without any
 * tokens read there is no share to state, and the result is `undefined`.
 */
export function cacheHitPercent(totals: UsageTotals): number | undefined {
  const read = totals.cacheRead + totals.input;
  if (read <= 0) {
    return undefined;
  }
  return Math.round((totals.cacheRead / read) * 100);
}

/**
 * How many MCP servers the agent's config declares, ignoring the explicitly off ones.
 *
 * A server counts unless its entry says so: `enabled: false` or `disabled: true`.
 * Text that cannot be read as an object with an `mcpServers` object yields
 * `undefined`, as does a config where every server is off. This never throws: a
 * malformed file is a configuration the panel reports around, not a crash.
 */
export function countMcpServers(text: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return undefined;
  }

  let enabled = 0;
  for (const entry of Object.values(servers)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      if (record.enabled === false || record.disabled === true) {
        continue;
      }
    }
    enabled += 1;
  }

  return enabled === 0 ? undefined : enabled;
}

/**
 * The current branch, or `undefined` when git printed no branch.
 *
 * `git rev-parse --abbrev-ref HEAD` prints `HEAD` when the checkout is detached: that
 * is a state, not a branch name, so it is dropped rather than shown where a branch
 * belongs.
 */
export function parseBranch(stdout: string): string | undefined {
  const branch = stdout.trim();
  if (!branch || branch === "HEAD") {
    return undefined;
  }
  return branch;
}

/**
 * The live figures, each present only when it can be computed.
 *
 * Formatting is delegated to the usage module's own formatters so the column and the
 * report never disagree. Percentages carry `%` with a space before it, the Spanish
 * convention used across this extension. A cost of exactly zero is left out instead
 * of occupying the column with a meaningless `0`.
 */
export function describeLiveStats(totals: UsageTotals, contextWindow?: number): LiveStats {
  const stats: LiveStats = {};

  const context = contextPercent(totals, contextWindow);
  if (context !== undefined) {
    stats.context = `${context} %`;
  }

  if (totals.cost > 0) {
    stats.cost = formatCost(totals.cost);
  }

  const tokens = totals.input + totals.output;
  if (tokens > 0) {
    stats.tokens = formatTokens(tokens);
  }

  const cache = cacheHitPercent(totals);
  if (cache !== undefined) {
    stats.cache = `${cache} %`;
  }

  return stats;
}

/**
 * The environment figures, each present only when it was given.
 *
 * Counts become plain decimal strings and names are taken as they come. A field that
 * is missing is omitted, never rendered as the word `undefined`.
 */
export function describeEnvironment(input: {
  mcps?: number;
  sessions?: number;
  project?: string;
  branch?: string;
}): EnvironmentStats {
  const stats: EnvironmentStats = {};

  if (input.mcps !== undefined) {
    stats.mcps = String(input.mcps);
  }
  if (input.sessions !== undefined) {
    stats.sessions = String(input.sessions);
  }
  if (input.project !== undefined) {
    stats.project = input.project;
  }
  if (input.branch !== undefined) {
    stats.branch = input.branch;
  }

  return stats;
}
