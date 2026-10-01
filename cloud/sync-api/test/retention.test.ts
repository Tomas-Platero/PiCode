/*
 * The revision arithmetic, tested where it is cheap to test.
 *
 * This module decides what a user keeps and what they are charged, and both are invisible until
 * something goes wrong: a bug here either loses a revision nobody meant to drop or makes the byte
 * total drift away from reality. Neither needs Firestore to catch — it is arithmetic — so it is
 * tested as arithmetic, before any store touches it.
 *
 *   node --experimental-strip-types --test test/*.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  planRemoveRef,
  planRemoveResource,
  RETENTION_PER_RESOURCE,
  sumBytes,
  totalUsed,
  planWrite,
  type RetainedRef,
} from "../src/lib/retention.ts";

const ref = (name: string, bytes: number): RetainedRef => ({ ref: name, bytes });

test("a write puts the new revision in front", () => {
  const plan = planWrite([ref("old", 10)], ref("new", 5), 10);
  assert.deepEqual(plan.revisions.map((r) => r.ref), ["new", "old"]);
  assert.equal(plan.usedBytes, 15);
  assert.deepEqual(plan.dropped, []);
});

test("the list never grows past the cap, and what falls off is reported", () => {
  const current = Array.from({ length: RETENTION_PER_RESOURCE }, (_, i) => ref(`r${i}`, 1));
  const plan = planWrite(current, ref("fresh", 1), RETENTION_PER_RESOURCE);
  assert.equal(plan.revisions.length, RETENTION_PER_RESOURCE);
  assert.equal(plan.revisions[0]?.ref, "fresh");
  assert.deepEqual(plan.dropped.map((r) => r.ref), [`r${RETENTION_PER_RESOURCE - 1}`]);
});

test("what is dropped is subtracted from the total, not added on", () => {
  // Three kept revisions of 100 bytes, a cap of 2, and a new one of 100: the total must stay flat.
  const plan = planWrite([ref("a", 100), ref("b", 100)], ref("c", 100), 200, 2);
  assert.equal(plan.revisions.length, 2);
  assert.deepEqual(plan.dropped.map((r) => r.ref), ["b"]);
  assert.equal(plan.usedBytes, 200);
});

test("a first write starts from an empty manifest", () => {
  const plan = planWrite(undefined, ref("first", 42), 0);
  assert.deepEqual(plan.revisions.map((r) => r.ref), ["first"]);
  assert.equal(plan.usedBytes, 42);
});

test("a manifest that predates the counter reads zero rather than NaN", () => {
  const plan = planWrite(undefined, ref("first", 42), undefined as unknown as number);
  assert.ok(Number.isFinite(plan.usedBytes), "the total must stay a number");
});

test("removing one ref subtracts exactly its size", () => {
  const plan = planRemoveRef([ref("a", 100), ref("b", 250)], "b", 350);
  assert.deepEqual(plan.revisions.map((r) => r.ref), ["a"]);
  assert.deepEqual(plan.dropped.map((r) => r.ref), ["b"]);
  assert.equal(plan.usedBytes, 100);
});

test("removing a ref that is not there changes nothing", () => {
  const plan = planRemoveRef([ref("a", 100)], "ghost", 100);
  assert.equal(plan.usedBytes, 100);
  assert.deepEqual(plan.dropped, []);
});

test("removing a resource drops every revision it has", () => {
  const plan = planRemoveResource([ref("a", 100), ref("b", 50)], 150);
  assert.deepEqual(plan.revisions, []);
  assert.equal(plan.dropped.length, 2);
  assert.equal(plan.usedBytes, 0);
});

test("the total floors at zero instead of going negative", () => {
  // A drifted counter must not start charging a debt that only grows.
  assert.equal(planRemoveRef([ref("a", 10)], "a", 5).usedBytes, 0);
  assert.equal(planRemoveResource([ref("a", 10)], 0).usedBytes, 0);
});

test("a cap of zero keeps nothing and drops what it is given", () => {
  // `usedBytes` is the user's whole total and the list is one resource's share of it: 10 here, so
  // keeping nothing must take those 10 bytes off and leave the rest alone.
  const plan = planWrite([ref("a", 10)], ref("b", 10), 10, 0);
  assert.deepEqual(plan.revisions, []);
  assert.deepEqual(plan.dropped.map((r) => r.ref).sort(), ["a", "b"]);
  assert.equal(plan.usedBytes, 0);
});

test("a total that includes other resources is left alone beyond this one's share", () => {
  const plan = planWrite([ref("a", 100)], ref("b", 100), 1_000, 1);
  assert.deepEqual(plan.revisions.map((r) => r.ref), ["b"]);
  // 1000 total − 100 (this resource's old share) + 100 (its new share) = 1000, not 900.
  assert.equal(plan.usedBytes, 1_000);
});

test("sizes that are missing or nonsense do not poison the total", () => {
  const holes = [
    undefined as unknown as RetainedRef,
    { ref: "no-bytes" } as unknown as RetainedRef,
    ref("negative", -5),
    ref("nan", Number.NaN),
    ref("good", 7),
  ];
  assert.equal(sumBytes(holes), 7);
  assert.equal(sumBytes(undefined), 0);
});

test("a whole manifest adds up across resources", () => {
  assert.equal(
    totalUsed({ settings: [ref("a", 10)], piProfile: [ref("b", 90), ref("c", 1)] }),
    101,
  );
  assert.equal(totalUsed(undefined), 0);
  assert.equal(totalUsed({ empty: undefined }), 0);
});
