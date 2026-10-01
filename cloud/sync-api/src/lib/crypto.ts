import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { HttpError } from "./http";

/**
 * Server-side at-rest encryption for synced resource content.
 *
 * All synced content is encrypted with AES-256-GCM before it reaches
 * Firestore, transparently to clients: `store.ts` encrypts on write and
 * decrypts on read, so clients always exchange plaintext.
 *
 * Wire format stored in Firestore:
 *
 *   picode-enc:v1:<base64url(JSON { iv, tag, d })>
 *
 * where `iv` (12 bytes), `tag` (16 bytes) and `d` (ciphertext) are base64.
 * The `picode-enc:v1:` prefix makes envelope detection deterministic.
 *
 * The master key comes from PICODE_ENCRYPTION_KEY (32 bytes, base64-encoded;
 * e.g. `openssl rand -base64 32`). When the variable is unset, encryption is
 * BYPASSED and content is stored in plaintext (development convenience);
 * a warning is logged once per process. The key is parsed lazily on first
 * use — never at import time, so builds do not require the variable.
 */

const ENCRYPTION_MARKER = "picode-enc:v1:";
const ENCRYPTION_MARKER_V2 = "picode-enc:v2:";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;

interface EncryptionEnvelope {
  iv: string;
  tag: string;
  d: string;
}

let cachedKey: Buffer | undefined;
let plaintextWarningLogged = false;

/** Resolve the master key lazily; null means "encryption bypassed". */
function masterKey(): Buffer | null {
  if (cachedKey !== undefined) {
    return cachedKey;
  }
  const raw = process.env.PICODE_ENCRYPTION_KEY;
  if (raw === undefined || raw === "") {
    if (!plaintextWarningLogged) {
      plaintextWarningLogged = true;
      console.warn(
        "[picode-sync] PICODE_ENCRYPTION_KEY is not set: synced content is " +
          "stored in PLAINTEXT. Generate a key with " +
          "`openssl rand -base64 32` and set it as PICODE_ENCRYPTION_KEY to " +
          "enable at-rest encryption.",
      );
    }
    return null;
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new HttpError(
      500,
      "EncryptionKeyInvalid",
      "PICODE_ENCRYPTION_KEY must decode to exactly 32 bytes of base64 data.",
    );
  }
  cachedKey = key;
  return cachedKey;
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENCRYPTION_MARKER) || stored.startsWith(ENCRYPTION_MARKER_V2);
}

/** Encrypt plaintext into the `picode-enc:v1:` envelope (or pass through). */
export function encrypt(plaintext: string): string {
  const key = masterKey();
  if (key === null) {
    return plaintext;
  }
  // v2: gzip before encrypting, because the envelope costs ~1.78x the
  // plaintext (base64 inside base64) and an uncompressed 900 KB bundle would
  // store ~1.64 MB, over Firestore's 1 MiB document limit. Compression saves
  // the common case — compressible JSON — and only that case: gzip cannot
  // shrink an already compressed or incompressible payload, which is why the
  // caller checks the envelope size afterwards (store.writeResource).
  const gz = gzipSync(Buffer.from(plaintext, "utf8"));
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(gz), cipher.final()]);
  const envelope: EncryptionEnvelope = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    d: ciphertext.toString("base64"),
  };
  const envelopeJson = JSON.stringify(envelope);
  return (
    ENCRYPTION_MARKER_V2 + Buffer.from(envelopeJson, "utf8").toString("base64url")
  );
}

/**
 * Decrypt a stored value back to plaintext. Values without the envelope
 * prefix (legacy or foreign plaintext) pass through unchanged. Any failure
 * — wrong key, corrupt data, bad tag — surfaces as a 500 DecryptionFailed
 * error; garbage is never returned to a client.
 */
export function decrypt(stored: string): string {
  if (!isEncrypted(stored)) {
    return stored;
  }
  try {
    const key = masterKey();
    if (key === null) {
      throw new Error("PICODE_ENCRYPTION_KEY is not configured.");
    }
    // v1 envelopes hold plaintext bytes; v2 envelopes hold gzip bytes.
    const isV2 = stored.startsWith(ENCRYPTION_MARKER_V2);
    const marker = isV2 ? ENCRYPTION_MARKER_V2 : ENCRYPTION_MARKER;
    const envelope = JSON.parse(
      Buffer.from(stored.slice(marker.length), "base64url").toString("utf8"),
    ) as Partial<EncryptionEnvelope>;
    const iv = Buffer.from(envelope.iv ?? "", "base64");
    const tag = Buffer.from(envelope.tag ?? "", "base64");
    const ciphertext = Buffer.from(envelope.d ?? "", "base64");
    if (iv.length !== IV_LENGTH_BYTES || tag.length === 0) {
      throw new Error("Malformed encryption envelope.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return (isV2 ? gunzipSync(plain) : plain).toString("utf8");
  } catch (error) {
    throw new HttpError(
      500,
      "DecryptionFailed",
      `Stored content could not be decrypted: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
