/*
 * Which profile an instance uses, and what a profile holds — read-only.
 *
 * The two-instances feature, gathered in one place: the resolver, the facts a spawner
 * needs, the concrete directory a reader uses and the inventory. Every site that
 * launches pi follows `instanceProfileEnv()`, and every site that reads a profile
 * follows `selectedAgentDir()`, so the switch has exactly one place to ask "what
 * profile is this instance using" instead of a `resolveAgentDir()` call at every
 * reader. The anti-mute guard lives in `instanceProfile()`, which both of those
 * consult, so the switch cannot be left half flipped.
 *
 * The parts are deliberately separate:
 *
 * - `instanceAgentDir()` maps a runtime mode to a profile directory, or to
 *   `undefined` when pi should resolve its own default. It never touches the disk,
 *   and it is deliberately unguarded: the import needs to name PiCode's own profile
 *   even while it is still empty.
 * - `instanceProfile()` names the facts separately — where the profile is, whether
 *   PiCode owns it, and what PiCode's own profile holds — and applies the anti-mute
 *   guard: the internal profile is the answer only once it can carry an instance.
 *   `instanceProfileEnv()` turns those facts into the environment additions a
 *   spawned pi receives, so the rule about setting the variable, or deliberately
 *   not setting it, lives in one place instead of at each of the spawn sites.
 * - `selectedAgentDir()` answers a reader that needs a directory rather than an
 *   environment: the guarded selection when PiCode owns it, the machine's profile
 *   otherwise. It is the only place that composes that fallback, so no reader can
 *   end up on the other instance's profile.
 * - `instanceProfileDir()` answers a *writer*: the profile of the selected instance,
 *   always a concrete directory and never guarded, because the provider login exists
 *   to fill PiCode's own profile while it is still empty.
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

// `resolveAgentDir` — the machine's profile — is deliberately no longer imported here. It is
// still the right answer for the one-time import, which is the only act that is about the
// external pi; any other reader or writer following it would be reading or writing `~/.pi/`,
// which the owner has ruled out.

/* ------------------------------------------------------------------ *
 * The resolver
 * ------------------------------------------------------------------ */

/**
 * The profile PiCode's own instance would use: `<distribution>/data/pi-agent`.
 *
 * The distribution root is derived from `managedRoot` rather than recomputed here:
 * that function already walks the four levels from the extension up to the
 * distribution, so reusing it keeps a single source of truth and rules out the
 * off-by-one that would place the profile outside the distribution.
 *
 * Kept apart from `instanceAgentDir()` because the guard and the row both have to
 * name PiCode's own profile even when the selected instance is the owner's, and
 * `instanceAgentDir()` deliberately answers only for the selection.
 */
function internalAgentDir(extensionUri: Uri): string {
  // <distribution>/resources/pi-runtime -> <distribution>
  const distributionRoot = path.resolve(managedRoot(extensionUri), "..", "..");
  return path.join(distributionRoot, "data", "pi-agent");
}

/**
 * The profile directory of the selected instance, or `undefined` when pi must
 * resolve its own.
 *
 * `managed` runs PiCode's own pi, whose profile lives inside the distribution at
 * `<distribution>/data/pi-agent`. `path` and `custom` run the owner's own pi, and
 * `undefined` is the honest answer: it means "do not set the variable and do not
 * pass a directory", so pi resolves its own default exactly as it does when run from
 * a terminal. PiCode only ever reads that profile; it never writes to it.
 *
 * This is the raw mapping and it is deliberately **not** guarded: the import writes
 * into PiCode's own profile, and a guard here would make importing into an empty
 * profile — the only way to fill it — impossible. The guard belongs in
 * `instanceProfile()`, which is what every spawner and every reader follows.
 */
export function instanceAgentDir(extensionUri: Uri, _runtime: RuntimeMode): string {
  // PiCode's own profile, always. See `instanceProfileDir` for why the mode no longer
  // changes the answer, and why the parameter is still here (unused, and named so).
  return internalAgentDir(extensionUri);
}

/**
 * The profile directory of the selected instance, always a concrete directory.
 *
 * This is the answer a **writer** needs, and it is deliberately neither of the two
 * other answers this module gives. `instanceAgentDir()` says `undefined` for the
 * owner's instance, which is right for a spawner — pi then resolves its own default —
 * and useless for a login, which has to name the directory it writes. And
 * `selectedAgentDir()` applies the anti-mute guard, which is right for a reader and
 * wrong here: a login exists to fill PiCode's own profile while it is still empty, and
 * the guard answers the machine's profile precisely then.
 *
 * So the mapping is total, and it is now **the same directory for every instance**:
 * PiCode's own. An earlier decision wrote into the owner's profile when his pi was the
 * selected instance — «es configurar ese pi» — and the owner reversed it: nothing is saved
 * in the external pi. `~/.pi/` is not written, and reading it is only ever the explicit
 * import.
 *
 * `resolveAgentDir()` is therefore no longer reachable from here. It is still the right
 * answer for the import, which is the one act that is *about* the machine's profile.
 */
export function instanceProfileDir(extensionUri: Uri, _runtime: RuntimeMode): string {
  return internalAgentDir(extensionUri);
}

/**
 * The profile a write went into, said in words instead of by path.
 *
 * There is only one possible answer now — PiCode's own profile — so the parameter is gone.
 * It is kept as a function rather than a constant because three surfaces read it (the
 * provider login, the custom-endpoint rows and the settings panel) and one wording is what
 * stops them describing the same directory differently.
 */
export function profileNameFor(): string {
  return "el perfil propio de PiCode";
}

/* ------------------------------------------------------------------ *
 * What a spawner needs
 * ------------------------------------------------------------------ */

/**
 * What PiCode's own profile holds, read while the resolver answered.
 *
 * `providers` is the number of top-level keys in `auth.json` — the credential
 * *names*, never a value. The row that says which profile is in use renders them from
 * here instead of reading the profile again, so the guard and the row can never
 * disagree about the same profile.
 */
export interface InternalProfileFacts {
  /** Whether PiCode's own profile directory exists. */
  exists: boolean;
  /** Providers with stored credentials in it. */
  providers: number;
}

/**
 * The profile of the selected instance, as separate facts.
 *
 * They are deliberately not folded into one value: `agentDir` answers *where* the
 * profile is, `owned` answers *whether PiCode may write there and did select it*, and
 * `internal` answers what PiCode's own profile holds. PiCode owns only the managed
 * profile; the owner's belongs to the machine and to every other pi tool on it, so
 * PiCode reads it and never writes it. A caller that has to refuse a write (the guard
 * that keeps an empty internal profile from being switched on) has to ask the second
 * question, and a single "the profile" value could not answer it.
 */
export interface InstanceProfile {
  /**
   * PiCode's own profile directory: always a directory, never `undefined`.
   *
   * It used to be optional, and `undefined` meant "let pi resolve its own" — which sent
   * every write into `~/.pi/`. With one pi and one profile there is nothing to resolve, so
   * the type says so instead of leaving a caller to remember it.
   */
  agentDir: string;
  /** True only when the selected instance is PiCode's own and its profile is usable. */
  owned: boolean;
  /** What PiCode's own profile holds, read in the same pass as this answer. */
  internal: InternalProfileFacts;
}

/**
 * Whether PiCode's own profile can carry an instance: the directory exists and
 * `auth.json` names at least one provider.
 *
 * This is the anti-mute rule, and it is why the guard sits here rather than in a
 * caller. A managed instance whose profile holds no credentials cannot talk to a
 * model, and — because the switch points every spawn and every write at that same
 * profile — it is not isolation but a broken editor. So a profile that is absent,
 * empty or unreadable is "not usable", and the resolver falls back to exactly the
 * behaviour that predates this feature: the machine's own profile.
 *
 * The credentials are read with the credential parser this module already has, which
 * takes the file's top-level keys and nothing else, so a secret cannot travel out of
 * `auth.json` even to decide whether there is one.
 */
function readInternalProfile(agentDir: string): { usable: boolean; facts: InternalProfileFacts } {
  const exists = existsSync(agentDir);
  const providers = parseCredentials(readJson(path.join(agentDir, "auth.json"))).count;
  return { usable: exists && providers > 0, facts: { exists, providers } };
}

/**
 * The facts about the selected instance's profile, with the anti-mute guard applied.
 *
 * `owned` is derived from the guard rather than from the mode alone: nothing about the
 * path says who may write it, and a managed profile whose directory happens to live
 * somewhere unusual is still PiCode's own — but it only becomes the answer once it can
 * actually carry an instance. Until then the resolver answers the machine's profile
 * (an `undefined` `agentDir`) with `owned: false`, so every spawn and every reader
 * keeps following today's behaviour and the switch cannot be left half flipped.
 */
export function instanceProfile(extensionUri: Uri, _runtime: RuntimeMode): InstanceProfile {
  const internalDir = internalAgentDir(extensionUri);
  const internal = readInternalProfile(internalDir);
  return {
    // Always PiCode's own. The anti-mute guard no longer diverts to the machine's profile:
    // the owner asked for the internal one and only the internal one. What the guard found
    // is still reported, in `internal`, because the surfaces that explain an unusable
    // profile still need it — the fallback was the part that had to go, not the reading.
    agentDir: internalDir,
    owned: true,
    internal: internal.facts,
  };
}

/**
 * The environment additions that point a spawned program at the selected instance's
 * profile: the variable, or an empty object.
 *
 * The variable is now set for **every** instance, to PiCode's own profile. It used to be
 * left unset for the owner's pi so that pi resolved its own default — which is precisely
 * what must not happen any more: an unset variable sends every write (settings, sessions,
 * credentials) into `~/.pi/`, and the owner asked for nothing to be saved there.
 *
 * Setting it always also removes the asymmetry the old rule needed, which is one less
 * branch at the spawn sites.
 */
export function instanceProfileEnv(profile: InstanceProfile): Record<string, string> {
  return { PI_CODING_AGENT_DIR: profile.agentDir };
}

/* ------------------------------------------------------------------ *
 * What a reader needs
 * ------------------------------------------------------------------ */

/**
 * The concrete profile directory the selected instance is actually using.
 *
 * There is no fallback any more: the answer is PiCode's own profile, so it agrees with the
 * spawns and with the writes by construction. The old version fell back to the machine's
 * profile while the guard said the internal one could not carry an instance, and that is
 * the behaviour the owner reversed — nothing may be read from `~/.pi/` either, because a
 * reader following it would report a profile the editor is not using.
 */
export function selectedAgentDir(extensionUri: Uri, runtime: RuntimeMode): string {
  return instanceProfile(extensionUri, runtime).agentDir;
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
