import { buildProviderRequest, readProviderTokens } from "./connect";
import type { ConnectRequest, ConnectService } from "./connect";
import { AttemptRecord, createAttempts } from "./connect-attempts";
import { ConnectionRecord, ConnectionRecords, createConnections } from "./connect-renewal";
import { connectorKey } from "./connect-seal";
import { HttpError } from "./errors";
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

/**
 * Trades a Jira code for the account's connection. The provider's secret lives in this server's
 * environment and the tokens stay here, sealed.
 */
export async function connectWithCode(uid: string, connect: ConnectRequest): Promise<void> {
  // Before the one-use code is spent: with no way to store the tokens, there is no point.
  connectorKey(process.env);
  const provider = buildProviderRequest(connect, process.env);
  let response: Response;
  try {
    response = await fetch(provider.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PiCode" },
      body: JSON.stringify(provider.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "BadGateway", "The service could not be reached.");
  }
  const tokens = readProviderTokens(await response.json().catch(() => undefined));
  if (!tokens) {
    // The provider refused (revoked, expired, wrong code). The editor treats 401 as "connect again".
    throw new HttpError(401, "Unauthorized", "The connection needs to be made again.");
  }
  await saveConnection(uid, connect.service, tokens);
}

/**
 * Jira connection attempts (`connect-attempts.ts`). Not under the user's document: the browser
 * comes back with only the `state`. Client access is denied by the Firestore rules' default, and
 * `expireAt` is there for a TTL policy to clear abandoned attempts.
 */
const ATTEMPTS_COLLECTION = "connectAttempts";

function attemptReference(key: string) {
  return firestore().collection(ATTEMPTS_COLLECTION).doc(key);
}

function toAttempt(data: FirebaseFirestore.DocumentData | undefined): AttemptRecord | undefined {
  if (!data || typeof data.uid !== "string" || typeof data.expiresAt !== "number") {
    return undefined;
  }
  return { uid: data.uid, accountLabel: String(data.accountLabel ?? ""), status: data.status, expiresAt: data.expiresAt };
}

const withExpiry = (record: AttemptRecord) => ({ ...record, expireAt: new Date(record.expiresAt) });

export const connectAttempts = createAttempts({
  records: {
    async create(key, record) {
      await attemptReference(key).create(withExpiry(record));
    },
    async read(key) {
      return toAttempt((await attemptReference(key).get()).data());
    },
    async remove(key) {
      await attemptReference(key).delete();
    },
    change(key, decide) {
      const ref = attemptReference(key);
      return firestore().runTransaction(async (transaction) => {
        const { next, result } = decide(toAttempt((await transaction.get(ref)).data()));
        if (next) {
          transaction.set(ref, withExpiry(next));
        }
        return result;
      });
    },
  },
});

export async function deleteAllConnections(uid: string): Promise<void> {
  await Promise.all((["github", "atlassian"] as const).map((service) => connections.remove(uid, service)));
}
