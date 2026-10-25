/*
 * The arithmetic a write changes, kept pure so it can be tested without Firestore.
 *
 * Two numbers have to survive every write, and getting either wrong is expensive in a way that is
 * invisible until the bill arrives:
 *
 *   - **What is kept.** Every revision of a resource is a document. `piProfile` alone produced 180
 *     revisions in two days of real use (~90/day), and the quota check used to read every one of
 *     them on every upload. The revisions that stay are the last few, not all of them, and the
 *     manifest is what remembers which ones those are.
 *   - **What is charged.** The stored bytes of the user, summed as revisions come and go. It is a
 *     running total, not a recount: recounting is the scan that made an upload cost 211 reads.
 *
 * The sizes live next to the refs in the manifest for exactly that reason: pruning then costs
 * nothing, because the sizes of the revisions being dropped are already in hand. Reading the
 * collection to find out would be the very scan this module exists to remove.
 */

/** How many revisions of one resource are kept. */
export const RETENTION_PER_RESOURCE = 20;

/** One kept revision: the ref the client sees, and what its stored content costs. */
export interface RetainedRef {
  ref: string;
  bytes: number;
}

export interface RevisionPlan {
  /** What the manifest keeps: newest first, never longer than the cap. */
  readonly revisions: RetainedRef[];
  /** What the store deletes: the revisions that fell off the end. */
  readonly dropped: RetainedRef[];
  /** The user's new stored-byte total. */
  readonly usedBytes: number;
}

/**
 * What one appended revision does to the list and the total.
 *
 * `usedBytes` is the user's total BEFORE this write, across every resource; the new total is
 * derived from what this resource KEEPS rather than from the new revision minus what fell off.
 * Those two differ when the new revision is itself dropped (a cap of zero), and the kept-side
 * reading is also self-healing: whatever the counter said about this resource is replaced by the
 * truth of its list.
 */
export function planWrite(
  current: readonly RetainedRef[] | undefined,
  incoming: RetainedRef,
  usedBytes: number,
  cap: number = RETENTION_PER_RESOURCE,
): RevisionPlan {
  const all = [incoming, ...(current ?? [])];
  const keep = Math.max(0, cap);
  const revisions = all.slice(0, keep);
  const dropped = all.slice(keep);
  return {
    revisions,
    dropped,
    usedBytes: totalAfter(usedBytes, current, revisions),
  };
}

/** The list and the total after one revision is removed by ref. */
export function planRemoveRef(
  current: readonly RetainedRef[] | undefined,
  ref: string,
  usedBytes: number,
): RevisionPlan {
  const all = current ?? [];
  const revisions = all.filter((entry) => entry.ref !== ref);
  return {
    revisions,
    dropped: all.filter((entry) => entry.ref === ref),
    usedBytes: totalAfter(usedBytes, current, revisions),
  };
}

/** The list and the total after every revision of a resource is removed. */
export function planRemoveResource(
  current: readonly RetainedRef[] | undefined,
  usedBytes: number,
): RevisionPlan {
  return {
    revisions: [],
    dropped: [...(current ?? [])],
    usedBytes: totalAfter(usedBytes, current, []),
  };
}

/**
 * The user's total with one resource's contribution replaced by what it now keeps.
 *
 * The floor at zero is a guard, not an expectation: a total below zero would only mean the counter
 * had drifted, and never charging a debt that no longer exists is the safe reading of that. A
 * non-finite `usedBytes` (a manifest written before the counter existed) reads as zero, because
 * `Math.max(0, NaN)` is `NaN` and a `NaN` total would silently pass every quota check there is.
 */
function totalAfter(
  usedBytes: number,
  before: readonly RetainedRef[] | undefined,
  after: readonly RetainedRef[] | undefined,
): number {
  const base = Number.isFinite(usedBytes) ? usedBytes : 0;
  return Math.max(0, base - sumBytes(before) + sumBytes(after));
}

/** The stored bytes of a set of revisions, tolerating holes a merged manifest may carry. */
export function sumBytes(refs: readonly RetainedRef[] | undefined): number {
  let total = 0;
  for (const entry of refs ?? []) {
    if (typeof entry?.bytes === "number" && Number.isFinite(entry.bytes) && entry.bytes > 0) {
      total += entry.bytes;
    }
  }
  return total;
}

/**
 * The stored bytes of a whole manifest, for the one-time backfill of a profile that predates the
 * counter. It is the only place that walks everything, and it runs once per user.
 */
export function totalUsed(
  revisions: Record<string, readonly RetainedRef[] | undefined> | undefined,
): number {
  let total = 0;
  for (const list of Object.values(revisions ?? {})) {
    total += sumBytes(list);
  }
  return total;
}
