/**
 * Resolves the type tag pi's own gallery shows for a package.
 *
 * pi derives that type from the key names of the `pi` object in the package's own
 * `package.json` — `extensions` is an extension, `skills` a skill, and so on — and no API
 * exposes it: the gallery reads the manifests itself. The abbreviated npm document the
 * registry can serve strips `pi` out, so the full document is requested here, one package
 * per request and only for the rows a caller is about to show.
 *
 * The whole rule lives in `typeTagsFromPiObject`, which is pure and takes no network, so
 * the part with a decision to test is testable without a registry. What surrounds it is
 * only the mechanics of asking: bounded concurrency because the registry throttles a
 * fan-out, an encoding for scoped names, a 404 that means "plain package", and a
 * short-lived cache so revisiting a page costs nothing.
 */

/**
 * The `pi` keys pi's gallery reads and the tag each one means, in the order pi
 * concatenates them. The order is part of the answer: one order for every caller keeps
 * the tags stable instead of depending on how a manifest happens to be written.
 */
export const PI_TYPE_KEYS: ReadonlyArray<{ key: string; tag: string }> = [
  { key: "extensions", tag: "extension" },
  { key: "skills", tag: "skill" },
  { key: "prompts", tag: "prompt" },
  { key: "themes", tag: "theme" },
];

/** What a package is when nothing else can be said about it. */
export const PLAIN_PACKAGE_TAG = "package";

/**
 * Maps the `pi` object of a manifest to its type tags.
 *
 * A key counts when it is present, even with an empty value, because the tag comes from
 * the key name and not from what the key holds. Anything unrecognised — a missing `pi`,
 * a `pi` object of other keys, a value that is not an object at all — is a plain package
 * rather than a guess.
 */
export function typeTagsFromPiObject(pi: unknown): string[] {
  if (typeof pi !== "object" || pi === null || Array.isArray(pi)) {
    return [PLAIN_PACKAGE_TAG];
  }

  const tags: string[] = [];
  for (const { key, tag } of PI_TYPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(pi, key)) {
      tags.push(tag);
    }
  }

  return tags.length > 0 ? tags : [PLAIN_PACKAGE_TAG];
}

/**
 * Encodes a package name for the registry path.
 *
 * Only the scope separator needs encoding: the registry serves `@scope%2Fname/latest`,
 * and leaving the `@` alone keeps the name readable in a log or an error.
 */
export function encodePackageName(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** How long a resolved tag is reused, so going back a page does not re-ask. */
const TYPE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedTypes {
  tags: string[];
  at: number;
}

const typeCache = new Map<string, CachedTypes>();

/**
 * Forgets every cached type.
 *
 * Exported for tests, and for a caller that knows the registry moved under it.
 */
export function clearPackageTypeCache(): void {
  typeCache.clear();
}

function cacheKeyOf(name: string, version: string): string {
  return `${name}@${version}`;
}

function readTypesFromCache(key: string): string[] | undefined {
  const entry = typeCache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (Date.now() - entry.at > TYPE_CACHE_TTL_MS) {
    typeCache.delete(key);
    return undefined;
  }
  // A copy, so a caller sorting or trimming the tags cannot poison the cache.
  return entry.tags.slice();
}

function writeTypesToCache(key: string, tags: string[]): void {
  typeCache.set(key, { tags, at: Date.now() });
}

/** A package to resolve a type for: the row a caller is about to show. */
export interface CatalogPackageIdentity {
  name: string;
  /**
   * The version the caller already knows, which is the one the search row shows.
   *
   * It is part of the cache key rather than a request parameter: the tag is asked of
   * `/latest`, and the version is what makes the entry reusable when the owner pages back
   * to the rows they just saw.
   */
  version?: string;
}

export interface ResolvePackageTypesOptions {
  /** Registry requests allowed in flight at once: the registry throttles a fan-out. */
  concurrency?: number;
  /** Attempts per package, the first one included. */
  maxAttempts?: number;
  /** Base delay of the retry backoff, doubled on each further attempt. */
  retryDelayMs?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;
/**
 * A server-supplied wait longer than this is ignored. The search runs while the owner
 * waits for the list, so honouring a minute-long `retry-after` would freeze the panel;
 * giving up on that package and showing it as a plain one is the better failure.
 */
const RETRY_AFTER_CAP_MS = 5000;

/**
 * Resolves the type tags of every package in the list.
 *
 * Never rejects for a single package: one the registry refuses, throttles or cannot be
 * reached comes back as a plain package so the rest of the page still resolves. The map
 * is keyed by package name and holds an entry for every name that was asked about.
 */
export async function resolvePackageTypes(
  packages: readonly CatalogPackageIdentity[],
  options: ResolvePackageTypesOptions = {},
): Promise<Map<string, string[]>> {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retryBase = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);

  const resolved = new Map<string, string[]>();
  const pending: CatalogPackageIdentity[] = [];
  const seen = new Set<string>();

  for (const pkg of packages) {
    const name = typeof pkg?.name === "string" ? pkg.name.trim() : "";
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);

    const version = typeof pkg.version === "string" ? pkg.version : "";
    const cached = readTypesFromCache(cacheKeyOf(name, version));
    if (cached !== undefined) {
      resolved.set(name, cached);
      continue;
    }
    pending.push({ name, version });
  }

  // A pool rather than one promise per row: the registry refuses a burst, and the cursor
  // is safe because nothing runs between reading it and advancing it.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const pkg = pending[cursor];
      cursor += 1;
      try {
        resolved.set(pkg.name, await fetchPackageTypes(pkg, { maxAttempts, retryBase }));
      } catch {
        // A failure is deliberately not cached: it is much more likely to be transient
        // than a tag is to change, and a cached failure would outlive the outage.
        resolved.set(pkg.name, [PLAIN_PACKAGE_TAG]);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

  return resolved;
}

async function fetchPackageTypes(
  pkg: CatalogPackageIdentity,
  config: { maxAttempts: number; retryBase: number },
): Promise<string[]> {
  const url = `https://registry.npmjs.org/${encodePackageName(pkg.name)}/latest`;
  const key = cacheKeyOf(pkg.name, pkg.version ?? "");

  for (let attempt = 1; ; attempt += 1) {
    // `application/json` asks for the full document: the abbreviated one drops `pi`, and
    // the tag cannot be derived without it.
    const response = await fetch(url, { headers: { accept: "application/json" } });

    if (response.ok) {
      const document = (await response.json()) as { pi?: unknown };
      const tags = typeTagsFromPiObject(document?.pi);
      writeTypesToCache(key, tags);
      return tags;
    }

    if (response.status === 404) {
      // No document is not a failure: it means a plain package, and it is cached so a
      // package that stays missing does not cost a request per visit.
      const tags = [PLAIN_PACKAGE_TAG];
      writeTypesToCache(key, tags);
      return tags;
    }

    if (attempt >= config.maxAttempts || !isRetryableStatus(response.status)) {
      throw new Error(`el registro npm respondió ${response.status}`);
    }

    await delay(retryDelayOf(response, attempt, config.retryBase));
  }
}

/** Rates are refused with 429 and outages with 5xx; the rest will not change on a retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayOf(
  response: { headers: { get(name: string): string | null } },
  attempt: number,
  base: number,
): number {
  const header = response.headers?.get?.("retry-after");
  const seconds = header === null || header === undefined ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }
  return base * 2 ** (attempt - 1);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
