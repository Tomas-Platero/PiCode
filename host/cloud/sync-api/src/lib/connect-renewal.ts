import { buildProviderRequest, isRefreshRefused, readProviderTokens } from "./connect";
import type { ConnectService, ConnectTokens } from "./connect";
import { connectorKey, expiryOf, needsRenewal, openTokens, sealTokens } from "./connect-seal";
import { HttpError } from "./errors";

/**
 * Keeping a connection alive. Pure of Firestore and of the network (both come in), so `node --test`
 * can run the races that matter:
 *
 *  - Atlassian's refresh token changes with every use, so two renewals at once kill the connection.
 *    The token to renew is read inside the same transaction that takes the lease: whoever gets the
 *    lease always holds the newest one, and may find there is nothing left to renew.
 *  - A connection is only ended when the provider says that refresh token is no good. A rate limit,
 *    an HTML error page or a wrong client secret on our side say nothing about the person's account.
 *  - Disconnecting during a renewal stays disconnected: a renewal only writes to a record that exists.
 */

export interface ConnectionRecord {
  readonly sealed: Buffer;
  readonly expiresAt: number | null;
  readonly leaseUntil: number;
}

/** The storage: `change` runs as one transaction. */
export interface ConnectionRecords {
  put(uid: string, service: ConnectService, record: ConnectionRecord): Promise<void>;
  remove(uid: string, service: ConnectService): Promise<void>;
  change<T>(uid: string, service: ConnectService, decide: (current: ConnectionRecord | undefined) => { readonly next?: ConnectionRecord; readonly result: T }): Promise<T>;
}

export interface ConnectionDeps {
  readonly records: ConnectionRecords;
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

const RENEWAL_LEASE_MS = 20_000;
const RENEWAL_WAIT_MS = 1_000;
const RENEWAL_WAITS = 5;

type Step =
  | { readonly kind: "gone" }
  | { readonly kind: "ready"; readonly accessToken: string }
  | { readonly kind: "wait" }
  | { readonly kind: "renew"; readonly tokens: ConnectTokens };

export function createConnections(deps: ConnectionDeps) {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const key = () => connectorKey(deps.env);

  const seal = (uid: string, service: ConnectService, tokens: ConnectTokens): ConnectionRecord => ({
    sealed: sealTokens(tokens, key(), uid, service),
    expiresAt: expiryOf(tokens, now()),
    leaseUntil: 0,
  });

  const releaseLease = (uid: string, service: ConnectService) =>
    deps.records.change(uid, service, (current) => (current ? { next: { ...current, leaseUntil: 0 }, result: undefined } : { result: undefined }));

  async function renew(uid: string, service: ConnectService, tokens: ConnectTokens): Promise<string | undefined> {
    const provider = buildProviderRequest({ service, grant: "refresh_token", refreshToken: tokens.refreshToken }, deps.env);
    let status: number;
    let json: unknown;
    try {
      const response = await deps.fetch(provider.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PiCode" },
        body: JSON.stringify(provider.body),
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      json = await response.json().catch(() => undefined);
    } catch {
      await releaseLease(uid, service);
      throw new HttpError(502, "BadGateway", "The service could not be reached.");
    }
    const renewed = status < 500 ? readProviderTokens(json) : undefined;
    if (renewed) {
      // Saved before anything else: this refresh token is the only one that works from now on.
      const next = seal(uid, service, { ...renewed, refreshToken: renewed.refreshToken ?? tokens.refreshToken });
      return deps.records.change(uid, service, (current) => (current ? { next, result: renewed.accessToken } : { result: undefined }));
    }
    if (status < 500 && isRefreshRefused(json)) {
      await deps.records.remove(uid, service);
      return undefined;
    }
    await releaseLease(uid, service);
    throw new HttpError(502, "BadGateway", "The service could not renew the connection.");
  }

  return {
    async save(uid: string, service: ConnectService, tokens: ConnectTokens): Promise<void> {
      await deps.records.put(uid, service, seal(uid, service, tokens));
    },

    remove: (uid: string, service: ConnectService): Promise<void> => deps.records.remove(uid, service),

    /**
     * A token good for the next call, or `undefined` when there is no connection. `refused` is a
     * token the service just turned down: a new one is wanted, unless someone already renewed it.
     */
    async accessTokenFor(uid: string, service: ConnectService, refused?: string): Promise<string | undefined> {
      for (let attempt = 0; attempt <= RENEWAL_WAITS; attempt++) {
        const step = await deps.records.change<Step>(uid, service, (current) => {
          const tokens = current && openTokens(current.sealed, key(), uid, service);
          if (!current || !tokens) {
            return { result: { kind: "gone" } };
          }
          const stale = refused !== undefined && tokens.accessToken === refused;
          if (!stale && !needsRenewal(current.expiresAt, now())) {
            return { result: { kind: "ready", accessToken: tokens.accessToken } };
          }
          if (!tokens.refreshToken) {
            return { result: stale ? { kind: "gone" } : { kind: "ready", accessToken: tokens.accessToken } };
          }
          if (current.leaseUntil > now()) {
            return { result: { kind: "wait" } };
          }
          return { next: { ...current, leaseUntil: now() + RENEWAL_LEASE_MS }, result: { kind: "renew", tokens } };
        });
        switch (step.kind) {
          case "gone": return undefined;
          case "ready": return step.accessToken;
          case "renew": return renew(uid, service, step.tokens);
          case "wait": await wait(RENEWAL_WAIT_MS); break;
        }
      }
      throw new HttpError(503, "Busy", "The connection is being renewed. Try again in a moment.");
    },
  };
}
