import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./errors";

/**
 * One try at connecting Jira, tracked on this server so the editor never depends on the browser
 * handing it back through `picode://` (a browser can refuse that link, and another copy of PiCode
 * can have claimed it).
 *
 * The editor opens an attempt for its signed-in account and asks how it is going. Whoever comes
 * back from Atlassian with that attempt's `state` is shown which PiCode account will get the
 * connection and must confirm it: without that step, someone could send a victim their own
 * approval link and receive the victim's Jira in their own account.
 *
 * The code is traded when the person confirms, so it is never stored and never reaches the editor.
 * Pure (no Next.js, no database): `connect-store.ts` supplies the records.
 */

export type AttemptStatus = "pending" | "trading" | "connected" | "failed" | "notPro";
/** What the editor is told. `expired` also covers an unknown attempt or someone else's. */
export type AttemptAnswer = AttemptStatus | "expired";

export interface AttemptRecord {
  readonly uid: string;
  /** Shown on the confirmation page; never the whole address. */
  readonly accountLabel: string;
  readonly status: AttemptStatus;
  readonly expiresAt: number;
}

export interface AttemptRecords {
  create(key: string, record: AttemptRecord): Promise<void>;
  read(key: string): Promise<AttemptRecord | undefined>;
  remove(key: string): Promise<void>;
  /** Runs `decide` on the current record inside one transaction; `next` replaces it when given. */
  change<T>(key: string, decide: (current: AttemptRecord | undefined) => { next?: AttemptRecord; result: T }): Promise<T>;
}

/** The longest the person can take on Atlassian's pages and the confirmation. */
export const ATTEMPT_TTL_MS = 10 * 60_000;

const STATE = /^[A-Za-z0-9-]{8,128}$/;

/**
 * What the confirmation page calls the account that will get the connection. The whole address, or
 * two similar ones would look the same. An address nobody verified could be someone else's, so it
 * is not shown as if it identified the account, and the wording never reads as the visitor's own.
 */
export function accountLabel(email: string | undefined, verified: boolean): string {
  return email && verified ? email : "a PiCode account whose email is not verified";
}

/** States this server issued, told apart without a record: their code never goes to `picode://`. */
export const ATTEMPT_STATE_PREFIX = "att-";

export function isAttemptState(state: string): boolean {
  return state.startsWith(ATTEMPT_STATE_PREFIX);
}

/** The state travels through the browser; only its hash is kept, so the records alone open nothing. */
export function attemptKey(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export type AttemptRequest =
  | { readonly action: "begin" }
  | { readonly action: "poll" | "cancel"; readonly state: string };

export function parseAttemptRequest(raw: unknown): AttemptRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "BadRequest", "Expected a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  if (body.action === "begin") {
    return { action: "begin" };
  }
  if ((body.action === "poll" || body.action === "cancel") && typeof body.state === "string" && STATE.test(body.state)) {
    return { action: body.action, state: body.state };
  }
  throw new HttpError(400, "BadRequest", "Unknown action.");
}

export interface AttemptDeps {
  readonly records: AttemptRecords;
  readonly now?: () => number;
  readonly newState?: () => string;
}

export function createAttempts(deps: AttemptDeps) {
  const { records } = deps;
  const now = deps.now ?? Date.now;
  const newState = deps.newState ?? (() => `${ATTEMPT_STATE_PREFIX}${randomUUID()}`);

  const live = (record: AttemptRecord | undefined): AttemptRecord | undefined =>
    record && record.expiresAt > now() ? record : undefined;

  return {
    /** Opens an attempt for this account and returns the `state` to send to Atlassian. */
    async begin(uid: string, email: string | undefined, emailVerified: boolean): Promise<string> {
      const state = newState();
      await records.create(attemptKey(state), {
        uid,
        accountLabel: accountLabel(email, emailVerified),
        status: "pending",
        expiresAt: now() + ATTEMPT_TTL_MS,
      });
      return state;
    },

    /** The attempt as the browser page needs it; `undefined` when unknown or too old. */
    async find(state: string): Promise<AttemptRecord | undefined> {
      return live(await records.read(attemptKey(state)));
    },

    /**
     * Takes the attempt for trading. Only one confirmation wins (a double click must not spend the
     * one-use code twice); the others get the record back to show how it stands.
     */
    claim(state: string): Promise<{ readonly won: boolean; readonly record: AttemptRecord | undefined }> {
      return records.change<{ readonly won: boolean; readonly record: AttemptRecord | undefined }>(attemptKey(state), (current) => {
        const record = live(current);
        if (record?.status !== "pending") {
          return { result: { won: false, record } };
        }
        const next: AttemptRecord = { ...record, status: "trading" };
        return { next, result: { won: true, record: next } };
      });
    },

    /**
     * Records how it ended; a finished attempt stays as it is. A trade already under way may end
     * after the time limit, and the owner still gets time to hear how it went.
     */
    finish(state: string, status: "connected" | "failed" | "notPro"): Promise<void> {
      return records.change(attemptKey(state), (current) => {
        if (!current || (current.status !== "trading" && !(current.status === "pending" && live(current)))) {
          return { result: undefined };
        }
        return { next: { ...current, status, expiresAt: now() + ATTEMPT_TTL_MS }, result: undefined };
      });
    },

    /** The owner stopped waiting: from here the attempt can no longer be confirmed. */
    cancel(uid: string, state: string): Promise<void> {
      const key = attemptKey(state);
      return records.change(key, (current) => {
        if (current?.uid !== uid || current.status !== "pending") {
          return { result: undefined };
        }
        return { next: { ...current, status: "failed" }, result: undefined };
      });
    },

    /** What the editor sees. An answer that ends the attempt also removes it. */
    async poll(uid: string, state: string): Promise<AttemptAnswer> {
      const key = attemptKey(state);
      const current = await records.read(key);
      // Someone else's attempt looks exactly like one that does not exist.
      if (!current || current.uid !== uid) {
        return "expired";
      }
      if (!live(current)) {
        await records.remove(key);
        return "expired";
      }
      if (current.status === "pending" || current.status === "trading") {
        return current.status;
      }
      await records.remove(key);
      return current.status;
    },
  };
}
