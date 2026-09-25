/*
 * T2 of the two-instances feature: the one-shot copy of a profile.
 *
 * `importProfile()` is the counterpart of `scanProfile()` in instance.ts. The scan
 * reads a profile that may be a stranger's without ever writing to it; this module
 * copies a chosen subset of that profile into PiCode's own, under the same rule:
 * every read happens under `from`, every write happens under `to`, and there is no
 * code path that opens anything under `from` for writing.
 *
 * The design is shaped by five constraints from the feature document:
 *
 * - The caller chooses the items one flag at a time. `settings` is the profile's
 *   `settings.json`, which carries the package list, and is the reason to replicate a
 *   profile at all. Sessions are an item like any other, and the wizard's "migrate
 *   everything" answer is what selects them: a session belongs to the profile that made
 *   it, which is exactly why moving them has to be asked for rather than assumed. The
 *   source is still only ever read — the owner's pi keeps every session it had.
 * - Credentials are their own decision and never a side effect. A false flag reports
 *   `declined`, not `absent`, so "you chose not to bring this" stays distinguishable
 *   from "there was nothing to bring".
 * - Nothing is replaced silently. An item that lands on content reports `overwritten`
 *   even though the content was replaced, and a directory copy merges into the target
 *   instead of clearing it, so files the import did not name survive.
 * - A missing source item is `absent` and an unreadable or malformed one is `failed`;
 *   neither throws, and the rest of the items still run.
 * - The import is repeatable: a second pass over the same source and target is safe
 *   and reports `overwritten` where the content matched.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

/* ------------------------------------------------------------------ *
 * The shapes
 * ------------------------------------------------------------------ */

/** One thing the caller may bring across; each maps to a file or a directory. */
export type ImportItem =
  | "settings"
  | "models"
  | "mcp"
  | "skills"
  | "memory"
  | "sessions"
  | "credentials";

/**
 * What comes across, one flag each. A falsy flag is a decision, not an omission:
 * the report still carries the item, as `declined`. Credentials are last on purpose —
 * they are the one item whose default is "no".
 */
export interface ImportSelection {
  settings?: boolean;
  models?: boolean;
  mcp?: boolean;
  skills?: boolean;
  memory?: boolean;
  sessions?: boolean;
  credentials?: boolean;
}

/**
 * What happened to one item.
 *
 * - `copied`      — the source had it and the target did not.
 * - `overwritten` — the source had it and the target already held content.
 * - `absent`      — the caller asked for it and the source did not have it.
 * - `declined`    — the caller did not ask for it (the import never opened it).
 * - `failed`      — the source item was unreadable or malformed, or the target
 *                   could not be written.
 */
export type ImportItemStatus = "copied" | "overwritten" | "absent" | "declined" | "failed";

export interface ImportItemReport {
  item: ImportItem;
  status: ImportItemStatus;
  /** The target path the item was written to, or would have been. */
  path: string;
  /** For directory items only: how many files the copy moved. */
  files?: number;
  /** Why it failed, or why there was nothing there. Owner-facing, so Spanish. */
  reason?: string;
}

/** One count per status, so the caller can render a summary without recounting. */
export interface ImportCounts {
  copied: number;
  overwritten: number;
  absent: number;
  declined: number;
  failed: number;
}

export interface ImportReport {
  /** The source profile, echoed for the report and the tests. */
  from: string;
  /** The target profile, echoed for the report and the tests. */
  to: string;
  /** One entry per item, in the fixed order of `ITEMS` regardless of selection. */
  items: ImportItemReport[];
  counts: ImportCounts;
}

export interface ImportOptions {
  from: string;
  to: string;
  selection: ImportSelection;
  /** Called once per resolved item, in the same order as `ImportReport.items`. */
  onProgress?: (item: ImportItemReport) => void;
}

/**
 * The item list, in the order they are copied. `credentials` is last because it is
 * the separate decision: reading it first would make the copy a side effect of the
 * scan, which is exactly what the feature document forbids.
 */
type ItemSpec =
  | { item: ImportItem; kind: "file"; fileName: string }
  | { item: ImportItem; kind: "directory"; dirName: string };

const ITEMS: ItemSpec[] = [
  { item: "settings", kind: "file", fileName: "settings.json" },
  { item: "models", kind: "file", fileName: "models.json" },
  { item: "mcp", kind: "file", fileName: "mcp.json" },
  { item: "skills", kind: "directory", dirName: "skills" },
  { item: "memory", kind: "directory", dirName: "memory" },
  { item: "sessions", kind: "directory", dirName: "sessions" },
  { item: "credentials", kind: "file", fileName: "auth.json" },
];

/* ------------------------------------------------------------------ *
 * Small filesystem questions
 * ------------------------------------------------------------------ */

/** Whether a path is a regular file; false when it is missing or unreadable. */
function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Whether a path is a directory; false when it is missing or unreadable. */
function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a directory already holds anything, which is what makes a copy "overwritten". */
function hasContent(directory: string): boolean {
  try {
    return readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

/** How many regular files sit under a directory; the count a directory item reports. */
function countFiles(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += countFiles(full);
    } else if (entry.isFile()) {
      total += 1;
    }
  }
  return total;
}

/**
 * Copies every file under `source` into `target`.
 *
 * The copy merges rather than mirrors: directories are created as needed, but nothing
 * already in `target` that the import does not name is removed. Only `copyFileSync`
 * writes, and only under `target`, so the read/write boundary matches the promise.
 */
function copyDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

/**
 * The bytes of a settings-like JSON file, or the reason it may not be copied.
 *
 * The copy is byte-for-byte; parsing only decides whether the file is usable at all.
 * A half-written JSON file must not reach the target, and a document that parses but
 * is not an object (an array, a bare string) is not a settings file either.
 */
function readJsonObject(file: string): { text: string } | { failure: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { failure: "no se pudo leer el fichero de origen" };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { failure: "el origen no es un objeto JSON" };
    }
  } catch {
    return { failure: "el origen no es JSON válido" };
  }
  return { text };
}

/* ------------------------------------------------------------------ *
 * The copy
 * ------------------------------------------------------------------ */

/** A failed item, with the reason kept owner-facing. */
function failed(item: ImportItem, target: string, reason: string): ImportItemReport {
  return { item, status: "failed", path: target, reason };
}

/** Copies one file item, or explains why it could not be. */
function importFile(item: ImportItem, source: string, target: string): ImportItemReport {
  if (!existsSync(source)) {
    return { item, status: "absent", path: target };
  }
  if (!isFile(source)) {
    return failed(item, target, "la ruta de origen no es un fichero");
  }

  const read = readJsonObject(source);
  if ("failure" in read) {
    return failed(item, target, read.failure);
  }

  // A target that exists as something other than a file cannot receive the copy; that
  // is a failure, not a silent overwrite of a directory with a file.
  if (existsSync(target) && !isFile(target)) {
    return failed(item, target, "el destino ya existe y no es un fichero");
  }

  const existed = isFile(target);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, read.text);
  } catch {
    return failed(item, target, "no se pudo escribir en el destino");
  }
  return { item, status: existed ? "overwritten" : "copied", path: target };
}

/** Copies one directory item, merging into any content already in the target. */
function importDirectory(item: ImportItem, source: string, target: string): ImportItemReport {
  if (!existsSync(source)) {
    return { item, status: "absent", path: target };
  }
  if (!isDirectory(source)) {
    return failed(item, target, "la ruta de origen no es un directorio");
  }

  try {
    const files = countFiles(source);
    // "Already held content" is decided before the copy, because the copy itself is
    // what would otherwise make the target look occupied.
    const existed = hasContent(target);
    copyDirectory(source, target);
    return { item, status: existed ? "overwritten" : "copied", path: target, files };
  } catch {
    return failed(item, target, "no se pudo copiar el directorio");
  }
}

/**
 * Copies a chosen subset of `from` into `to` and reports every item.
 *
 * An unselected item is never opened: it is reported as `declined`. That is what makes
 * the credentials flag a decision rather than a side effect, and it keeps the report's
 * shape stable across selections. Throws only on a caller mistake — asking to read a
 * profile into itself would put a write path under `from` — never on a source problem.
 */
export async function importProfile(options: ImportOptions): Promise<ImportReport> {
  const from = path.resolve(options.from);
  const to = path.resolve(options.to);
  if (from === to) {
    // Without this, `to` is also `from` and the "source is only ever read" invariant
    // would be broken by the caller rather than by this module.
    throw new Error("el perfil de origen y el de destino no pueden ser el mismo directorio");
  }

  // The target exists before the first item, so an empty target is a valid destination
  // and a file item never has to reason about its own parent directory.
  mkdirSync(to, { recursive: true });

  const items: ImportItemReport[] = [];
  for (const spec of ITEMS) {
    const target = path.join(to, spec.kind === "file" ? spec.fileName : spec.dirName);
    let report: ImportItemReport;
    if (options.selection[spec.item] !== true) {
      report = { item: spec.item, status: "declined", path: target };
    } else {
      const source = path.join(from, spec.kind === "file" ? spec.fileName : spec.dirName);
      report =
        spec.kind === "file"
          ? importFile(spec.item, source, target)
          : importDirectory(spec.item, source, target);
    }
    items.push(report);
    options.onProgress?.(report);
  }

  return { from, to, items, counts: countStatuses(items) };
}

/** One count per status, read from the reports themselves rather than tracked twice. */
function countStatuses(items: ImportItemReport[]): ImportCounts {
  const counts: ImportCounts = { copied: 0, overwritten: 0, absent: 0, declined: 0, failed: 0 };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}
