import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

// The library imports its siblings without an extension (the Next.js way); under plain node
// they resolve to their `.ts` file.
register(
  "data:text/javascript," +
    encodeURIComponent(
      "export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if (s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c); throw e; } }",
    ),
);

const { createConnections } = await import("../src/lib/connect-renewal.ts");
const { isRefreshRefused } = await import("../src/lib/connect.ts");
const { connectorKey, openTokens } = await import("../src/lib/connect-seal.ts");
const { HttpError } = await import("../src/lib/errors.ts");

const ENV = {
  PICODE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ATLASSIAN_CLIENT_ID: "id",
  ATLASSIAN_CLIENT_SECRET: "secret",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
};
const UID = "u1";
const SERVICE = "atlassian" as const;

type Rec = import("../src/lib/connect-renewal.ts").ConnectionRecord;

/** One record, with a transaction that runs after a pause, as a real database's would. */
function memory() {
  const state: { record: Rec | undefined } = { record: undefined };
  return {
    state,
    records: {
      async put(_u: string, _s: string, record: Rec) { state.record = record; },
      async remove() { state.record = undefined; },
      async change<T>(_u: string, _s: string, decide: (current: Rec | undefined) => { next?: Rec; result: T }): Promise<T> {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const { next, result } = decide(state.record);
        if (next) {
          state.record = next;
        }
        return result;
      },
    },
  };
}

function connections(fetchFn: typeof fetch, now?: () => number) {
  const store = memory();
  const api = createConnections({ records: store.records, fetch: fetchFn, env: ENV, wait: () => new Promise((resolve) => setTimeout(resolve, 2)), ...(now ? { now } : {}) });
  return { api, store };
}

const stored = (store: ReturnType<typeof memory>) => store.state.record && openTokens(store.state.record.sealed, connectorKey(ENV), UID, SERVICE);
const answer = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const EXPIRED = { accessToken: "A0", refreshToken: "R0", expiresIn: 1 };

test("a live token is used as it is, and the provider is not asked", async () => {
  const { api } = connections(async () => assert.fail("no renewal was needed"));
  await api.save(UID, SERVICE, { accessToken: "A0", refreshToken: "R0", expiresIn: 3600 });
  assert.equal(await api.accessTokenFor(UID, SERVICE), "A0");
});

test("no connection is no token", async () => {
  const { api } = connections(async () => assert.fail());
  assert.equal(await api.accessTokenFor(UID, SERVICE), undefined);
});

test("a renewal keeps the new token, and the old refresh token if the provider gave no new one", async () => {
  const { api, store } = connections(async () => answer(200, { access_token: "A1", expires_in: 3600 }));
  await api.save(UID, SERVICE, EXPIRED);
  assert.equal(await api.accessTokenFor(UID, SERVICE), "A1");
  assert.deepEqual(stored(store), { accessToken: "A1", refreshToken: "R0", expiresIn: 3600 });
  assert.equal(store.state.record?.leaseUntil, 0);
});

test("a fault that says nothing about the account keeps the connection", async () => {
  const faults: ReadonlyArray<[string, () => Promise<Response>]> = [
    ["rate limit", async () => answer(429, { message: "slow" })],
    ["firewall page", async () => answer(403, "<html>")],
    ["an error page with a 200", async () => answer(200, "<html>")],
    ["our own wrong secret", async () => answer(401, { error: "invalid_client" })],
    ["server error", async () => answer(500, { error: "invalid_grant" })],
    ["no network", async () => { throw new Error("down"); }],
  ];
  for (const [name, fault] of faults) {
    const { api, store } = connections(fault as typeof fetch);
    await api.save(UID, SERVICE, EXPIRED);
    await assert.rejects(api.accessTokenFor(UID, SERVICE), (error: unknown) => error instanceof HttpError && error.status === 502, name);
    assert.equal(stored(store)?.refreshToken, "R0", `${name}: the connection stays`);
    assert.equal(store.state.record?.leaseUntil, 0, `${name}: the next call can try again`);
  }
});

test("a refresh token the provider rejects ends the connection", async () => {
  for (const body of [{ error: "invalid_grant" }, { error: "bad_refresh_token" }]) {
    const { api, store } = connections(async () => answer(body.error === "invalid_grant" ? 403 : 200, body));
    await api.save(UID, SERVICE, EXPIRED);
    assert.equal(await api.accessTokenFor(UID, SERVICE), undefined);
    assert.equal(store.state.record, undefined);
  }
  assert.equal(isRefreshRefused({ error: "invalid_client" }), false);
  assert.equal(isRefreshRefused(undefined), false);
});

/** A provider like Atlassian: each refresh token works once, and using an old one is refused. */
function rotatingProvider() {
  let live = "R0";
  let issued = 0;
  const asked: string[] = [];
  const provider = (async (_url: unknown, init: RequestInit) => {
    const { refresh_token: token } = JSON.parse(String(init.body)) as { refresh_token: string };
    asked.push(token);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (token !== live) {
      return answer(403, { error: "invalid_grant" });
    }
    issued++;
    live = `R${issued}`;
    return answer(200, { access_token: `A${issued}`, refresh_token: live, expires_in: 3600 });
  }) as typeof fetch;
  return { provider, asked };
}

test("calls at the same moment renew once and all get the new token", async () => {
  const { provider, asked } = rotatingProvider();
  const { api, store } = connections(provider);
  await api.save(UID, SERVICE, EXPIRED);
  const tokens = await Promise.all(Array.from({ length: 5 }, () => api.accessTokenFor(UID, SERVICE)));
  assert.deepEqual(asked, ["R0"]);
  assert.deepEqual([...new Set(tokens)], ["A1"]);
  assert.equal(stored(store)?.refreshToken, "R1");
});

test("a call that read before another renewed never sends the spent refresh token", async () => {
  const { provider, asked } = rotatingProvider();
  const { api, store } = connections(provider);
  await api.save(UID, SERVICE, EXPIRED);
  const first = api.accessTokenFor(UID, SERVICE);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const second = api.accessTokenFor(UID, SERVICE);
  assert.deepEqual(await Promise.all([first, second]), ["A1", "A1"]);
  assert.deepEqual(asked, ["R0"]);
  assert.equal(stored(store)?.accessToken, "A1", "the connection survives");
});

test("a token the service refused is renewed once, even with others asking", async () => {
  const { provider, asked } = rotatingProvider();
  const { api } = connections(provider);
  await api.save(UID, SERVICE, { accessToken: "A0", refreshToken: "R0", expiresIn: 3600 });
  const tokens = await Promise.all([api.accessTokenFor(UID, SERVICE, "A0"), api.accessTokenFor(UID, SERVICE, "A0")]);
  assert.deepEqual(tokens, ["A1", "A1"]);
  assert.deepEqual(asked, ["R0"]);
});

test("disconnecting during a renewal stays disconnected", async () => {
  let disconnect: () => Promise<void> = async () => undefined;
  const { api, store } = connections((async () => {
    await disconnect();
    return answer(200, { access_token: "A1", refresh_token: "R1", expires_in: 3600 });
  }) as typeof fetch);
  disconnect = () => api.remove(UID, SERVICE);
  await api.save(UID, SERVICE, EXPIRED);
  assert.equal(await api.accessTokenFor(UID, SERVICE), undefined);
  assert.equal(store.state.record, undefined, "the renewed token is not written back");
});

test("a lease left behind by a crash stops holding the others back", async () => {
  let clock = 1_000_000;
  const { api, store } = connections((async () => answer(200, { access_token: "A1", expires_in: 3600 })) as typeof fetch, () => clock);
  await api.save(UID, SERVICE, EXPIRED);
  store.state.record = { ...store.state.record!, expiresAt: clock - 1, leaseUntil: clock + 20_000 };
  await assert.rejects(api.accessTokenFor(UID, SERVICE), (error: unknown) => error instanceof HttpError && error.status === 503);
  clock += 20_001;
  assert.equal(await api.accessTokenFor(UID, SERVICE), "A1");
});

test("without a key nothing is stored and nothing is opened", async () => {
  const store = memory();
  const api = createConnections({ records: store.records, fetch: fetch, env: {} });
  await assert.rejects(api.save(UID, SERVICE, EXPIRED), (error: unknown) => error instanceof HttpError && error.status === 503);
  assert.equal(store.state.record, undefined);
});
