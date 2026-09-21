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
): Promise<PiCliResult> {
  const target = spawnTarget(runtime);
  const command = [...target.argsPrefix, ...args];
  onOutput(`pi ${args.join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn(target.command, command, {
      shell: target.shell,
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, NO_COLOR: "1" },
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
}

interface NpmSearchObject {
  package?: {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    keywords?: unknown;
    links?: { repository?: unknown };
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
 */
export async function searchCatalog(query: string, limit = 25): Promise<CatalogPackage[]> {
  const text = query.trim().length > 0 ? `keywords:pi-package ${query.trim()}` : "keywords:pi-package";
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${limit}`;

  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`el registro npm respondió ${response.status}`);
  }

  const payload = (await response.json()) as { objects?: NpmSearchObject[] };
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
    });
  }

  return results;
}
