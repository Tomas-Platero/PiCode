/*
 * The quota POLICY, with no Firestore in it.
 *
 * Which plan is which and what each one is allowed is a product promise, not storage plumbing, and
 * it has already been wrong once in production: Pro was configured to 25 MB while the product says
 * 50, and the sync refused uploads from anyone near the limit. Separating it here means it can be
 * tested without credentials — and the test is the only place that says, in one line, what the
 * promise is.
 *
 * The firestore-bound half (reading the plan, remembering it briefly) lives in `quota.ts`.
 */

export type PlanId = "free" | "pro";

export const DEFAULT_PLAN_QUOTAS: Record<PlanId, number> = {
  free: 1_000_000, // ~1 MB of stored sync data
  pro: 52_428_800, // ~50 MB: a 7-day rolling window of pi session backups plus every other resource
};

/** The plan a profile document declares; anything unrecognised is "free". */
export function readPlanId(plan: unknown): PlanId {
  return typeof plan === "string" && plan.trim().toLowerCase() === "pro"
    ? "pro"
    : "free";
}

/**
 * The byte ceiling for a plan.
 *
 * The environment override exists so a quota can be tuned without a deploy, and it is the piece
 * that went stale and cost a user their sync — a value that is not a positive finite number is
 * ignored rather than honoured, because "no quota at all" is a far worse failure than "the default
 * quota".
 */
export function quotaBytesFor(plan: PlanId): number {
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
