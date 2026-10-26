import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "./firebase-admin";
import { dayKey, daysBefore, increments, summarize, type UsageDay, type UsageSample, type UsageStats } from "./usage";

/**
 * The I/O behind `usage.ts`: one counter document per UTC day, `usage/{YYYY-MM-DD}`, holding only
 * numbers. The rules live in `usage.ts`.
 */
const USAGE = "usage";

/** Adds one check to today's counters. One write, no read. */
export async function recordCheck(sample: UsageSample, at: Date = new Date()): Promise<void> {
  const update: Record<string, FieldValue> = {};
  for (const [field, by] of Object.entries(increments(sample))) {
    update[field] = FieldValue.increment(by);
  }
  // `update` needs the document to exist; `set` with merge does not, but treats dotted keys as
  // literal names, so the nesting is spelled out for it instead.
  await firestore().collection(USAGE).doc(dayKey(at)).set(nest(update), { merge: true });
}

function nest(flat: Record<string, FieldValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = value;
  }
  return out;
}

/** The public summary of the last 30 days. Thirty document reads, so callers cache it. */
export async function readStats(at: Date = new Date()): Promise<UsageStats> {
  const today = dayKey(at);
  const refs = Array.from({ length: 30 }, (_, n) => firestore().collection(USAGE).doc(daysBefore(today, n)));
  const snapshots = await firestore().getAll(...refs);
  const stored = new Map<string, UsageDay>();
  for (const snapshot of snapshots) {
    if (snapshot.exists) {
      stored.set(snapshot.id, snapshot.data() as UsageDay);
    }
  }
  return summarize(today, stored);
}
