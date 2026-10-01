import { randomUUID } from "node:crypto";
import { DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { firestore } from "./firebase-admin";
import {
  MAX_STORED_CONTENT_BYTES,
  NON_EXISTING_RESOURCE_REF,
  RESOURCE_NAME_PATTERN,
  SyncDataPayload,
  SyncManifestBody,
  SyncRefEntry,
} from "./contract";
import { HttpError } from "./http";
import { decrypt, encrypt } from "./crypto";

/**
 * Firestore data model (per authenticated user).
 *
 * Firestore paths must strictly alternate collection/document segments, so the
 * model below is the valid nearest shape of the intended layout:
 *
 *   users/{uid}/sync/manifest                doc: { latest, session, ref, updatedAt }
 *   users/{uid}/sync/resources/{resource}    collection of ref docs
 *   users/{uid}/sync/resources/{resource}/{ref}
 *                                            doc: { content, machineId?, version, created, deleted }
 *   users/{uid}/collections/{id}             doc: { created }
 *
 * The manifest's `latest[resource]` entry is the authoritative latest ref for
 * a resource and is updated in the same transaction as every write.
 * Refs, manifest refs and sessions are server-minted UUIDs.
 */

interface ManifestDoc {
  latest: Record<string, string>;
  session: string;
  ref: string;
  updatedAt: number;
}

interface RefDoc {
  content: string;
  machineId?: string;
  version: number;
  created: number;
  deleted: boolean;
}

function userSync(uid: string) {
  return firestore().collection("users").doc(uid).collection("sync");
}

function manifestDoc(uid: string) {
  return userSync(uid).doc("manifest");
}

/** Ref docs of one resource: users/{uid}/sync/resources/{resource}/{ref}. */
function refsCol(uid: string, resource: string) {
  return userSync(uid).doc("resources").collection(resource);
}

function collectionsCol(uid: string) {
  return firestore().collection("users").doc(uid).collection("collections");
}

export function assertResourceName(resource: string): void {
  if (!RESOURCE_NAME_PATTERN.test(resource)) {
    throw new HttpError(400, "BadRequest", "Invalid resource name.");
  }
}

function manifestFromSnapshot(snapshot: DocumentSnapshot): ManifestDoc | null {
  if (!snapshot.exists) {
    return null;
  }
  const data = snapshot.data() as Partial<ManifestDoc> | undefined;
  return {
    latest: data?.latest ?? {},
    session: data?.session ?? "",
    ref: data?.ref ?? "",
    updatedAt: data?.updatedAt ?? 0,
  };
}

function toManifestBody(manifest: ManifestDoc): SyncManifestBody {
  return {
    latest: manifest.latest,
    session: manifest.session,
    ref: manifest.ref,
    // The client's sync-activity views read this field unconditionally — an
    // undefined collections map crashes them with "reading 'map'".
    collections: {},
  };
}

function readManifestInTx(tx: Transaction, uid: string): Promise<DocumentSnapshot> {
  return tx.get(manifestDoc(uid));
}

/** Mint a new manifest ref/session and record `latest[resource]`. */
function bumpManifestInTx(
  tx: Transaction,
  uid: string,
  resource: string,
  ref: string,
  previous: DocumentSnapshot,
): void {
  const manifest = manifestFromSnapshot(previous);
  const latest: Record<string, string> = { ...(manifest?.latest ?? {}) };
  latest[resource] = ref;
  // `session` identifies the SERVICE for this user (the client compares it
  // against its stored value and turns sync OFF when it changes — it must only
  // change on deliberate server resets, never on writes). Keep it stable.
  const session = manifest?.session || randomUUID();
  tx.set(manifestDoc(uid), {
    latest,
    session,
    ref: randomUUID(),
    updatedAt: Date.now(),
  });
}

/** Read the user's manifest, creating (and returning) it when missing. */
export async function readOrCreateManifest(
  uid: string,
): Promise<SyncManifestBody> {
  const doc = manifestDoc(uid);
  return firestore().runTransaction(async (tx) => {
    const snapshot = await readManifestInTx(tx, uid);
    const manifest = manifestFromSnapshot(snapshot);
    if (manifest) {
      return toManifestBody(manifest);
    }
    const created: ManifestDoc = {
      latest: {},
      session: randomUUID(),
      ref: randomUUID(),
      updatedAt: Date.now(),
    };
    tx.set(doc, created);
    return toManifestBody(created);
  });
}

/** List all ref entries of a resource, oldest first. */
export async function listResourceRefs(
  uid: string,
  resource: string,
  buildUrl: (ref: string) => string,
): Promise<SyncRefEntry[]> {
  const snapshot = await refsCol(uid, resource).orderBy("created", "asc").get();
  return snapshot.docs.map((doc) => ({
    url: buildUrl(doc.id),
    created: (doc.data() as RefDoc).created,
  }));
}

export interface ResourceData {
  ref: string;
  content: string;
}

/** Read the latest non-deleted ref of a resource, or null when it has no data. */
export async function readLatestResource(
  uid: string,
  resource: string,
): Promise<ResourceData | null> {
  const manifestSnapshot = await manifestDoc(uid).get();
  const manifest = manifestFromSnapshot(manifestSnapshot);
  const latestRef = manifest?.latest[resource];
  if (!latestRef || latestRef === NON_EXISTING_RESOURCE_REF) {
    return null;
  }
  const refSnapshot = await refsCol(uid, resource).doc(latestRef).get();
  if (!refSnapshot.exists) {
    return null;
  }
  const data = refSnapshot.data() as RefDoc;
  // Content is stored encrypted; clients always receive plaintext.
  return { ref: latestRef, content: decrypt(data.content) };
}

/** Read one specific ref of a resource, or null when unknown. */
export async function readResourceRef(
  uid: string,
  resource: string,
  ref: string,
): Promise<ResourceData | null> {
  const refSnapshot = await refsCol(uid, resource).doc(ref).get();
  if (!refSnapshot.exists) {
    return null;
  }
  const data = refSnapshot.data() as RefDoc;
  // Content is stored encrypted; clients always receive plaintext.
  return { ref, content: decrypt(data.content) };
}

/**
 * Append a new resource revision atomically with the manifest bump. When
 * `ifMatch` is provided, a stale-but-existing ref answers 412
 * (PreconditionFailed) and a ref that does not exist at all answers 409
 * (Conflict). Returns the new server-minted ref.
 */
export async function writeResource(
  uid: string,
  resource: string,
  payload: SyncDataPayload,
  ifMatch: string | undefined,
): Promise<string> {
  // Encrypt before the transaction opens: the size that matters is the stored
  // envelope, not the request body, and only compression decides it. Without
  // this check an incompressible payload slips past MAX_BODY_BYTES and dies
  // inside Firestore with an opaque 500 instead of a clean 413.
  const content = encrypt(payload.content);
  const storedBytes = Buffer.byteLength(content, "utf8");
  if (storedBytes > MAX_STORED_CONTENT_BYTES) {
    throw new HttpError(
      413,
      "TooLarge",
      `Stored revision would be ${storedBytes} bytes and the store allows ${MAX_STORED_CONTENT_BYTES}.`,
    );
  }
  return firestore().runTransaction(async (tx) => {
    const manifestSnapshot = await readManifestInTx(tx, uid);
    const manifest = manifestFromSnapshot(manifestSnapshot);
    const currentLatest =
      manifest?.latest[resource] ?? NON_EXISTING_RESOURCE_REF;

    if (ifMatch !== undefined && ifMatch !== currentLatest) {
      const staleRef = await tx.get(refsCol(uid, resource).doc(ifMatch));
      if (staleRef.exists) {
        throw new HttpError(
          412,
          "PreconditionFailed",
          "Resource changed since the last read.",
        );
      }
      throw new HttpError(
        409,
        "Conflict",
        "The provided ref does not exist on the server.",
      );
    }

    const newRef = randomUUID();
    // Sanitize: Firestore hard-rejects `undefined` values — omit optional fields
    // (e.g. machineId on opaque posts) instead of writing them as undefined.
    const refData: Record<string, unknown> = {
      // Encrypted at rest; quota accounting (quota.ts) measures the plaintext
      // request body in the route, so the envelope overhead is not charged.
      content,
      version: payload.version,
      created: Math.floor(Date.now() / 1000),
      deleted: false,
    };
    if (payload.machineId !== undefined) {
      refData.machineId = payload.machineId;
    }
    tx.set(refsCol(uid, resource).doc(newRef), refData);
    bumpManifestInTx(tx, uid, resource, newRef, manifestSnapshot);
    return newRef;
  });
}

/** Delete every ref of a resource and reset its manifest entry to "0". */
export async function deleteResource(uid: string, resource: string): Promise<void> {
  const refSnapshot = await refsCol(uid, resource).get();
  await firestore().runTransaction(async (tx) => {
    for (const doc of refSnapshot.docs) {
      tx.delete(doc.ref);
    }
    const manifestSnapshot = await readManifestInTx(tx, uid);
    bumpManifestInTx(
      tx,
      uid,
      resource,
      NON_EXISTING_RESOURCE_REF,
      manifestSnapshot,
    );
  });
}

/** Delete one ref; when it was the latest, reset the manifest entry. */
export async function deleteResourceRef(
  uid: string,
  resource: string,
  ref: string,
): Promise<void> {
  const remaining = await refsCol(uid, resource)
    .orderBy("created", "desc")
    .get();
  const remainingLatest = remaining.docs.find((doc) => doc.id !== ref)?.id;
  await firestore().runTransaction(async (tx) => {
    const refDocRef = refsCol(uid, resource).doc(ref);
    const snapshot = await tx.get(refDocRef);
    if (!snapshot.exists) {
      throw new HttpError(404, "NotFound", "Ref not found.");
    }
    tx.delete(refDocRef);
    const manifestSnapshot = await readManifestInTx(tx, uid);
    bumpManifestInTx(
      tx,
      uid,
      resource,
      remainingLatest ?? NON_EXISTING_RESOURCE_REF,
      manifestSnapshot,
    );
  });
}

/** Clear all the user's data: every resource, every ref, and the manifest. */
export async function deleteAllResources(uid: string): Promise<void> {
  const db = firestore();
  // The sync tree can hold more documents than a single transaction may mutate
  // (Firestore caps transactions at 500 mutations) — clearing a real user's data
  // with runTransaction fails with InternalError. recursiveDelete uses a
  // BulkWriter instead and clears documents AND their subcollections.
  await db.recursiveDelete(db.collection("users").doc(uid).collection("sync"));
  await db.recursiveDelete(db.collection("users").doc(uid).collection("collections"));
}

/** Create a collection and return its server-minted id. */
export async function createCollection(uid: string): Promise<string> {
  const id = randomUUID();
  await collectionsCol(uid).doc(id).set({
    created: Math.floor(Date.now() / 1000),
  });
  return id;
}

/** List the user's collection ids. */
export async function listCollections(
  uid: string,
): Promise<{ id: string }[]> {
  const snapshot = await collectionsCol(uid).get();
  return snapshot.docs.map((doc) => ({ id: doc.id }));
}

/** Delete one collection (idempotent). */
export async function deleteCollection(uid: string, id: string): Promise<void> {
  await collectionsCol(uid).doc(id).delete();
}
