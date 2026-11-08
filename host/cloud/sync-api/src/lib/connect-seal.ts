import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ConnectService, ConnectTokens } from "./connect";
import { HttpError } from "./errors";

/**
 * The GitHub and Jira tokens at rest. They open someone else's account, so unlike synced content
 * they are never stored without a key: no key, no connection.
 *
 * AES-256-GCM with a key of their own, derived from the server's master key, so that synced data
 * and tokens never share a key. The owner and the service are part of what is authenticated, so a
 * sealed value copied to another person's record, or to the other service, simply does not open.
 *
 *   "PCT1" | iv (12) | tag (16) | ciphertext
 *
 * Pure (no Next.js, no database), so `node --test` can check it.
 */

const MAGIC = Buffer.from("PCT1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Env = Readonly<Record<string, string | undefined>>;

export function connectorKey(env: Env): Buffer {
  const master = Buffer.from(env.PICODE_ENCRYPTION_KEY?.trim() ?? "", "base64");
  if (master.length !== 32) {
    // Not the person's doing and not fixable by them: say so, and say nothing about which variable.
    throw new HttpError(503, "NotConfigured", "This connection is not available yet.");
  }
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "picode-connector-tokens-v1", 32));
}

function additionalData(uid: string, service: ConnectService): Buffer {
  return Buffer.from(`${uid}\u0000${service}`);
}

export function sealTokens(tokens: ConnectTokens, key: Buffer, uid: string, service: ConnectService): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData(uid, service));
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
}

/** `undefined` when it does not open: changed, moved, or sealed with another key. */
export function openTokens(sealed: Buffer, key: Buffer, uid: string, service: ConnectService): ConnectTokens | undefined {
  const head = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (sealed.length <= head || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES));
    decipher.setAAD(additionalData(uid, service));
    decipher.setAuthTag(sealed.subarray(MAGIC.length + IV_BYTES, head));
    const text = Buffer.concat([decipher.update(sealed.subarray(head)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(text) as Partial<ConnectTokens>;
    return typeof parsed.accessToken === "string" && parsed.accessToken ? (parsed as ConnectTokens) : undefined;
  } catch {
    return undefined;
  }
}

/** A little early, so a call never leaves with a token that dies on the way. */
const EXPIRY_MARGIN_MS = 60_000;

export function expiryOf(tokens: ConnectTokens, now: number): number | null {
  return tokens.expiresIn === undefined ? null : now + tokens.expiresIn * 1000;
}

export function needsRenewal(expiresAt: number | null | undefined, now: number): boolean {
  return typeof expiresAt === "number" && expiresAt - EXPIRY_MARGIN_MS <= now;
}
