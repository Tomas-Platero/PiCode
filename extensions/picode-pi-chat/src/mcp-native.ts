/*
 * pi's MCP servers, re-expressed in the editor's own `.vscode/mcp.json`.
 *
 * The two files say the same thing in different words, and neither is a superset:
 * pi keeps its servers under `mcpServers`, the editor reads `servers`, and an entry
 * that is a command for one is a `type: "stdio"` for the other. This module is that
 * translation and nothing else — it does not spawn a server, resolve a variable or
 * read a workspace.
 *
 * Why re-express instead of pointing the editor at pi's file: `mcp.json` is CORE
 * behaviour of the editor and does not come from Copilot, so servers declared here
 * appear in the native picker with no extension of anyone's installed. Reading pi's
 * file from here would leave the editor with nothing to show.
 *
 * The translation is deliberately lossy in one direction and honest about it: a server
 * entry that is neither a command nor a URL has no native equivalent, so it is
 * reported as skipped with the reason rather than dropped in silence.
 */

import type { JsonValue } from "./instance";

/** One server, in the shape the editor's `.vscode/mcp.json` reads. */
export interface NativeMcpServer {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface NativeMcpConfig {
  servers: Record<string, NativeMcpServer>;
}

/** A server that had no native equivalent, and why. Owner-facing, so Spanish. */
export interface SkippedMcpServer {
  name: string;
  reason: string;
}

export interface McpMigration {
  config: NativeMcpConfig;
  /** In declaration order: a report that reorders its own entries is harder to read. */
  skipped: SkippedMcpServer[];
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A string map, keeping only the entries that are actually strings. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A string list, or `undefined` when what was declared is not a list of strings. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((entry): entry is string => typeof entry === "string");
  return out.length > 0 ? out : undefined;
}

/** Translates one pi server entry, or explains why it cannot be translated. */
export function toNativeServer(entry: JsonValue): NativeMcpServer | SkippedMcpServer {
  if (!isRecord(entry)) {
    return { name: "", reason: "la entrada no es un objeto" };
  }

  const command = nonEmptyString(entry.command);
  const url = nonEmptyString(entry.url);

  // A command wins when both are present: an entry that can be spawned is a stdio
  // server, and reading its `url` would describe a different server than pi runs.
  if (command !== undefined) {
    const args = stringList(entry.args);
    const env = stringMap(entry.env);
    return {
      type: "stdio",
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
    };
  }

  if (url !== undefined) {
    const headers = stringMap(entry.headers);
    return { type: "http", url, ...(headers === undefined ? {} : { headers }) };
  }

  return { name: "", reason: "no declara ni `command` ni `url`" };
}

/**
 * Translates a whole pi `mcp.json` document.
 *
 * A document that is not an object, or that has no `mcpServers` object, yields an empty
 * configuration rather than throwing: "there is nothing to migrate" is a legitimate
 * answer, and a caller shows it as one.
 */
export function toNativeMcp(piConfig: JsonValue | undefined): McpMigration {
  const servers: Record<string, NativeMcpServer> = {};
  const skipped: SkippedMcpServer[] = [];

  const declared = isRecord(piConfig) && isRecord(piConfig.mcpServers) ? piConfig.mcpServers : undefined;
  if (declared === undefined) {
    return { config: { servers }, skipped };
  }

  for (const [name, entry] of Object.entries(declared)) {
    const translated = toNativeServer(entry);
    if ("type" in translated) {
      servers[name] = translated;
    } else {
      skipped.push({ name, reason: translated.reason });
    }
  }

  return { config: { servers }, skipped };
}

/**
 * The exact bytes of a `.vscode/mcp.json`, with a trailing newline.
 *
 * Written here rather than at the call site so the file the owner gets and the file the
 * tests pin are the same one.
 */
export function mcpJsonText(migration: McpMigration): string {
  return `${JSON.stringify(migration.config, null, 2)}\n`;
}
