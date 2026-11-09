import assert from "node:assert/strict";
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

const { accountLabel, ATTEMPT_TTL_MS, attemptKey, createAttempts, isAttemptState, parseAttemptRequest } = await import("../src/lib/connect-attempts.ts");
const { HttpError } = await import("../src/lib/errors.ts");

type Rec = import("../src/lib/connect-attempts.ts").AttemptRecord;

const STATE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OWNER = "owner";

/** Records in memory, with a transaction that runs after a pause, as a real database's would. */
function setup() {
  const store = new Map<string, Rec>();
  let clock = 1_000;
  const attempts = createAttempts({
    now: () => clock,
    newState: () => STATE,
    records: {
      async create(key, record) {
        assert.ok(!store.has(key), "create must not replace an attempt");
        store.set(key, record);
      },
      async read(key) {
        return store.get(key);
      },
      async remove(key) {
        store.delete(key);
      },
      async change(key, decide) {
        const { next, result } = decide(store.get(key));
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (next) {
          store.set(key, next);
        }
        return result;
      },
    },
  });
  return { attempts, store, pass: (ms: number) => { clock += ms; } };
}

test("the confirmation names the account in full, and only when its email is verified", () => {
  assert.equal(accountLabel("tomas@gmail.com", true), "tomas@gmail.com");
  assert.notEqual(accountLabel("tomas@gmail.com", true), accountLabel("t.attacker@gmail.com", true));
  for (const label of [accountLabel("tomas@gmail.com", false), accountLabel(undefined, true), accountLabel(undefined, false)]) {
    assert.ok(!label.includes("tomas"));
    assert.ok(!label.toLowerCase().includes("your"));
  }
});

test("states this server issues are told apart from the ones older editors make", () => {
  const issued = createAttempts({ records: { create: async () => undefined } as never });
  return issued.begin(OWNER, undefined, false).then((state: string) => {
    assert.equal(isAttemptState(state), true);
    assert.equal(isAttemptState(STATE), false);
  });
});

test("the owner can close an attempt, and then it cannot be confirmed", async () => {
  const { attempts } = setup();
  await attempts.begin(OWNER, undefined, false);
  await attempts.cancel("other", STATE);
  assert.equal((await attempts.find(STATE))?.status, "pending");
  await attempts.cancel(OWNER, STATE);
  assert.equal((await attempts.claim(STATE)).won, false);
});

test("a trade that ends after the time limit is still told to its owner", async () => {
  const { attempts, pass } = setup();
  await attempts.begin(OWNER, undefined, false);
  await attempts.claim(STATE);
  pass(ATTEMPT_TTL_MS + 1);
  await attempts.finish(STATE, "connected");
  assert.equal(await attempts.poll(OWNER, STATE), "connected");
});

test("a pending attempt that is too old cannot be finished", async () => {
  const { attempts, pass } = setup();
  await attempts.begin(OWNER, undefined, false);
  pass(ATTEMPT_TTL_MS + 1);
  await attempts.finish(STATE, "connected");
  assert.equal(await attempts.poll(OWNER, STATE), "expired");
});

test("an attempt waits for the person, and the state itself is not what is stored", async () => {
  const { attempts, store } = setup();
  assert.equal(await attempts.begin(OWNER, "tomas@gmail.com", true), STATE);
  assert.deepEqual([...store.keys()], [attemptKey(STATE)]);
  assert.ok(!JSON.stringify([...store.entries()]).includes(STATE));
  assert.equal(await attempts.poll(OWNER, STATE), "pending");
  assert.equal((await attempts.find(STATE))?.accountLabel, "tomas@gmail.com");
});

test("once connected, the owner is told once and the attempt is gone", async () => {
  const { attempts, store } = setup();
  await attempts.begin(OWNER, undefined, false);
  assert.equal((await attempts.claim(STATE)).won, true);
  assert.equal(await attempts.poll(OWNER, STATE), "trading");
  await attempts.finish(STATE, "connected");
  assert.equal(await attempts.poll(OWNER, STATE), "connected");
  assert.equal(store.size, 0);
  assert.equal(await attempts.poll(OWNER, STATE), "expired");
});

test("someone else's attempt looks like one that does not exist, and is left untouched", async () => {
  const { attempts, store } = setup();
  await attempts.begin(OWNER, undefined, false);
  await attempts.finish(STATE, "connected");
  assert.equal(await attempts.poll("other", STATE), "expired");
  assert.equal(store.size, 1);
  assert.equal(await attempts.poll(OWNER, STATE), "connected");
});

test("a second confirmation does not win, so a code is not spent twice", async () => {
  const { attempts } = setup();
  await attempts.begin(OWNER, undefined, false);
  assert.equal((await attempts.claim(STATE)).won, true);
  const second = await attempts.claim(STATE);
  assert.equal(second.won, false);
  assert.equal(second.record?.status, "trading");
});

test("an old attempt cannot be confirmed and ends as expired", async () => {
  const { attempts, store, pass } = setup();
  await attempts.begin(OWNER, undefined, false);
  pass(ATTEMPT_TTL_MS + 1);
  assert.equal(await attempts.find(STATE), undefined);
  assert.deepEqual(await attempts.claim(STATE), { won: false, record: undefined });
  assert.equal(await attempts.poll(OWNER, STATE), "expired");
  assert.equal(store.size, 0);
});

test("an unknown state can be neither confirmed nor finished", async () => {
  const { attempts, store } = setup();
  assert.deepEqual(await attempts.claim(STATE), { won: false, record: undefined });
  await attempts.finish(STATE, "connected");
  assert.equal(store.size, 0);
});

test("a finished attempt does not change its ending", async () => {
  const { attempts } = setup();
  await attempts.begin(OWNER, undefined, false);
  await attempts.finish(STATE, "connected");
  await attempts.finish(STATE, "failed");
  assert.equal(await attempts.poll(OWNER, STATE), "connected");
});

test("only the two actions are accepted, and only a plain state", () => {
  assert.deepEqual(parseAttemptRequest({ action: "begin", state: "ignored" }), { action: "begin" });
  assert.deepEqual(parseAttemptRequest({ action: "poll", state: STATE }), { action: "poll", state: STATE });
  assert.deepEqual(parseAttemptRequest({ action: "cancel", state: STATE }), { action: "cancel", state: STATE });
  for (const raw of [undefined, [], { action: "other" }, { action: "poll" }, { action: "poll", state: "short" }, { action: "poll", state: "a\"><script>aaaa" }]) {
    assert.throws(() => parseAttemptRequest(raw), (error: unknown) => error instanceof HttpError && error.status === 400);
  }
});
