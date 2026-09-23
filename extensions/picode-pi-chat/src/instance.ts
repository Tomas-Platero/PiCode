/*
 * Which profile an instance uses, and what a profile holds — read-only.
 *
 * Slice 1 of the two-instances feature: the resolver and the inventory. Nothing here
 * is wired to the spawn environment, the SDK client, the settings service or the
 * skills discovery yet, so this module changes no behaviour on its own. It exists so
 * that the switch (slice 3) has exactly one place to ask "what profile is this
 * instance using" instead of a `resolveAgentDir()` call at every reader.
 *
 * The two halves are deliberately separate:
 *
 * - `instanceAgentDir()` maps a runtime mode to a profile directory, or to
 *   `undefined` when pi should resolve its own default. It never touches the disk.
 * - `scanProfile()` reads a profile directory and returns an inventory. Its parsing
 *   is pure (`parsePackages`, `parseCredentials`, `parseModels`, `parseMcpServers`),
 *   so both the shapes and the walk can be exercised without a filesystem, and a
 *   missing or half-written file is an empty section rather than an exception — the
 *   scan runs against a profile that may be a stranger's, half-written or absent.
 *
 * The inventory is metadata only. In particular it never carries a credential value
 * or the bytes of `auth.json`: `parseCredentials` reads the file's top-level keys and
 * nothing else, so a secret cannot travel out of the file even if the shape changes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { Uri } from "vscode";
import { managedRoot, type RuntimeMode } from "./runtime";

/* ------------------------------------------------------------------ *
 * The resolver
 * ------------------------------------------------------------------ */

/**
 * The profile directory of the selected instance, or `undefined` when pi must
 * resolve its own.
 *
 * `managed` runs PiCode's own pi, whose profile lives inside the distribution at
 * `<distribution>/data/pi-agent`. The distribution root is derived from
 * `managedRoot` rather than recomputed here: that function already walks the four
 * levels from the extension up to the distribution, so reusing it keeps a single
 * source of truth and rules out the off-by-one that would place the profile outside
 * the distribution.
 *
 * `path` and `custom` run the owner's own pi, and `undefined` is the honest answer:
 * it means "do not set the variable and do not pass a directory", so pi resolves its
 * own default exactly as it does when run from a terminal. PiCode only ever reads
 * that profile; it never writes to it.
 */
export function instanceAgentDir(extensionUri: Uri, runtime: RuntimeMode): string | undefined {
  if (runtime !== "managed") {
    return undefined;
  }
  // <distribution>/resources/pi-runtime -> <distribution>
  const distributionRoot = path.resolve(managedRoot(extensionUri), "..", "..");
  return path.join(distributionRoot, "data", "pi-agent");
}

/* ------------------------------------------------------------------ *
 * The inventory shapes
 * ------------------------------------------------------------------ */

/** The packages a profile configures: how many and their sources. */
export interface PackageInventory {
  count: number;
  sources: string[];
}

/**
 * The providers with stored credentials: names and how many.
 *
 * There is deliberately no field for a value, a token or a type. Nothing about the
 * credential itself is part of this shape, which is what makes it impossible to
 * render one by accident.
 */
export interface CredentialInventory {
  count: number;
  providers: string[];
}

/** The models a profile configures: provider count, model count and provider ids. */
export interface ModelsInventory {
  providerCount: number;
  modelCount: number;
  providerIds: string[];
}

/** How an MCP server is reached: a command to spawn, a URL to call, or neither. */
export type McpServerKind = "command" | "url" | "unknown";

export interface McpServer {
  name: string;
  kind: McpServerKind;
}

export interface McpInventory {
  count: number;
  servers: McpServer[];
}

/**
 * Whether a directory exists and, when it can be listed, how many entries it holds.
 *
 * `count` is absent rather than zero when the directory exists but cannot be read: an
 * unknown number is not an empty one, and collapsing the two would report a directory
 * full of sessions as empty.
 */
export interface DirectoryInventory {
  exists: boolean;
  count?: number;
}

/** What a read-only pass over a profile found. Every section is present, empty or not. */
export interface ProfileInventory {
  /** The profile directory that was scanned, for the report and the tests. */
  agentDir: string;
  packages: PackageInventory;
  credentials: CredentialInventory;
  models: ModelsInventory;
  mcp: McpInventory;
  /** How many skills the profile's own `skills` directory holds. */
  skills: number;
  memory: DirectoryInventory;
  sessions: DirectoryInventory;
}

/* ------------------------------------------------------------------ *
 * Pure parsing — no filesystem
 * ------------------------------------------------------------------ */

/**
 * Any value a JSON file can hold, before it is checked for the shape this module
 * expects. Parsing produces this and the parsers narrow it; nothing downstream of a
 * parser sees it.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object, which is what every file here is expected to hold. */
function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `packages` array of `settings.json`.
 *
 * pi stores each entry as a source string or as an object that filters the package's
 * resources; only the source is needed for an inventory, so both shapes resolve to
 * the same string. Anything else in the array is skipped rather than guessed.
 */
export function parsePackages(settings: JsonValue | undefined): PackageInventory {
  const sources: string[] = [];
  if (isRecord(settings) && Array.isArray(settings.packages)) {
    for (const entry of settings.packages) {
      if (typeof entry === "string" && entry.trim() !== "") {
        sources.push(entry);
      } else if (isRecord(entry) && typeof entry.source === "string" && entry.source.trim() !== "") {
        sources.push(entry.source);
      }
    }
  }
  return { count: sources.length, sources };
}

/**
 * The provider names of `auth.json`.
 *
 * Only the keys are read; the value of every entry is a secret and is never opened.
 * A file that is not a JSON object has no providers to report, which is the same as
 * a profile with no credentials — not an error.
 */
export function parseCredentials(auth: JsonValue | undefined): CredentialInventory {
  const providers = isRecord(auth) ? Object.keys(auth).filter((name) => name.trim() !== "") : [];
  return { count: providers.length, providers };
}

/**
 * The providers and models of `models.json`.
 *
 * pi nests the models under `providers`; the ids are the keys and the model count is
 * the sum of each provider's `models` array. A provider without a `models` array
 * contributes its id and no models rather than aborting the count.
 */
export function parseModels(models: JsonValue | undefined): ModelsInventory {
  const providerIds: string[] = [];
  let modelCount = 0;
  if (isRecord(models) && isRecord(models.providers)) {
    for (const [id, provider] of Object.entries(models.providers)) {
      providerIds.push(id);
      if (isRecord(provider) && Array.isArray(provider.models)) {
        modelCount += provider.models.length;
      }
    }
  }
  return { providerCount: providerIds.length, modelCount, providerIds };
}

/** How one MCP server entry is reached, without reading anything else it carries. */
function mcpKind(entry: JsonValue | undefined): McpServerKind {
  if (!isRecord(entry)) {
    return "unknown";
  }
  if (typeof entry.command === "string" && entry.command.trim() !== "") {
    return "command";
  }
  if (typeof entry.url === "string" && entry.url.trim() !== "") {
    return "url";
  }
  return "unknown";
}

/**
 * The servers of `mcp.json`, each named and classified by how it is reached.
 *
 * Only the name and the presence of `command` or `url` are read: a server entry also
 * carries `env`, `headers` and OAuth data, and none of it belongs in an inventory.
 */
export function parseMcpServers(mcp: JsonValue | undefined): McpInventory {
  const servers: McpServer[] = [];
  const declared = isRecord(mcp) && isRecord(mcp.mcpServers) ? mcp.mcpServers : undefined;
  if (declared !== undefined) {
    for (const [name, entry] of Object.entries(declared)) {
      servers.push({ name, kind: mcpKind(entry) });
    }
  }
  return { count: servers.length, servers };
}

/* ------------------------------------------------------------------ *
 * The filesystem walk — thin around the pure parsers
 * ------------------------------------------------------------------ */

/**
 * A JSON file's value, or `undefined` when it cannot be read or parsed.
 *
 * A missing file, a broken one and one that is unreadable all mean the same thing at
 * this boundary: the section has nothing to report. Swallowing the error here is the
 * point of the scan, not an oversight.
 */
function readJson(file: string): JsonValue | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Whether a directory can be listed, and how many entries it holds when it can. */
function readDirectory(directory: string): DirectoryInventory {
  try {
    return { exists: true, count: readdirSync(directory).length };
  } catch {
    // A directory that exists but cannot be listed keeps its existence and drops the
    // count, so "unknown" never reads as "empty".
    return { exists: existsSync(directory) };
  }
}

/**
 * How many skills the profile's own `skills` directory holds.
 *
 * The rule mirrors `skills.ts`: a `SKILL.md` directly in the directory, plus one
 * `SKILL.md` per immediate subdirectory. A hidden directory and `node_modules` are
 * skipped because pi does not load skills from them either. Counting needs no file
 * content, so this only asks whether each `SKILL.md` is there.
 */
function countSkills(directory: string): number {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      count += 1;
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    if (existsSync(path.join(full, "SKILL.md"))) {
      count += 1;
    }
  }
  return count;
}

/**
 * A read-only inventory of one profile.
 *
 * Every section is built from a file or a directory that may not be there, so this
 * function never throws and never reports a partial file as a fact. It does not
 * write, and it does not read a credential value.
 */
export function scanProfile(agentDir: string): ProfileInventory {
  return {
    agentDir,
    packages: parsePackages(readJson(path.join(agentDir, "settings.json"))),
    credentials: parseCredentials(readJson(path.join(agentDir, "auth.json"))),
    models: parseModels(readJson(path.join(agentDir, "models.json"))),
    mcp: parseMcpServers(readJson(path.join(agentDir, "mcp.json"))),
    skills: countSkills(path.join(agentDir, "skills")),
    memory: readDirectory(path.join(agentDir, "memory")),
    sessions: readDirectory(path.join(agentDir, "sessions")),
  };
}
