/*
 * The quota POLICY: which plan is which, and what each one is allowed.
 *
 * This is the other half of the storage work, and it is here because it has already been wrong once
 * in production: the Pro quota was configured to 25 MB while the product says 50, and the sync
 * refused uploads for anybody near the limit. The number is a product promise, so it is worth a test
 * that says what it is — and that the environment override, the thing that actually went stale,
 * behaves the way the code claims.
 *
 * Imported from `plans.ts`, which has no Firestore in it, so this runs with no credentials.
 *
 *   node --experimental-strip-types --test test/*.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { quotaBytesFor, readPlanId } from "../src/lib/plans.ts";

const PRO_LIMIT_BYTES = 52_428_800; // 50 MiB — what the product promises Pro
const FREE_LIMIT_BYTES = 1_000_000;

function withEnv(name: string, value: string | undefined, body: () => void): void {
  const before = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    body();
  } finally {
    if (before === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = before;
    }
  }
}

test("a plan is pro only when it says so", () => {
  assert.equal(readPlanId("pro"), "pro");
  assert.equal(readPlanId("  PRO  "), "pro");
  assert.equal(readPlanId("free"), "free");
  assert.equal(readPlanId(undefined), "free");
  assert.equal(readPlanId(null), "free");
  assert.equal(readPlanId(""), "free");
  assert.equal(readPlanId(42), "free");
  assert.equal(readPlanId({ plan: "pro" }), "free");
});

test("Pro is 50 MB, which is what the product promises", () => {
  withEnv("PICODE_QUOTA_PRO_BYTES", undefined, () => {
    assert.equal(quotaBytesFor("pro"), PRO_LIMIT_BYTES);
    assert.equal(PRO_LIMIT_BYTES, 50 * 1024 * 1024);
  });
});

test("free is a megabyte", () => {
  withEnv("PICODE_QUOTA_FREE_BYTES", undefined, () => {
    assert.equal(quotaBytesFor("free"), FREE_LIMIT_BYTES);
  });
});

test("the environment can tune a quota without a deploy", () => {
  withEnv("PICODE_QUOTA_PRO_BYTES", "1024", () => {
    assert.equal(quotaBytesFor("pro"), 1024);
  });
});

test("nonsense in the environment falls back to the default, never to zero", () => {
  // A quota of zero or NaN would lock every Pro user out of syncing: the safe reading of a broken
  // override is the default, not the smallest number.
  for (const broken of ["", "   ", "abc", "0", "-1", "NaN", "Infinity"]) {
    withEnv("PICODE_QUOTA_PRO_BYTES", broken, () => {
      assert.equal(quotaBytesFor("pro"), PRO_LIMIT_BYTES, `"${broken}" must fall back`);
    });
  }
});

test("each plan reads its own variable", () => {
  withEnv("PICODE_QUOTA_PRO_BYTES", "111", () => {
    withEnv("PICODE_QUOTA_FREE_BYTES", "222", () => {
      assert.equal(quotaBytesFor("pro"), 111);
      assert.equal(quotaBytesFor("free"), 222);
    });
  });
});
