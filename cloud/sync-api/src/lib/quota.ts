import { firestore } from "./firebase-admin";

/**
 * Plan-based storage quotas. The plan lives on the user profile document
 * (`users/{uid}.plan`) and is written EXCLUSIVELY by the PiCode-Website
 * Stripe webhooks — this API treats it as read-only.
 *
 * Quota = total stored content bytes across every resource of the user.
 * Defaults are conservative; override with PICODE_QUOTA_FREE_BYTES and
 * PICODE_QUOTA_PRO_BYTES environment variables.
 */

export type PlanId = "free" | "pro";

const DEFAULT_PLAN_QUOTAS: Record<PlanId, number> = {
  free: 1_000_000, // ~1 MB of stored sync data
  pro: 52_428_800, // ~50 MB: a 7-day rolling window of pi session backups plus every other resource
};

export function readPlanId(plan: unknown): PlanId {
  return typeof plan === "string" && plan.trim().toLowerCase() === "pro"
    ? "pro"
    : "free";
}

/** Read the user's plan from their profile doc; missing profile = "free". */
export async function readUserPlan(uid: string): Promise<PlanId> {
  const snapshot = await firestore().collection("users").doc(uid).get();
  return readPlanId(snapshot.data()?.plan);
}

function quotaBytesFor(plan: PlanId): number {
  const raw =
    plan === "pro"
      ? process.env.PICODE_QUOTA_PRO_BYTES
      : process.env.PICODE_QUOTA_FREE_BYTES;
  const parsed = raw === undefined ? undefined : Number(raw);
  if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PLAN_QUOTAS[plan];
}

/** Sum of stored content bytes across every resource of the user. */
async function storedBytes(uid: string): Promise<number> {
  const resourcesParent = firestore()
    .collection("users")
    .doc(uid)
    .collection("sync")
    .doc("resources");
  const subcollections = await resourcesParent.listCollections();
  let total = 0;
  for (const subcollection of subcollections) {
    const snapshot = await subcollection.select("content").get();
    for (const doc of snapshot.docs) {
      const content = doc.get("content");
      if (typeof content === "string") {
        total += Buffer.byteLength(content, "utf8");
      }
    }
  }
  return total;
}

export interface QuotaVerdict {
  allowed: boolean;
  plan: PlanId;
  usedBytes: number;
  limitBytes: number;
}

/**
 * Check whether appending `incomingBytes` keeps the user within their plan's
 * storage quota. Enforced on every resource upload (POST).
 */
export async function checkStorageQuota(
  uid: string,
  incomingBytes: number,
): Promise<QuotaVerdict> {
  const plan = await readUserPlan(uid);
  const limitBytes = quotaBytesFor(plan);
  const usedBytes = await storedBytes(uid);
  return {
    allowed: usedBytes + incomingBytes <= limitBytes,
    plan,
    usedBytes,
    limitBytes,
  };
}
