/*
 * Where pi's skills come from, and what PiCode knows about them.
 *
 * The three routes are automatic: no path is ever typed by hand. pi's own default
 * directory, the skills every installed package contributes through its `pi`
 * manifest, and the current project's own directory. They mirror what pi's own
 * package manager resolves, so a listing here is what pi will actually load.
 *
 * The module is split on purpose. Parsing and the on/off arithmetic are pure and
 * touch no filesystem, so they can be exercised directly; the walking around them
 * is thin and never lets an unreadable directory or a broken skill abort the whole
 * listing. The panel renders whatever was found, plus the problems beside it.
 *
 * Only a package skill can be switched: pi filters packages, and nothing else.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseInstalledPackages, runPiCli, type InstalledPackage } from "./pi-cli";
import { packageSkillFilter, type PiPackageEntry } from "./pi-settings";
import type { ResolvedRuntime } from "./runtime";

/** Which automatic route a skill was found on. */
export type SkillSource = "pi" | "package" | "project";

/** One skill, as the settings table will render it. */
export interface DiscoveredSkill {
  /**
   * Registered name: the frontmatter `name`, or the directory name when the
   * frontmatter is incomplete, which is what pi itself falls back to.
   */
  name: string;
  description: string;
  source: SkillSource;
  /** The package's source spec (`npm:gentle-pi`); only the package route carries it. */
  packageSource?: string;
  /** The package's display name (its manifest `name`), for labelling the row. */
  packageName?: string;
  /**
   * The token pi's filter matches: the POSIX-relative path from the package root to
   * the skill's `SKILL.md`. This is what {@link DiscoveredSkill.canToggle} switches.
   */
  pattern?: string;
  /** True only for a package skill: pi filters packages, so nothing else is switchable. */
  canToggle: boolean;
  /** Whether pi is loading it now. */
  enabled: boolean;
  /** Absolute directory the skill lives in. */
  dir: string;
  /** Absolute path of its `SKILL.md`. */
  path: string;
}

/**
 * Something that could not be read. A problem never aborts the listing: the panel
 * shows the skills that were found and the problems next to them.
 */
export interface SkillDiscoveryProblem {
  source: SkillSource;
  path: string;
  /** User-facing Spanish text, ready to show. */
  message: string;
}

export interface SkillDiscoveryResult {
  skills: DiscoveredSkill[];
  problems: SkillDiscoveryProblem[];
  /**
   * What every installed package's own manifest knows.
   *
   * pi stores a package as one source string, which carries a version only when the
   * spec was pinned and an author only when the package is scoped or comes from git.
   * The packages table cannot derive either from that string alone, so the host reads
   * every installed manifest once here and the table merges the facts at render time.
   */
  packageFacts: InstalledPackageFacts[];
}

/** The version, author and repository owner a package manifest knows. */
export interface PackageFacts {
  /** The manifest's `version`. */
  version?: string;
  /** The manifest's `author`, as a string or the `name` of its object form. */
  author?: string;
  /** The owner of the manifest's `repository` URL, the author of last resort. */
  repositoryOwner?: string;
}

/** One installed package's facts, tied to the source a settings row is matched by. */
export interface InstalledPackageFacts extends PackageFacts {
  /** The source spec exactly as pi reports it, e.g. `npm:pi-lens`. */
  source: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
}

/** Runs `pi list` against the active runtime and parses it. Injected so tests stay hermetic. */
export type SkillPackageLister = () => Promise<readonly InstalledPackage[]>;

export interface SkillDiscoveryOptions {
  /** Global pi configuration directory: `resolveAgentDir()` in production. */
  agentDir: string;
  /** The project whose own skills directory is the third route. */
  cwd: string;
  /** The installed packages, resolved through the existing `pi list` parser. */
  listPackages: SkillPackageLister;
  /** pi's stored package entries: the pause and the filters live here, not in `pi list`. */
  packageEntries?: readonly PiPackageEntry[];
}

/* ------------------------------------------------------------------ *
 * Parsing — pure, no filesystem
 * ------------------------------------------------------------------ */

/**
 * The `name` and `description` of a skill's frontmatter.
 *
 * The block is the leading text between the opening `---` line and the next one. A
 * value may be quoted or plain. A missing or empty `name` falls back to the
 * directory name — what pi does with an incomplete frontmatter — and a file with no
 * frontmatter at all keeps that fallback and an empty description instead of
 * failing the listing.
 */
export function parseSkillFrontmatter(text: string, fallbackName: string): SkillFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") {
    return { name: fallbackName, description: "" };
  }

  let name = "";
  let description = "";
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      break;
    }
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const value = unquote(match[2].trim());
    if (value.length === 0) {
      continue;
    }
    if (match[1] === "name") {
      name = value;
    } else if (match[1] === "description") {
      description = value;
    }
  }

  return { name: name.length > 0 ? name : fallbackName, description };
}

/** Removes one layer of matching quotes from a frontmatter value. */
function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value[value.length - 1] === first) {
    return value.slice(1, -1);
  }
  return value;
}

/** A package's `pi` manifest, reduced to what names and locates its skills. */
export interface PiSkillManifest {
  name?: string;
  skills: string[];
}

/**
 * Reads a package's `pi` manifest. `undefined` means the package contributes no
 * skills: a missing or malformed manifest, no `pi` block, or no declared `skills`
 * is a package without skills, which is not a problem to report.
 */
export function parsePiManifest(text: string): PiSkillManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const pi = record.pi;
  if (typeof pi !== "object" || pi === null) {
    return undefined;
  }
  const declared: string[] = [];
  const skills = (pi as Record<string, unknown>).skills;
  if (Array.isArray(skills)) {
    for (const entry of skills) {
      if (typeof entry === "string" && entry.trim() !== "") {
        declared.push(entry);
      }
    }
  }
  const name = record.name;
  return {
    ...(typeof name === "string" && name.trim() !== "" ? { name } : {}),
    skills: declared,
  };
}

/**
 * A manifest `author`, read as the string it is or as the `name` of its object form.
 *
 * `maintainers` and `_npmUser` are deliberately not consulted: they are absent from
 * the copies npm installs, so relying on them would leave the column empty for the
 * packages that do carry an `author`.
 */
function authorName(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "object" && value !== null) {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim() !== "") {
      return name.trim();
    }
  }
  return undefined;
}

/** The `url` of a `repository` object, or `undefined` for any other shape. */
function repositoryUrl(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const url = (value as Record<string, unknown>).url;
  return typeof url === "string" ? url : undefined;
}

/**
 * The owner of a repository URL, in any of the shapes npm accepts.
 *
 * A full URL (`git+https://github.com/apmantza/pi-lens.git`), a scp-style one
 * (`git@github.com:owner/repo.git`), the `github:owner/repo` shorthand and the bare
 * `owner/repo` one all resolve to their first path segment. `undefined` means nothing
 * could be read rather than a guessed segment, so the author column stays empty
 * instead of showing a host name.
 */
function ownerOfRepository(value: unknown): string | undefined {
  let text = typeof value === "string" ? value : repositoryUrl(value);
  if (typeof text !== "string") {
    return undefined;
  }
  text = text.trim();
  if (text === "") {
    return undefined;
  }

  // `github:owner/repo` and its siblings name the owner right after the scheme word.
  const shorthand = /^(?:github|gitlab|bitbucket|gist):(.+)$/i.exec(text);
  if (shorthand !== null) {
    text = shorthand[1];
  }

  // A full URL, or an scp-style one that keeps the host and the path together with a
  // colon: drop the scheme and the host, and the first path segment is what remains.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[^/]+@[^/]+:/.test(text)) {
    const rest = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]+@/, "");
    const colon = rest.indexOf(":");
    const slash = rest.indexOf("/");
    let start = -1;
    if (colon !== -1 && (slash === -1 || colon < slash)) {
      // The scp form keeps the host and the path together: `host:owner/repo`.
      start = colon + 1;
    } else if (slash !== -1) {
      start = slash + 1;
    }
    text = start === -1 ? "" : rest.slice(start);
  }

  const segments = text.split("/").filter((segment) => segment !== "");
  return segments.length > 0 ? segments[0] : undefined;
}

/**
 * The facts a package's own manifest knows that the stored source string does not:
 * its version, its author, and the owner of its repository as the author of last
 * resort. `undefined` means the text is not a readable manifest at all; an object
 * with none of the three is a readable manifest that knows nothing extra.
 */
export function parsePackageFacts(text: string): PackageFacts | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const facts: PackageFacts = {};

  if (typeof record.version === "string" && record.version.trim() !== "") {
    facts.version = record.version.trim();
  }
  const author = authorName(record.author);
  if (author !== undefined) {
    facts.author = author;
  }
  const owner = ownerOfRepository(record.repository);
  if (owner !== undefined) {
    facts.repositoryOwner = owner;
  }

  return facts;
}

/**
 * The token pi's filter matches for one skill: the POSIX-relative path from the
 * package root to its `SKILL.md`. pi's own package editor writes the same string, so
 * a filter PiCode writes and one pi's TUI writes have the same shape.
 */
export function skillFilterPattern(packageRoot: string, skillPath: string): string {
  return path.relative(packageRoot, skillPath).split(path.sep).join("/");
}

/**
 * Whether pi currently loads one skill of a package.
 *
 * The `skills` key is read in two modes, exactly as pi's own
 * `collectPackageResources` does (it picks `applyPackageFilter` or
 * `applyPackageDeltaFilter` from the autoload):
 *
 * - no key at all: with the default autoload every skill loads, and with
 *   `autoload: false` nothing loads;
 * - key present: with the default autoload it is an allow-list, where an empty list
 *   loads nothing; with `autoload: false` it is a delta, where an empty list also
 *   loads nothing and a named pattern turns that skill on.
 *
 * A `+`/`-`/`!` marker is honoured because pi writes those when its own editor
 * force-includes or force-excludes a single resource.
 */
export function packageLoadsSkill(entry: PiPackageEntry, pattern: string): boolean {
  const filter = packageSkillFilter(entry);
  if (filter === undefined) {
    return !entry.paused;
  }
  let enabled = false;
  for (const candidate of filter) {
    const marker = candidate[0];
    const target =
      marker === "+" || marker === "-" || marker === "!" ? candidate.slice(1) : candidate;
    if (target === pattern) {
      enabled = marker !== "-" && marker !== "!";
    }
  }
  return enabled;
}

/* ------------------------------------------------------------------ *
 * The filesystem walk — thin around the pure helpers above
 * ------------------------------------------------------------------ */

/** A `SKILL.md` that was found and read, before its frontmatter is parsed. */
interface ReadSkill {
  dir: string;
  file: string;
  text: string;
}

type ReadText = { ok: true; text: string } | { ok: false; error: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readText(file: string): ReadText {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function statKind(target: string): "file" | "directory" | undefined {
  try {
    const stats = statSync(target);
    if (stats.isDirectory()) {
      return "directory";
    }
    return stats.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every skill directly under one declared skills directory: a `SKILL.md` in the
 * directory itself and one `SKILL.md` per immediate subdirectory. A subdirectory
 * whose `SKILL.md` is missing or unreadable is skipped and reported, never fatal.
 */
function collectSkills(
  directory: string,
  source: SkillSource,
): { skills: ReadSkill[]; problems: SkillDiscoveryProblem[] } {
  const skills: ReadSkill[] = [];
  const problems: SkillDiscoveryProblem[] = [];

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    problems.push({
      source,
      path: directory,
      message: `No se pudo leer la carpeta de skills ${directory}: ${messageOf(error)}`,
    });
    return { skills, problems };
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isFile() && entry.name === "SKILL.md") {
      const read = readText(full);
      if (read.ok) {
        skills.push({ dir: directory, file: full, text: read.text });
      } else {
        problems.push({
          source,
          path: full,
          message: `No se pudo leer ${full}: ${read.error}`,
        });
      }
      continue;
    }

    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const file = path.join(full, "SKILL.md");
    const read = readText(file);
    if (read.ok) {
      skills.push({ dir: full, file, text: read.text });
    } else {
      problems.push({
        source,
        path: full,
        message: `La skill «${entry.name}» no tiene un SKILL.md legible: ${read.error}`,
      });
    }
  }

  return { skills, problems };
}

function buildSkill(
  read: ReadSkill,
  source: SkillSource,
  options: {
    canToggle: boolean;
    enabled: boolean;
    packageSource?: string;
    packageName?: string;
    pattern?: string;
  },
): DiscoveredSkill {
  const frontmatter = parseSkillFrontmatter(read.text, path.basename(read.dir));
  const skill: DiscoveredSkill = {
    name: frontmatter.name,
    description: frontmatter.description,
    source,
    canToggle: options.canToggle,
    enabled: options.enabled,
    dir: read.dir,
    path: read.file,
  };
  if (options.packageSource !== undefined) {
    skill.packageSource = options.packageSource;
  }
  if (options.packageName !== undefined) {
    skill.packageName = options.packageName;
  }
  if (options.pattern !== undefined) {
    skill.pattern = options.pattern;
  }
  return skill;
}

/**
 * The skills one installed package contributes. A package with no manifest, no `pi`
 * block or no declared skills contributes none; each declared path is walked as a
 * directory (or taken as one file when it names a `SKILL.md` directly).
 */
function collectPackageSkills(
  pkg: InstalledPackage,
  packageEntries: ReadonlyMap<string, PiPackageEntry>,
  skills: DiscoveredSkill[],
  problems: SkillDiscoveryProblem[],
  packageFacts: InstalledPackageFacts[],
): void {
  if (pkg.path === undefined || pkg.path.trim() === "") {
    problems.push({
      source: "package",
      path: pkg.source,
      message: `El paquete ${pkg.source} no publica una ruta, así que no se pueden leer sus skills.`,
    });
    return;
  }

  const root = pkg.path;
  const manifestRead = readText(path.join(root, "package.json"));
  // The facts are recorded for every installed package, including one whose `pi`
  // block declares no skills: a version and an author are not skill metadata.
  if (manifestRead.ok) {
    const facts = parsePackageFacts(manifestRead.text);
    if (facts !== undefined) {
      packageFacts.push({ source: pkg.source, ...facts });
    }
  }
  const manifest = manifestRead.ok ? parsePiManifest(manifestRead.text) : undefined;
  if (manifest === undefined || manifest.skills.length === 0) {
    return;
  }

  const displayName = manifest.name ?? pkg.source;
  const entry = packageEntries.get(pkg.source);

  const pushSkill = (read: ReadSkill): void => {
    const pattern = skillFilterPattern(root, read.file);
    skills.push(
      buildSkill(read, "package", {
        canToggle: true,
        enabled: entry === undefined ? true : packageLoadsSkill(entry, pattern),
        packageSource: pkg.source,
        packageName: displayName,
        pattern,
      }),
    );
  };

  for (const declared of manifest.skills) {
    const target = path.resolve(root, declared);
    const kind = statKind(target);

    if (kind === "file") {
      const read = readText(target);
      if (read.ok) {
        pushSkill({ dir: path.dirname(target), file: target, text: read.text });
      } else {
        problems.push({
          source: "package",
          path: target,
          message: `No se pudo leer ${target}: ${read.error}`,
        });
      }
      continue;
    }

    if (kind !== "directory") {
      problems.push({
        source: "package",
        path: target,
        message: `La carpeta de skills «${declared}» de ${displayName} no existe.`,
      });
      continue;
    }

    const collected = collectSkills(target, "package");
    problems.push(...collected.problems);
    for (const read of collected.skills) {
      pushSkill(read);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/**
 * The real package source: `pi list` against the active runtime, through the
 * existing parser. The extension hands this to {@link discoverSkills}, so a skills
 * listing always talks to the same pi the chat runs — and, through `env`, to the same
 * *profile*: the packages a listing reports are the ones the selected instance has,
 * and asking the machine's profile instead would describe a different installation
 * without saying so.
 */
export function installedPackagesLister(
  runtime: ResolvedRuntime,
  env: Record<string, string>,
): SkillPackageLister {
  return async () => {
    const result = await runPiCli(runtime, ["list"], undefined, () => {}, env);
    return parseInstalledPackages(result.text);
  };
}

/**
 * Lists every skill pi can see and whether it is switchable.
 *
 * Never throws: a directory that cannot be read, a package that cannot be listed or
 * a broken skill becomes a problem, and whatever was found is returned. That is what
 * lets the panel render a listing instead of an error.
 */
export async function discoverSkills(
  options: SkillDiscoveryOptions,
): Promise<SkillDiscoveryResult> {
  const skills: DiscoveredSkill[] = [];
  const problems: SkillDiscoveryProblem[] = [];
  const packageFacts: InstalledPackageFacts[] = [];

  const collectRoute = (directory: string, source: SkillSource): void => {
    const collected = collectSkills(directory, source);
    problems.push(...collected.problems);
    for (const read of collected.skills) {
      // pi's own directory and the project's are not filtered by pi's package
      // settings, so they are always on and never switchable.
      skills.push(buildSkill(read, source, { canToggle: false, enabled: true }));
    }
  };

  try {
    // Route 1: pi's own default skills directory, in the agent directory.
    collectRoute(path.join(options.agentDir, "skills"), "pi");
    // Route 3: the current project's own skills directory.
    collectRoute(path.join(options.cwd, ".pi", "skills"), "project");

    // Route 2: what every installed package contributes.
    const packageEntries = new Map(
      (options.packageEntries ?? []).map((entry) => [entry.source, entry]),
    );
    let packages: readonly InstalledPackage[] = [];
    try {
      packages = await options.listPackages();
    } catch (error) {
      problems.push({
        source: "package",
        path: "",
        message: `No se pudieron listar los paquetes instalados: ${messageOf(error)}`,
      });
    }
    for (const pkg of packages) {
      collectPackageSkills(pkg, packageEntries, skills, problems, packageFacts);
    }
  } catch (error) {
    // The walk already reports its own failures; this is the last net, because the
    // panel must render whatever was found rather than nothing at all.
    problems.push({
      source: "package",
      path: "",
      message: `No se pudieron leer todas las skills: ${messageOf(error)}`,
    });
  }

  return { skills, problems, packageFacts };
}
