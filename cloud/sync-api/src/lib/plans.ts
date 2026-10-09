/*
 * The quota POLICY, with no Firestore in it.
 *
 * Which plan is which and what each one is allowed is a product promise, not storage plumbing, and
 * it has already been wrong once in production: Pro was configured to 25 MB while the product says
 * 50, and the sync refused uploads from anyone near the limit. Separating it here means it can be
 * tested without credentials — and the test is the only place that says, in one line, what the
 * promise is.
 *
 * There is only one storage-bearing plan: cloud sync is Pro-only, and the free plan is an account
 * (sign-up, billing, linking the editor) that stores nothing. That is enforced in `auth.ts` by the
 * 402 gate, not by a small number here.
 *
 * The firestore-bound half (reading the plan, remembering it briefly) lives in `quota.ts`.
 */

export type PlanId = "free" | "pro";

export const DEFAULT_PLAN_QUOTAS: Record<PlanId, number> = {
  // No storage: a non-Pro request never reaches the store (`requirePro` answers 402 first), so
  // this zero is the product decision written down, not a tiny allowance.
  free: 0,
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
 * Free is answered before the environment is read at all: cloud sync is Pro-only, so no variable
 * can hand out storage the product does not sell. A leftover `PICODE_QUOTA_FREE_BYTES` from when
 * the free plan had 1 MB is therefore ignored, deliberately.
 *
 * For Pro the environment override exists so a quota can be tuned without a deploy, and it is the
 * piece that went stale and cost a user their sync — a value that is not a positive finite number
 * is ignored rather than honoured, because "no quota at all" is a far worse failure than "the
 * default quota".
 */
export function quotaBytesFor(plan: PlanId): number {
  if (plan !== "pro") {
    return DEFAULT_PLAN_QUOTAS.free;
  }
  const raw = process.env.PICODE_QUOTA_PRO_BYTES;
  const parsed = raw === undefined ? undefined : Number(raw);
  if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PLAN_QUOTAS.pro;
}
