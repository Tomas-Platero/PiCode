/*
 * Finding themes in the gallery PiCode installs from, and reading a theme's own JSON.
 *
 * The owner asked to choose from the themes `vscodethemes.com` previews. That site is a
 * viewer: it scans the Microsoft Marketplace, keeps its own database and publishes no API,
 * and the marketplace itself is not usable from this editor. PiCode installs from **Open
 * VSX** (`product.json` says so), so the catalogue is built there — the one source whose
 * rows are installable here — and the site stays one search link away.
 *
 * Three facts shape everything below, all of them verified by hand against the live
 * registry rather than remembered:
 *
 * - **The registry's `category=themes` filter is loose**: it returns PowerShell. The only
 *   honest filter is the extension's own manifest, which the registry serves without the
 *   VSIX (`files.manifest`, a redirect to `.../file/package.json`). So a search is one
 *   request for the rows plus one small request each to keep the ones that really declare
 *   `contributes.themes`.
 * - **The registry does not serve a theme's own file**: `/file/<path>` answers only for the
 *   whitelisted artifacts (README, LICENSE, manifest, icon…), and `file/theme/dracula.json`
 *   is a 404. The bytes are inside the VSIX, so a theme that is not installed yet is read
 *   out of the VSIX — downloaded once (132 KB–483 KB in the real cases measured) and kept
 *   in the cache directory the caller names.
 * - **An installed theme needs no network at all**: its file is a path on disk.
 *
 * And one property of theme files: a theme may be written as a delta over another
 * (`"include": "./base.json"`, sometimes two levels deep), so what a preview needs is the
 * chain resolved rather than the file as it stands.
 *
 * The module is the I/O half: no `vscode`, no decisions about what to show. Everything it
 * needs — the cache directory, `fetch`, an abort signal, a clock — arrives as a parameter,
 * which is also what lets the suite exercise it without a network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ThemeJson, ThemeTokenRule, ThemeVariant } from "./theme-types";

/** The registry endpoint of the gallery PiCode ships with (Open VSX). */
export const DEFAULT_REGISTRY_BASE = "https://open-vsx.org/api";

/**
 * The API base of the host a gallery `serviceUrl` points at.
 *
 * `product.json` names the gallery (`https://open-vsx.org/vscode/gallery`) and the registry
 * of that same host is what has the metadata, so the mapping is derived from the product's
 * own value instead of being written a second time: a build that pointed the gallery
 * somewhere else would get that host's registry, not this one. `undefined` means "not a URL
 * I can read", and the caller falls back to {@link DEFAULT_REGISTRY_BASE} rather than to a
 * guess.
 */
export function registryApiBase(galleryServiceUrl: string): string | undefined {
  const trimmed = galleryServiceUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  const withoutSuffix = trimmed
    .replace(/\/vscode\/gallery$/i, "")
    .replace(/\/gallery$/i, "")
    .replace(/\/vscode$/i, "");
  return withoutSuffix === "" ? undefined : `${withoutSuffix}/api`;
}

/* ------------------------------------------------------------------ *
 * What a manifest declares
 * ------------------------------------------------------------------ */

/** One theme a manifest declares, before its file is read. */
export interface DeclaredTheme {
  /** The value `workbench.colorTheme` takes: the manifest's `id`, else its `label`. */
  id: string;
  label: string;
  /** The manifest's `uiTheme`, which is what the preview falls back on for dark or light. */
  uiTheme?: string;
  /** The theme file's path, relative to the extension's root. */
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The themes a manifest declares, in declaration order.
 *
 * Tolerant on purpose: a manifest is data a stranger wrote, so junk is skipped rather than
 * fatal, and a theme without a label or without a path is dropped — the first cannot be
 * chosen and the second cannot be read, so keeping it would only produce a row that fails
 * when it is used. `id ?? label` is the editor's own resolution and matches what the
 * settings value has to be.
 */
export function declaredThemes(manifest: unknown): DeclaredTheme[] {
  if (!isRecord(manifest)) {
    return [];
  }
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : undefined;
  const themes = contributes === undefined ? undefined : contributes.themes;
  if (!Array.isArray(themes)) {
    return [];
  }
  const declared: DeclaredTheme[] = [];
  for (const entry of themes) {
    if (!isRecord(entry)) {
      continue;
    }
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const themePath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (label === "" || themePath === "") {
      continue;
    }
    const id = typeof entry.id === "string" && entry.id.trim() !== "" ? entry.id.trim() : label;
    const uiTheme = typeof entry.uiTheme === "string" ? entry.uiTheme : undefined;
    declared.push(
      uiTheme === undefined
        ? { id, label, path: themePath }
        : { id, label, path: themePath, uiTheme },
    );
  }
  return declared;
}

/* ------------------------------------------------------------------ *
 * The ZIP reader
 * ------------------------------------------------------------------ */

/** A VSIX opened in memory: what it holds inside, and how to read one entry. */
export interface VsixArchive {
  readonly entries: readonly string[];
  read(entryPath: string): Buffer | undefined;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** A ZIP's comment can make the end record sit up to 64 KB from the end of the file. */
const MAX_COMMENT_BYTES = 65557;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** Where the end-of-central-directory record starts, or `-1`. */
function findEndOfCentralDirectory(bytes: Buffer): number {
  const lowest = Math.max(0, bytes.length - MAX_COMMENT_BYTES);
  for (let offset = bytes.length - 22; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/**
 * A VSIX (a plain ZIP) read in memory.
 *
 * A dependency would be the easy answer and the wrong one: this reads two fields out of a
 * file the registry hands over whole, and a ZIP reader is small enough to be verified by
 * tests that build a ZIP byte by byte. Only the two compression methods a VSIX may use are
 * accepted — stored and deflated — because guessing at a third would return garbage where
 * an error says what happened.
 *
 * Sizes come from the central directory and never from the local header: a ZIP written by a
 * streaming tool leaves the local sizes at zero and puts the real ones at the end.
 */
export function openVsix(bytes: Buffer): VsixArchive {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd === -1) {
    throw new Error("Not a ZIP archive: no end-of-central-directory record.");
  }
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  if (centralOffset + centralSize > bytes.length) {
    throw new Error("Truncated ZIP archive: the central directory runs past the end.");
  }

  interface Entry {
    name: string;
    method: number;
    compressedSize: number;
    localOffset: number;
  }
  const index = new Map<string, Entry>();
  let cursor = centralOffset;
  for (let taken = 0; taken < entryCount; taken += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("Corrupt ZIP archive: the central directory is not where it says.");
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    index.set(normalizeEntryPath(name), { name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return {
    entries: [...index.values()].map((entry) => entry.name),
    read(entryPath: string): Buffer | undefined {
      const entry = index.get(normalizeEntryPath(entryPath));
      if (entry === undefined) {
        return undefined;
      }
      const local = entry.localOffset;
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) {
        throw new Error(`Corrupt ZIP archive: no local header for "${entry.name}".`);
      }
      const nameLength = bytes.readUInt16LE(local + 26);
      const extraLength = bytes.readUInt16LE(local + 28);
      const start = local + 30 + nameLength + extraLength;
      const end = start + entry.compressedSize;
      if (end > bytes.length) {
        throw new Error(`Truncated ZIP archive: "${entry.name}" runs past the end.`);
      }
      const payload = bytes.subarray(start, end);
      if (entry.method === METHOD_STORED) {
        return Buffer.from(payload);
      }
      if (entry.method === METHOD_DEFLATED) {
        return inflateRawSync(payload);
      }
      throw new Error(`Unsupported ZIP compression method ${entry.method} for "${entry.name}".`);
    },
  };
}

/** A path inside an archive, as both the index and a caller's own path are written. */
function normalizeEntryPath(entryPath: string): string {
  return entryPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/* ------------------------------------------------------------------ *
 * Reading a theme file, wherever it lives
 * ------------------------------------------------------------------ */

/** Reading one file of a theme extension. */
export interface ThemeFileReader {
  read(themePath: string): string | undefined;
}

/**
 * A VSIX as a reader of theme files.
 *
 * The two candidate paths are tried because a VSIX keeps the extension's files under
 * `extension/` while a manifest's `path` is relative to the extension's root, and no theme
 * should be unreadable over that difference.
 */
export function vsixFiles(archive: VsixArchive): ThemeFileReader {
  return {
    read(themePath: string): string | undefined {
      const normalized = normalizeEntryPath(themePath);
      const bytes =
        archive.read(normalized) ??
        archive.read(`extension/${normalized}`) ??
        archive.read(`/${normalized}`);
      return bytes === undefined ? undefined : bytes.toString("utf8");
    },
  };
}

/**
 * An installed extension's directory as a reader of theme files.
 *
 * The resolved path is required to stay inside the directory: a manifest is data, and a
 * `path` of `../../something` would otherwise reach out of the extension it belongs to.
 */
export function installedFiles(root: string): ThemeFileReader {
  return {
    read(themePath: string): string | undefined {
      const target = path.resolve(root, normalizeEntryPath(themePath));
      const base = path.resolve(root);
      if (target !== base && !target.startsWith(base + path.sep)) {
        return undefined;
      }
      try {
        return readFileSync(target, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * A theme file with its `include` chain merged under it.
 *
 * `include` names another file of the same extension (`./base.json`, `../shared/base.json`)
 * or a preset the editor owns (`"vscode"`), and what a preview needs is the result: the
 * base's colours first, the theme's own on top, and the token rules in the order they are
 * applied — base before child, which is what makes a child's rule win a tie.
 *
 * Nothing in the chain is fatal. A missing base, a cycle and a chain deeper than the cap all
 * end with what could be read, because a theme whose base is absent still previews its own
 * colours and refusing it would leave the owner with no preview at all. The cap is not
 * decoration: a theme is data, and a chain that points at itself must not spin.
 */
export function resolveThemeChain(
  files: ThemeFileReader,
  entryPath: string,
  depth = 5,
): ThemeJson {
  return mergeChain(files, entryPath, depth, []);
}

function mergeChain(
  files: ThemeFileReader,
  themePath: string,
  depthLeft: number,
  seen: readonly string[],
): ThemeJson {
  const normalized = normalizeEntryPath(themePath);
  const text = files.read(normalized);
  if (text === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  // SAFETY: JSON.parse produced `unknown`; the checks above proved it is a non-array object.
  // Only the four keys a preview reads are typed, and every one of them is optional, so a
  // file whose values are the wrong type is a file the preview falls back on rather than a
  // file this module rejects — the same treatment `colors` and `tokenColors` get below.
  const theme = parsed as ThemeJson;
  const include = typeof theme.include === "string" ? theme.include.trim() : "";
  if (depthLeft <= 0 || include === "" || include === "vscode" || seen.includes(include)) {
    return withoutInclude(theme);
  }
  const basePath = normalizeEntryPath(path.posix.join(path.posix.dirname(normalized), include));
  // A path that walks out of the extension is not a theme file of this extension: the
  // reader would refuse it anyway, and saying so here keeps the chain honest.
  if (basePath.startsWith("../")) {
    return withoutInclude(theme);
  }
  const base = mergeChain(files, basePath, depthLeft - 1, [...seen, include]);
  return mergeThemes(base, withoutInclude(theme));
}

/** The theme's own keys, with `include` dropped: the chain has been resolved by then. */
function withoutInclude(theme: ThemeJson): ThemeJson {
  const { include: _include, ...rest } = theme;
  void _include;
  return rest;
}

/** `child` written over `base`: scalars win, colours per key, token rules in order. */
function mergeThemes(base: ThemeJson, child: ThemeJson): ThemeJson {
  const merged: ThemeJson = { ...base, ...child };
  const colors = { ...(base.colors ?? {}), ...(child.colors ?? {}) };
  if (Object.keys(colors).length > 0) {
    merged.colors = colors;
  }
  const rules: ThemeTokenRule[] = [];
  for (const source of [base.tokenColors, child.tokenColors]) {
    if (Array.isArray(source)) {
      rules.push(...source);
    }
  }
  if (rules.length > 0) {
    merged.tokenColors = rules;
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

/** An extension the search found, with the themes its manifest declares. */
export interface ThemeCandidate {
  /** `namespace.name` — the id the editor installs. */
  id: string;
  displayName: string;
  description: string;
  downloads: number;
  version: string;
  iconUrl?: string;
  downloadUrl?: string;
  declared: readonly DeclaredTheme[];
}

export interface SearchThemesOptions {
  /** The registry API base; defaults to Open VSX. */
  base?: string;
  /** What the owner typed. Empty means "the most downloaded". */
  query?: string;
  /** How many candidates to return. */
  limit?: number;
  /** How many rows to ask the registry for; defaults to twice the limit. */
  candidates?: number;
  concurrency?: number;
  signal?: AbortSignal;
  fetchLike?: typeof fetch;
  now?: () => number;
}

const SEARCH_TTL_MS = 5 * 60 * 1000;
const MAX_LIMIT = 40;
const DEFAULT_LIMIT = 20;
const DEFAULT_CONCURRENCY = 6;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

const searchCache = new Map<string, { at: number; value: readonly ThemeCandidate[] }>();

/** Forgets every cached search. Exported for tests, and for a caller that knows the clock moved. */
export function clearThemeSearchCache(): void {
  searchCache.clear();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Fetch a JSON document, retrying the two answers that mean "later". */
async function requestJson(url: string, options: Required<Pick<SearchThemesOptions, "fetchLike">> & {
  signal?: AbortSignal;
}): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS * attempt);
    }
    try {
      const response = await options.fetchLike(url, {
        headers: { accept: "application/json" },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`The registry answered ${response.status}.`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`The registry answered ${response.status}.`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      // A transport failure is worth one more attempt too; an abort is not.
      if (options.signal?.aborted === true) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface SearchRow {
  id: string;
  displayName: string;
  description: string;
  downloads: number;
  version: string;
  iconUrl?: string;
  downloadUrl?: string;
  manifestUrl?: string;
}

/** One row of the registry's answer, or `undefined` when it is not usable. */
function searchRow(entry: unknown): SearchRow | undefined {
  if (!isRecord(entry) || entry.deprecated === true) {
    return undefined;
  }
  const namespace = typeof entry.namespace === "string" ? entry.namespace : "";
  const name = typeof entry.name === "string" ? entry.name : "";
  if (namespace === "" || name === "") {
    return undefined;
  }
  const files = isRecord(entry.files) ? entry.files : {};
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    id: `${namespace}.${name}`,
    displayName: text(entry.displayName) ?? name,
    description: text(entry.description) ?? "",
    downloads: typeof entry.downloadCount === "number" ? entry.downloadCount : 0,
    version: text(entry.version) ?? "",
    iconUrl: text(files.icon),
    downloadUrl: text(files.download),
    manifestUrl: text(files.manifest),
  };
}

/** Runs `worker` over `items`, never more than `limit` at a time, keeping the order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners: Promise<void>[] = [];
  const size = Math.max(1, Math.min(limit, items.length));
  for (let slot = 0; slot < size; slot += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= items.length) {
            return;
          }
          results[index] = await worker(items[index]);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * The themes the gallery has, most downloaded first.
 *
 * One registry request for the rows, then one small manifest request each to keep the
 * extensions that really declare themes — the registry's own `category=themes` filter is
 * loose enough to return PowerShell, so trusting it would put a debugger in the theme
 * picker. A row whose manifest cannot be read is dropped rather than failing the whole
 * search: one broken extension must not empty the gallery. The result is cached briefly,
 * because paging and coming back to the same query is what an owner actually does.
 */
export async function searchThemes(options: SearchThemesOptions = {}): Promise<ThemeCandidate[]> {
  const base = (options.base ?? DEFAULT_REGISTRY_BASE).replace(/\/+$/, "");
  const query = (options.query ?? "").trim();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const candidates = Math.max(limit, Math.min(options.candidates ?? limit * 2, MAX_LIMIT * 2));
  const fetchLike = options.fetchLike ?? fetch;
  const now = options.now ?? Date.now;

  const key = `${base}|${query}|${limit}`;
  const cached = searchCache.get(key);
  if (cached !== undefined && now() - cached.at <= SEARCH_TTL_MS) {
    return [...cached.value];
  }

  const url =
    `${base}/-/search?category=themes&sortBy=downloadCount&sortOrder=desc&size=${candidates}` +
    (query === "" ? "" : `&query=${encodeURIComponent(query)}`);
  const answer = await requestJson(url, { fetchLike, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const rows = (isRecord(answer) && Array.isArray(answer.extensions) ? answer.extensions : [])
    .map(searchRow)
    .filter((row): row is SearchRow => row !== undefined && row.downloadUrl !== undefined);
  // Open VSX search rows omit files.manifest — derive it from the download URL:
  // the manifest is the package.json packaged next to the VSIX, served at
  // `.../file/package.json` (it 302s to the versioned file; fetch follows).
  for (const row of rows) {
    if (row.manifestUrl === undefined && row.downloadUrl !== undefined) {
      row.manifestUrl = row.downloadUrl.replace(/\/file\/[^/]+\.vsix$/, "/file/package.json");
    }
  }
  const withManifest = rows.filter((row): row is SearchRow =>
    row.manifestUrl !== undefined && row.downloadUrl !== undefined);

  const manifests = await mapWithLimit(withManifest, options.concurrency ?? DEFAULT_CONCURRENCY, async (row) => {
    try {
      const manifest = await requestJson(row.manifestUrl as string, {
        fetchLike,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const declared = declaredThemes(manifest);
      if (declared.length === 0) {
        return undefined;
      }
      const candidate: ThemeCandidate = {
        id: row.id,
        displayName: row.displayName,
        description: row.description,
        downloads: row.downloads,
        version: row.version,
        declared,
      };
      return {
        ...candidate,
        ...(row.iconUrl === undefined ? {} : { iconUrl: row.iconUrl }),
        ...(row.downloadUrl === undefined ? {} : { downloadUrl: row.downloadUrl }),
      };
    } catch {
      return undefined;
    }
  });

  const found = manifests
    .filter((candidate): candidate is ThemeCandidate => candidate !== undefined)
    .slice(0, limit);
  searchCache.set(key, { at: now(), value: found });
  return [...found];
}

/* ------------------------------------------------------------------ *
 * Loading one theme
 * ------------------------------------------------------------------ */

export interface LoadVariantOptions {
  /** `namespace.name`, used for the cache file's name. */
  extensionId: string;
  version: string;
  declared: DeclaredTheme;
  /** The installed extension's directory, when the editor already has it. */
  installedRoot?: string;
  downloadUrl?: string;
  /** Where a downloaded VSIX is kept between runs. */
  cacheDir?: string;
  fetchLike?: typeof fetch;
  signal?: AbortSignal;
}

/** A file name that cannot escape its directory, whatever the extension id looks like. */
function cacheFileName(extensionId: string, version: string): string {
  const safe = `${extensionId}@${version}`.replace(/[^a-z0-9@._-]/gi, "_");
  return `${safe}.vsix`;
}

/**
 * One theme, ready to preview and to apply.
 *
 * The installed copy wins: it is the file the editor is actually using, so a preview of it
 * cannot disagree with what the owner sees. Only when the extension is not installed is the
 * VSIX used, and it is kept in `cacheDir` under `<id>@<version>.vsix` — one download per
 * theme, then local and instant, which is what makes browsing the gallery bearable. A theme
 * that cannot be read either way is `undefined`: the caller says so rather than showing an
 * empty preview.
 */
export async function loadVariant(options: LoadVariantOptions): Promise<ThemeVariant | undefined> {
  const variantOf = (theme: ThemeJson): ThemeVariant => ({
    id: options.declared.id,
    label: options.declared.label,
    path: options.declared.path,
    ...(options.declared.uiTheme === undefined ? {} : { uiTheme: options.declared.uiTheme }),
    theme,
  });

  if (options.installedRoot !== undefined) {
    const theme = resolveThemeChain(installedFiles(options.installedRoot), options.declared.path);
    if (Object.keys(theme).length > 0) {
      return variantOf(theme);
    }
  }

  const cached =
    options.cacheDir === undefined
      ? undefined
      : path.join(options.cacheDir, cacheFileName(options.extensionId, options.version));
  let bytes: Buffer | undefined;
  let fromCache = false;
  if (cached !== undefined && existsSync(cached)) {
    try {
      bytes = readFileSync(cached);
      fromCache = true;
    } catch {
      bytes = undefined;
    }
  }
  if (bytes === undefined && options.downloadUrl !== undefined) {
    try {
      const response = await (options.fetchLike ?? fetch)(options.downloadUrl, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (response.ok) {
        bytes = Buffer.from(await response.arrayBuffer());
      }
    } catch {
      // A network that fails is the same answer as a file that is not there: the caller says
      // "no se pudo leer" and the panel keeps working. Letting the rejection escape left the
      // preview note on "Leyendo el tema…" for ever, because nobody above it catches.
      bytes = undefined;
    }
  }
  if (bytes === undefined) {
    return undefined;
  }

  let archive: VsixArchive;
  try {
    archive = openVsix(bytes);
  } catch {
    return undefined;
  }
  let theme: ThemeJson;
  try {
    theme = resolveThemeChain(vsixFiles(archive), options.declared.path);
  } catch {
    // A deflated entry that does not decode throws from inside the reader, and that is a
    // package this module cannot trust: it is not cached either, below, so a re-download is
    // what happens next rather than the same corrupt bytes failing for ever.
    return undefined;
  }
  if (Object.keys(theme).length === 0) {
    return undefined;
  }
  // Written only now, once the bytes have been shown to be a package whose theme reads: a
  // download that turns out to be garbage must not be what the cache keeps for this version.
  if (cached !== undefined && !fromCache) {
    try {
      mkdirSync(path.dirname(cached), { recursive: true });
      writeFileSync(cached, bytes);
    } catch {
      // Caching is an optimisation; failing to write it must not fail the preview.
    }
  }
  return variantOf(theme);
}
