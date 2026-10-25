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
import { quotaBytesFor, type PlanId } from "./quota";
import {
  planRemoveRef,
  planRemoveResource,
  planWrite,
  RETENTION_PER_RESOURCE,
  totalUsed,
  type RetainedRef,
} from "./retention";
import { HttpError } from "./http";
import { decrypt, encrypt } from "./crypto";

/**
 * Firestore data model (per authenticated user).
 *
 * Firestore paths must strictly alternate collection/document segments, so the
 * model below is the valid nearest shape of the intended layout:
 *
 *   users/{uid}/sync/manifest                doc: { latest, revisions, usedBytes, session, ref, updatedAt }
 *   users/{uid}/sync/resources/{resource}    collection of ref docs
 *   users/{uid}/sync/resources/{resource}/{ref}
 *                                            doc: { content, machineId?, version, created, deleted }
 *   users/{uid}/collections/{id}             doc: { created }
 *
 * The manifest's `latest[resource]` entry is the authoritative latest ref for
 * a resource and is updated in the same transaction as every write.
 * Refs, manifest refs and sessions are server-minted UUIDs.
 *
 * `revisions` and `usedBytes` are what make an upload cheap. Knowing the user's
 * stored bytes used to mean reading every ref of every resource ON EVERY UPLOAD
 * (211 reads for this project's own profile, and the number grows with use);
 * now the total is a running number kept in the manifest, updated inside the
 * same transaction that changes it, and the manifest is a document the write
 * already had to read. `revisions` carries each kept ref WITH its size for the
 * same reason: pruning costs nothing when the sizes are already in hand.
 */

interface ManifestDoc {
  latest: Record<string, string>;
  /**
   * Kept revisions per resource, newest first, each with the bytes it stores.
   * Undefined on a profile written before this existed — see `ensureCounter`.
   */
  revisions?: Record<string, RetainedRef[]>;
  /** The user's stored-byte total. Undefined on a profile from before the counter. */
  usedBytes?: number;
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

/** Parent of every resource collection: users/{uid}/sync/resources. */
function resourcesParent(uid: string) {
  return userSync(uid).doc("resources");
}

/** Ref docs of one resource: users/{uid}/sync/resources/{resource}/{ref}. */
function refsCol(uid: string, resource: string) {
  return resourcesParent(uid).collection(resource);
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
    ...(data?.revisions === undefined ? {} : { revisions: data.revisions }),
    ...(typeof data?.usedBytes === "number" ? { usedBytes: data.usedBytes } : {}),
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

/**
 * Record a change in the manifest: what the resource is latest at, what it keeps and what the user
 * now stores. `session` identifies the SERVICE for this user (the client compares it against its
 * stored value and turns sync OFF when it changes — it must only change on deliberate server
 * resets, never on writes), so it is carried over and kept stable.
 */
function setManifest(
  tx: Transaction,
  uid: string,
  previous: ManifestDoc | null,
  next: {
    latest: Record<string, string>;
    revisions: Record<string, RetainedRef[]>;
    usedBytes: number;
  },
): void {
  tx.set(manifestDoc(uid), {
    ...next,
    session: previous?.session || randomUUID(),
    ref: randomUUID(),
    updatedAt: Date.now(),
  });
}

/**
 * Walk every resource once, keep the newest revisions, and write down the list and the total.
 *
 * This is the one-time cost of a profile that predates the counter: before it, the only way to
 * know the total was to read every ref of every resource — which is exactly what the quota check
 * used to do on every upload, and what made an upload cost 211 reads. A manifest without
 * `revisions` is such a profile, and this is where it is walked: once, for that user.
 *
 * Self-healing on purpose. There is no migration script and no credential to run one with: each
 * user pays their own scan the first time they sync after the deploy, and after that the counter
 * carries the number forward.
 *
 * The manifest is written FIRST and the dropped refs are deleted after, best-effort. That order is
 * the safe one: the manifest is what the client reads, so a delete that fails leaves an invisible
 * orphan that costs storage and nothing else, while the reverse could leave the client pointed at
 * a ref that no longer exists.
 */
async function ensureCounter(uid: string, manifest: ManifestDoc): Promise<ManifestDoc> {
  if (manifest.revisions !== undefined && typeof manifest.usedBytes === "number") {
    return manifest;
  }

  const revisions: Record<string, RetainedRef[]> = {};
  const expired: { resource: string; ref: string }[] = [];
  const parent = resourcesParent(uid);
  const subcollections = await parent.listCollections();
  for (const subcollection of subcollections) {
    const snapshot = await subcollection.orderBy("created", "desc").get();
    const kept: RetainedRef[] = [];
    snapshot.docs.forEach((doc, index) => {
      const content = doc.get("content");
      const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
      if (index < RETENTION_PER_RESOURCE) {
        kept.push({ ref: doc.id, bytes });
      } else {
        expired.push({ resource: subcollection.id, ref: doc.id });
      }
    });
    if (kept.length > 0) {
      revisions[subcollection.id] = kept;
    }
  }

  const migrated: ManifestDoc = {
    ...manifest,
    revisions,
    usedBytes: totalUsed(revisions),
  };

  await firestore().runTransaction(async (tx) => {
    const snapshot = await readManifestInTx(tx, uid);
    const current = manifestFromSnapshot(snapshot);
    // Another instance may have migrated this user while this one was walking: its number is as
    // good as ours, and overwriting it with a stale one would be worse than doing nothing.
    if (current !== null && current.revisions !== undefined) {
      return;
    }
    tx.set(manifestDoc(uid), {
      latest: migrated.latest,
      revisions: migrated.revisions ?? {},
      usedBytes: migrated.usedBytes ?? 0,
      session: migrated.session || randomUUID(),
      ref: randomUUID(),
      updatedAt: Date.now(),
    });
  });

  if (expired.length > 0) {
    const writer = firestore().bulkWriter();
    for (const entry of expired) {
      writer.delete(refsCol(uid, entry.resource).doc(entry.ref));
    }
    await writer.close();
  }

  return migrated;
}

/** Read the user's manifest, creating (and returning) it when missing. */
export async function readOrCreateManifest(
  uid: string,
): Promise<SyncManifestBody> {
  const created = await firestore().runTransaction(async (tx) => {
    const snapshot = await readManifestInTx(tx, uid);
    const manifest = manifestFromSnapshot(snapshot);
    if (manifest) {
      return null;
    }
    const fresh: ManifestDoc = {
      latest: {},
      revisions: {},
      usedBytes: 0,
      session: randomUUID(),
      ref: randomUUID(),
      updatedAt: Date.now(),
    };
    tx.set(manifestDoc(uid), fresh);
    return fresh;
  });
  if (created !== null) {
    return toManifestBody(created);
  }
  const current = manifestFromSnapshot(await manifestDoc(uid).get());
  if (current === null) {
    // Deleted between the transaction and this read: one more pass is cheaper than a wrong answer.
    return readOrCreateManifest(uid);
  }
  return toManifestBody(await ensureCounter(uid, current));
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
 *
 * The plan's quota is checked HERE, inside the transaction, and throws 413 with the same body the
 * route used to build: if it does not fit, the transaction writes nothing and the counter cannot
 * drift. The total it compares against is the manifest's own running number — a document this
 * transaction had already read — so the check costs nothing on top of the write it guards. It used
 * to read every stored revision of the user (211 of them, and rising) before the transaction even
 * opened, which is where this project's sync budget was going.
 */
export async function writeResource(
  uid: string,
  resource: string,
  payload: SyncDataPayload,
  ifMatch: string | undefined,
  plan: PlanId,
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
  const limitBytes = quotaBytesFor(plan);

  const manifestSnapshot = await manifestDoc(uid).get();
  const manifest = manifestFromSnapshot(manifestSnapshot);
  await ensureCounter(uid, manifest ?? { latest: {}, session: "", ref: "", updatedAt: 0 });

  return firestore().runTransaction(async (tx) => {
    const snapshot = await readManifestInTx(tx, uid);
    const current = manifestFromSnapshot(snapshot) ?? {
      latest: {},
      session: "",
      ref: "",
      updatedAt: 0,
    };
    const currentLatest =
      current.latest[resource] ?? NON_EXISTING_RESOURCE_REF;

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

    const revisions = current.revisions ?? {};
    const usedBytes = current.usedBytes ?? 0;
    const revisionPlan = planWrite(
      revisions[resource],
      { ref: "", bytes: storedBytes },
      usedBytes,
    );
    if (revisionPlan.usedBytes > limitBytes) {
      throw new HttpError(
        413,
        "TooLarge",
        `Storage quota exceeded for plan "${plan}" (used ${usedBytes} of ${limitBytes} bytes).`,
      );
    }

    const newRef = randomUUID();
    // Sanitize: Firestore hard-rejects `undefined` values — omit optional fields
    // (e.g. machineId on opaque posts) instead of writing them as undefined.
    const refData: Record<string, unknown> = {
      content,
      version: payload.version,
      created: Math.floor(Date.now() / 1000),
      deleted: false,
    };
    if (payload.machineId !== undefined) {
      refData.machineId = payload.machineId;
    }
    tx.set(refsCol(uid, resource).doc(newRef), refData);
    for (const expired of revisionPlan.dropped) {
      if (expired.ref !== "") {
        tx.delete(refsCol(uid, resource).doc(expired.ref));
      }
    }
    setManifest(tx, uid, current, {
      latest: { ...current.latest, [resource]: newRef },
      revisions: {
        ...revisions,
        [resource]: revisionPlan.revisions.map((entry) =>
          entry.ref === "" ? { ref: newRef, bytes: entry.bytes } : entry,
        ),
      },
      usedBytes: revisionPlan.usedBytes,
    });
    return newRef;
  });
}

/** Delete every ref of a resource and reset its manifest entry to "0". */
export async function deleteResource(uid: string, resource: string): Promise<void> {
  const current = manifestFromSnapshot(await manifestDoc(uid).get());
  await ensureCounter(uid, current ?? { latest: {}, session: "", ref: "", updatedAt: 0 });
  await firestore().runTransaction(async (tx) => {
    const snapshot = await readManifestInTx(tx, uid);
    const manifest = manifestFromSnapshot(snapshot) ?? {
      latest: {},
      session: "",
      ref: "",
      updatedAt: 0,
    };
    const plan = planRemoveResource(
      manifest.revisions?.[resource],
      manifest.usedBytes ?? 0,
    );
    for (const ref of plan.dropped) {
      tx.delete(refsCol(uid, resource).doc(ref.ref));
    }
    const revisions = { ...(manifest.revisions ?? {}) };
    delete revisions[resource];
    setManifest(tx, uid, manifest, {
      latest: { ...manifest.latest, [resource]: NON_EXISTING_RESOURCE_REF },
      revisions,
      usedBytes: plan.usedBytes,
    });
  });
}

/** Delete one ref; when it was the latest, reset the manifest entry. */
export async function deleteResourceRef(
  uid: string,
  resource: string,
  ref: string,
): Promise<void> {
  const current = manifestFromSnapshot(await manifestDoc(uid).get());
  await ensureCounter(uid, current ?? { latest: {}, session: "", ref: "", updatedAt: 0 });
  await firestore().runTransaction(async (tx) => {
    const refDocRef = refsCol(uid, resource).doc(ref);
    const snapshot = await tx.get(refDocRef);
    if (!snapshot.exists) {
      throw new HttpError(404, "NotFound", "Ref not found.");
    }
    const manifestSnapshot = await readManifestInTx(tx, uid);
    const manifest = manifestFromSnapshot(manifestSnapshot) ?? {
      latest: {},
      session: "",
      ref: "",
      updatedAt: 0,
    };
    const plan = planRemoveRef(
      manifest.revisions?.[resource],
      ref,
      manifest.usedBytes ?? 0,
    );
    tx.delete(refDocRef);
    // The list is newest first, so what is left at the front is the new latest.
    const remainingLatest = plan.revisions[0]?.ref;
    const revisions = { ...(manifest.revisions ?? {}) };
    if (plan.revisions.length > 0) {
      revisions[resource] = plan.revisions;
    } else {
      delete revisions[resource];
    }
    setManifest(tx, uid, manifest, {
      latest: {
        ...manifest.latest,
        [resource]: remainingLatest ?? NON_EXISTING_RESOURCE_REF,
      },
      revisions,
      usedBytes: plan.usedBytes,
    });
  });
}

/** Clear all the user's data: every resource, every ref, and the manifest. */
export async function deleteAllResources(uid: string): Promise<void> {
  const db = firestore();
  // The sync tree can hold more documents than a single transaction may mutate
  // (Firestore caps transactions at 500 mutations) — clearing a real user's data
  // with runTransaction fails with InternalError. recursiveDelete uses a
  // BulkWriter instead and clears documents AND their subcollections.
  //
  // It also takes the manifest with it, counter and all: an empty profile is
  // created again from scratch on the next request, which is the honest reading
  // of "delete everything".
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
