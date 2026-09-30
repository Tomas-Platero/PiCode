/**
 * Types and constants for the Settings Sync store REST contract consumed by
 * the PiCode (VS Code) client. Extracted from
 * picode-source/src/vs/platform/userDataSync/common/userDataSyncStoreService.ts
 */

/** Manifest JSON body returned by GET /v1/manifest. */
export interface SyncManifestBody {
  latest: Record<string, string>;
  session: string;
  ref: string;
  /** The client's activity views iterate this; omitting it crashes them with "reading 'map'". */
  collections: Record<string, { latest?: Record<string, string> }>;
}

/** ISyncData JSON string posted by the client to POST /v1/resource/:r. */
export interface SyncDataPayload {
  version: number;
  machineId?: string;
  content: string;
}

/** Row of the array returned by GET /v1/resource/:r. */
export interface SyncRefEntry {
  url: string;
  created: number;
}

/** Row of the array returned by GET /v1/collection. */
export interface SyncCollectionEntry {
  id: string;
}

/**
 * VS Code uses the literal ref "0" for a non-existing resource
 * (NON_EXISTING_RESOURCE_REF in userDataSync.ts).
 */
export const NON_EXISTING_RESOURCE_REF = "0";

/** Resource names are sanitized against this pattern server-side. */
export const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Refs (server-generated UUIDs) are sanitized against this pattern. */
export const REF_PATTERN = /^[A-Za-z0-9-]+$/;

/** Maximum accepted serialized body size (Firestore 1 MiB doc limit). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface SyncRequestContext {
  /** Firebase uid of the authenticated user. */
  uid: string;
  /** Email claim of the verified Firebase ID token, when present. */
  email?: string;
  /** X-Account-Type header value (authentication provider id, e.g. "picode"). */
  accountType: string;
  /** X-Client-Name header value, e.g. "picode". */
  clientName: string;
  /** X-Client-Version header value. */
  clientVersion: string;
  /** Optional X-Client-Commit header value. */
  clientCommit?: string;
  /** X-Machine-Session-Id header value (UUID, always sent by the client). */
  machineSessionId?: string;
  /** X-User-Session-Id header value (session from the last manifest). */
  userSessionId?: string;
  /** X-Execution-Id header value (per sync run). */
  executionId?: string;
  /**
   * User's plan read from `users/{uid}.plan` (written only by the website's
   * Stripe webhooks). Authoritative input for the Pro-only sync gate.
   */
  plan: "free" | "pro";
}
