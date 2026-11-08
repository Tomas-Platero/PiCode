import type { ConnectService } from "./connect";
import { ConnectionRecord, ConnectionRecords, createConnections } from "./connect-renewal";
import { FIRESTORE_COLLECTIONS, firestore } from "./firebase-admin";

/**
 * The person's GitHub and Jira connections: `/users/{uid}/connectors/{service}`, sealed
 * (`connect-seal.ts`). Under the user's document on purpose: the website's account deletion is a
 * recursive delete of that document, so these go with it. The editor never receives a token; it
 * asks this server to make each call, and the server checks the plan every time.
 */

function reference(uid: string, service: ConnectService) {
  return firestore().collection(FIRESTORE_COLLECTIONS.users).doc(uid).collection("connectors").doc(service);
}

function toRecord(data: FirebaseFirestore.DocumentData | undefined): ConnectionRecord | undefined {
  if (!data || !Buffer.isBuffer(data.sealed)) {
    return undefined;
  }
  return {
    sealed: data.sealed,
    expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : null,
    leaseUntil: typeof data.leaseUntil === "number" ? data.leaseUntil : 0,
  };
}

const records: ConnectionRecords = {
  async put(uid, service, record) {
    await reference(uid, service).set({ ...record, updatedAt: Date.now() });
  },
  async remove(uid, service) {
    await reference(uid, service).delete();
  },
  change(uid, service, decide) {
    const ref = reference(uid, service);
    return firestore().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const { next, result } = decide(toRecord(snapshot.data()));
      if (next) {
        transaction.set(ref, { ...next, updatedAt: Date.now() });
      }
      return result;
    });
  },
};

const connections = createConnections({ records, fetch: (...args) => fetch(...args), env: process.env });

export const saveConnection = connections.save;
export const deleteConnection = connections.remove;
export const accessTokenFor = connections.accessTokenFor;

export async function deleteAllConnections(uid: string): Promise<void> {
  await Promise.all((["github", "atlassian"] as const).map((service) => connections.remove(uid, service)));
}
