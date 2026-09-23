import { spawn } from "node:child_process";
import { spawnTarget, type ResolvedRuntime } from "./runtime";

/**
 * PiCode's first integration that is not the RPC protocol.
 *
 * pi manages its own packages through the CLI — `pi install`, `pi remove`,
 * `pi update`, `pi list` — and the RPC surface does not expose them, so package
 * work runs the CLI of the *active* runtime. That is deliberate: if the owner
 * chose PiCode's own pi, the packages must be managed by that pi, not by whatever
 * happens to be on PATH.
 *
 * The *profile* is a separate question from the program, and it is why `runPiCli`
 * takes the environment additions rather than guessing: `instanceProfileEnv()` in
 * `instance.ts` is the single place that decides them, and a caller that forgets to
 * pass them would install into the machine's profile while believing it used the
 * selected one — silently, because both are valid directories. The parameter is
 * therefore required, not optional.
 */

export interface PiCliResult {
  ok: boolean;
  code: number | null;
  /** Everything the command printed, for reporting and for a raw fallback. */
  text: string;
}

export function runPiCli(
  runtime: ResolvedRuntime,
  args: readonly string[],
  cwd: string | undefined,
  onOutput: (line: string) => void,
  /**
   * The environment additions that point this CLI run at the profile of the selected
   * instance, from `instanceProfileEnv()`. An empty object is a real value here: it
   * means the owner's instance, whose pi resolves its own default.
   */
  env: Record<string, string>,
): Promise<PiCliResult> {
  const target = spawnTarget(runtime);
  onOutput(`pi ${args.join(" ")}`);
  return runExecutable(target.command, [...target.argsPrefix, ...args], {
    shell: target.shell,
    onOutput,
    env,
    ...(cwd ? { cwd } : {}),
  });
}

/**
 * Runs any external tool and collects what it printed.
 *
 * Split out from `runPiCli` because PiCode shells out to more than pi: the Gentle AI
 * binary is its own executable, and both need the same line forwarding and the same
 * ignore-the-exit-code-until-the-end behaviour.
 */
export function runExecutable(
  command: string,
  args: readonly string[],
  options: {
    shell: boolean;
    cwd?: string;
    onOutput: (line: string) => void;
    /**
     * Extra environment for the child, merged last so it beats what this process
     * inherited. Omitted by the non-pi callers (git, for one), which have no profile
     * to point at.
     */
    env?: Record<string, string>;
  },
): Promise<PiCliResult> {
  const { shell, cwd, onOutput, env } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell,
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
      // The additions go last on purpose: for PiCode's own instance they have to beat a
      // `PI_CODING_AGENT_DIR` the owner exported for the pi in their terminal, or that
      // variable would make the install land in the owner's profile.
      env: { ...process.env, NO_COLOR: "1", ...(env ?? {}) },
    });

    let text = "";
    const forward = (chunk: Buffer): void => {
      const value = chunk.toString("utf8");
      text += value;
      for (const line of value.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          onOutput(line.trimEnd());
        }
      }
    };

    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("error", (error) => {
      resolve({ ok: false, code: null, text: `${text}${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, text });
    });
  });
}

export interface InstalledPackage {
  /** The section heading `pi list` grouped it under, e.g. "User packages". */
  scope: string;
  /** The source spec exactly as pi reports it, e.g. `npm:pi-lens`. */
  source: string;
  /** The resolved location, when pi printed one. */
  path?: string;
}

/**
 * Parses `pi list`.
 *
 * The real output is a section heading, then a two-space indented source per
 * package, then a four-space indented path:
 *
 *     User packages:
 *       npm:pi-lens
 *         C:\Users\me\.pi\agent\npm\node_modules\pi-lens
 *
 * Anything that does not fit is ignored rather than guessed at, and callers keep
 * the raw text so an unrecognised format shows the output instead of an empty
 * list that looks like "nothing installed".
 */
export function parseInstalledPackages(text: string): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  let scope = "Paquetes";

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      continue;
    }

    const indentation = rawLine.length - rawLine.trimStart().length;
    const value = rawLine.trim();

    if (indentation === 0) {
      if (value.endsWith(":")) {
        scope = value.slice(0, -1).trim();
      }
      continue;
    }

    if (indentation <= 2) {
      packages.push({ scope, source: value });
      continue;
    }

    const last = packages[packages.length - 1];
    if (last && last.path === undefined) {
      last.path = value;
    }
  }

  return packages;
}

export interface CatalogPackage {
  name: string;
  version: string;
  description: string;
  monthlyDownloads: number;
  repository?: string;
  /**
   * When this version was published, as the registry reports it.
   *
   * It rides along on the search response the page already makes: the gallery shows a
   * package's age, and asking again for a date the same document carries would be one
   * request per row for nothing. Absent when the registry's field cannot be read as a
   * date, so a renderer can say "sin fecha" rather than printing an invalid one.
   */
  publishedAt?: string;
}

/** Whether the registry's date field is something a date can actually be built from. */
function isPublishDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** How many results one registry page holds when the caller does not say. */
const DEFAULT_SEARCH_LIMIT = 25;

/** The registry rejects a `size` above this one, so the caller's value is bounded. */
const MAX_SEARCH_LIMIT = 250;

/** What one registry page answered, with the number that makes paging possible. */
export interface CatalogSearchPage {
  /**
   * Everything the registry says matches, not only this page.
   *
   * It counts the registry's own list, which is what the offset addresses, so it can be
   * larger than what the re-check below returns: free text is scored across the whole
   * registry and the keyword is a hint rather than a filter.
   */
  total: number;
  /** The offset this page started at, for asking the following one. */
  offset: number;
  packages: CatalogPackage[];
}

export interface CatalogSearchOptions {
  /** Results to ask for, bounded to what the registry accepts. */
  limit?: number;
  /** Results to skip: the page size times the number of pages already read. */
  offset?: number;
}

interface NpmSearchObject {
  package?: {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    keywords?: unknown;
    links?: { repository?: unknown };
    date?: unknown;
  };
  downloads?: { monthly?: unknown };
}

/**
 * Searches the pi package catalog through the npm registry.
 *
 * The registry API is keyless and machine readable, and pi's own gallery is built
 * from the same source: packages tagged `pi-package`. Free text is scored across
 * the whole registry, so the keyword is a hint rather than a filter — results are
 * therefore filtered again here, which is what keeps a search for "memory" from
 * quietly listing packages that are not pi packages at all.
 *
 * Paging follows the registry's own count: `total` counts its whole match list and
 * `offset` indexes into it, so a page can come back shorter than the page size simply
 * because the re-check dropped rows that were never pi packages.
 */
export async function searchCatalogPage(
  query: string,
  options: CatalogSearchOptions = {},
): Promise<CatalogSearchPage> {
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT)));
  // A negative offset is a caller mistake; the registry would answer with nonsense, and
  // the list starts at zero anyway.
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const text = query.trim().length > 0 ? `keywords:pi-package ${query.trim()}` : "keywords:pi-package";
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${limit}&from=${offset}`;

  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`el registro npm respondió ${response.status}`);
  }

  const payload = (await response.json()) as { total?: unknown; objects?: NpmSearchObject[] };
  const results: CatalogPackage[] = [];

  for (const entry of payload.objects ?? []) {
    const pkg = entry.package;
    if (!pkg || typeof pkg.name !== "string") {
      continue;
    }
    const keywords = Array.isArray(pkg.keywords)
      ? pkg.keywords.filter((keyword): keyword is string => typeof keyword === "string")
      : [];
    if (!keywords.includes("pi-package")) {
      continue;
    }

    const repository = pkg.links?.repository;
    results.push({
      name: pkg.name,
      version: typeof pkg.version === "string" ? pkg.version : "",
      description: typeof pkg.description === "string" ? pkg.description : "",
      monthlyDownloads: typeof entry.downloads?.monthly === "number" ? entry.downloads.monthly : 0,
      ...(typeof repository === "string" ? { repository } : {}),
      ...(isPublishDate(pkg.date) ? { publishedAt: pkg.date } : {}),
    });
  }

  return {
    // A registry that prints no count leaves the offset plus what came back as the
    // honest floor: it is what is known to exist.
    total: typeof payload.total === "number" ? payload.total : offset + results.length,
    offset,
    packages: results,
  };
}

/**
 * The first page of the catalog, for a caller that only shows one.
 *
 * Kept because the search popup calls it on every keystroke: it wants the rows and has
 * no use for the count or the offset.
 */
export async function searchCatalog(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<CatalogPackage[]> {
  return (await searchCatalogPage(query, { limit })).packages;
}
