import { firestore } from "./firebase-admin";
import { readPlanId, type PlanId } from "./plans";

/**
 * Reading the user's plan, and remembering it for a moment.
 *
 * The policy itself (which plan, what it allows) is in `plans.ts`, with no Firestore in it. What is
 * here is the I/O: the plan lives on the user profile document (`users/{uid}.plan`) and is written
 * EXCLUSIVELY by the PiCode-Website Stripe webhooks — this API treats it as read-only.
 *
 * **The stored-byte total is not computed here.** It used to be: this module walked every resource
 * collection and read every stored revision on every upload, which for this project's own profile
 * was 211 document reads and grew with use, because every sync keeps a revision. The total now lives
 * in the manifest (`usedBytes`), is updated inside the same transaction that changes it, and is read
 * from the document the write already had to read. See `lib/store.ts`.
 */

export type { PlanId };
export { quotaBytesFor, readPlanId } from "./plans";

/**
 * How long a plan read is trusted.
 *
 * The plan changes only when the website's Stripe webhook writes it, and being wrong for a minute
 * means either a Pro user briefly told they are not Pro (they retry) or a downgraded user briefly
 * still served — nothing that has to be instant. The reason for a cache at all is the sync's own
 * rhythm: the plan is read on EVERY request, including the poll every client runs on a timer and
 * which almost always answers "nothing new". One Firestore read per poll is half that poll's cost,
 * spent re-learning something that changes monthly at most.
 */
const PLAN_TTL_MS = 60_000;
const PLAN_CACHE_MAX = 500;
const planCache = new Map<string, { at: number; plan: PlanId }>();

/** Forget a cached plan: for a caller that just wrote one, and for the tests. */
export function forgetCachedPlan(uid: string): void {
  planCache.delete(uid);
}

/** Read the user's plan from their profile doc; missing profile = "free". */
export async function readUserPlan(uid: string): Promise<PlanId> {
  const cached = planCache.get(uid);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < PLAN_TTL_MS) {
    return cached.plan;
  }
  const snapshot = await firestore().collection("users").doc(uid).get();
  const plan = readPlanId(snapshot.data()?.plan);
  // A plain Map in a long-lived function instance: bounded so a busy instance cannot grow without
  // limit, and evicted from the front when it would.
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next();
    if (!oldest.done) {
      planCache.delete(oldest.value);
    }
  }
  planCache.set(uid, { at: now, plan });
  return plan;
}
