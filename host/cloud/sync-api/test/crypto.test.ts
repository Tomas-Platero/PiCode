/*
 * The stored envelope: what is written now (binary v3) and what is still read (v1/v2 text, plain).
 *
 *   node --experimental-transform-types --test test/*.test.ts
 */

import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { register } from "node:module";
import { gzipSync } from "node:zlib";

// The library imports its siblings without an extension (the Next.js way); under plain node
// they resolve to their `.ts` file.
register(
  "data:text/javascript," +
    encodeURIComponent(
      "export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if (s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c); throw e; } }",
    ),
);

const key = randomBytes(32);
process.env.PICODE_ENCRYPTION_KEY = key.toString("base64");

const { decrypt, encrypt, storedByteLength } = await import("../src/lib/crypto.ts");

const bundle = JSON.stringify({
  version: 1,
  files: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`skills/s${i}.md`, `# Skill ${i}\nDo the thing.\n`])),
});

test("a v3 envelope is binary, encrypted and round-trips", () => {
  const stored = encrypt(bundle);
  assert.ok(Buffer.isBuffer(stored));
  assert.equal(stored.subarray(0, 4).toString("latin1"), "PCE3");
  assert.ok(!stored.includes(Buffer.from("Do the thing")), "content must not be readable");
  assert.equal(decrypt(stored), bundle);
});

test("v3 costs less than the v2 text envelope did", () => {
  const gz = gzipSync(Buffer.from(bundle));
  const v2Bytes = Math.ceil((Math.ceil((gz.length * 4) / 3) * 4) / 3);
  assert.ok(storedByteLength(encrypt(bundle)) < v2Bytes / 1.5);
});

test("a v2 text envelope written before v3 is still read", () => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const d = Buffer.concat([cipher.update(gzipSync(Buffer.from(bundle))), cipher.final()]);
  const envelope = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), d: d.toString("base64") });
  const stored = "picode-enc:v2:" + Buffer.from(envelope).toString("base64url");
  assert.equal(decrypt(stored), bundle);
});

test("legacy plaintext passes through", () => {
  assert.equal(decrypt("{\"plain\":true}"), "{\"plain\":true}");
});

test("a tampered v3 envelope fails loudly instead of returning garbage", () => {
  const stored = encrypt(bundle);
  stored.writeUInt8(stored.readUInt8(stored.length - 1) ^ 0xff, stored.length - 1);
  assert.throws(() => decrypt(stored), /DecryptionFailed|could not be decrypted/);
});
