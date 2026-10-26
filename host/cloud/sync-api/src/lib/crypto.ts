import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { HttpError } from "./errors";

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
 * That is the format of v1 and v2, which are still READ. What is written now
 * (v3) is binary, stored as a Firestore Bytes field:
 *
 *   "PCE3" | iv (12) | tag (16) | AES-256-GCM(brotli(plaintext))
 *
 * The text envelope cost ~1.78x its payload (base64 inside base64) and that
 * overhead counted against the user's quota; bytes cost 1x, and brotli shrinks
 * synced JSON ~10% more than gzip. Measured on a real pi profile bundle: 389 KB
 * stored as v2, 194 KB as v3. Without a key the content is still compressed
 * ("PCZ3" | brotli), just not encrypted.
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

const MAGIC_ENCRYPTED = Buffer.from("PCE3", "latin1");
const MAGIC_COMPRESSED = Buffer.from("PCZ3", "latin1");
const TAG_LENGTH_BYTES = 16;

/*
 * Quality 9, not 11: on a 660 KB profile bundle 11 saves another 8% but takes
 * ~1 s of CPU against ~50 ms, and this runs on every upload.
 */
function compress(plaintext: string): Buffer {
  const input = Buffer.from(plaintext, "utf8");
  return brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 9,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
    },
  });
}

/** Compress and encrypt plaintext into the binary v3 envelope (compress only without a key). */
export function encrypt(plaintext: string): Buffer {
  const packed = compress(plaintext);
  const key = masterKey();
  if (key === null) {
    return Buffer.concat([MAGIC_COMPRESSED, packed]);
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(packed), cipher.final()]);
  return Buffer.concat([MAGIC_ENCRYPTED, iv, cipher.getAuthTag(), ciphertext]);
}

/** What a stored value costs, whichever format it is in. */
export function storedByteLength(stored: unknown): number {
  if (Buffer.isBuffer(stored) || stored instanceof Uint8Array) {
    return stored.byteLength;
  }
  return typeof stored === "string" ? Buffer.byteLength(stored, "utf8") : 0;
}

function decryptBinary(stored: Buffer): string {
  const magic = stored.subarray(0, 4);
  if (magic.equals(MAGIC_COMPRESSED)) {
    return brotliDecompressSync(stored.subarray(4)).toString("utf8");
  }
  if (!magic.equals(MAGIC_ENCRYPTED)) {
    throw new Error("Unknown binary envelope.");
  }
  const key = masterKey();
  if (key === null) {
    throw new Error("PICODE_ENCRYPTION_KEY is not configured.");
  }
  const iv = stored.subarray(4, 4 + IV_LENGTH_BYTES);
  const tag = stored.subarray(4 + IV_LENGTH_BYTES, 4 + IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  const ciphertext = stored.subarray(4 + IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  if (tag.length !== TAG_LENGTH_BYTES) {
    throw new Error("Malformed encryption envelope.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return brotliDecompressSync(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toString("utf8");
}

/**
 * Decrypt a stored value back to plaintext. Values without the envelope
 * prefix (legacy or foreign plaintext) pass through unchanged. Any failure
 * — wrong key, corrupt data, bad tag — surfaces as a 500 DecryptionFailed
 * error; garbage is never returned to a client.
 */
export function decrypt(stored: unknown): string {
  if (Buffer.isBuffer(stored) || stored instanceof Uint8Array) {
    try {
      return decryptBinary(Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength));
    } catch (error) {
      throw decryptionFailed(error);
    }
  }
  if (typeof stored !== "string") {
    throw decryptionFailed(new Error("Stored content has an unexpected type."));
  }
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
    throw decryptionFailed(error);
  }
}

function decryptionFailed(error: unknown): HttpError {
  return new HttpError(
    500,
    "DecryptionFailed",
    `Stored content could not be decrypted: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
}
