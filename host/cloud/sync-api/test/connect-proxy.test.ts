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

const { isRateLimited, parseProxyRequest, proxyHeaders, usableEtag } = await import("../src/lib/connect-proxy.ts");
const { connectorKey, expiryOf, needsRenewal, openTokens, sealTokens } = await import("../src/lib/connect-seal.ts");
const { HttpError } = await import("../src/lib/errors.ts");

function refused(raw: unknown, status: number): void {
  assert.throws(() => parseProxyRequest(raw), (error: unknown) => error instanceof HttpError && error.status === status, JSON.stringify(raw));
}

const CLOUD = "11111111-2222-3333-4444-555555555555";
const JIRA = `/ex/jira/${CLOUD}/rest/api/3`;

test("every call the issue panels make is allowed, on the service's own address", () => {
  const calls: ReadonlyArray<[string, string, string, unknown?]> = [
    ["github", "GET", "/user/installations?per_page=100"],
    ["github", "GET", "/user/installations/123/repositories?per_page=100"],
    ["github", "GET", "/repos/Tomas-Platero/PiCode-Website/issues?state=open&sort=updated&per_page=30"],
    ["github", "GET", "/repos/o/r/labels?per_page=100"],
    ["github", "GET", "/repos/o/r/assignees?per_page=100"],
    ["github", "PATCH", "/repos/o/r/issues/12", { title: "x" }],
    ["atlassian", "GET", "/oauth/token/accessible-resources"],
    ["atlassian", "GET", `${JIRA}/project/ATW`],
    ["atlassian", "GET", `${JIRA}/project/ATW/statuses`],
    ["atlassian", "GET", `${JIRA}/project/search?maxResults=50&orderBy=name`],
    ["atlassian", "GET", `${JIRA}/search/jql?jql=${encodeURIComponent("project = ATW ORDER BY updated DESC")}&fields=summary,labels&maxResults=100`],
    ["atlassian", "GET", `${JIRA}/priority`],
    ["atlassian", "GET", `${JIRA}/issue/ATW-52/editmeta`],
    ["atlassian", "GET", `${JIRA}/issue/ATW-52/transitions`],
    ["atlassian", "POST", `${JIRA}/issue/ATW-52/transitions`, { transition: { id: "1" } }],
    ["atlassian", "PUT", `${JIRA}/issue/ATW-52`, { fields: {} }],
    ["atlassian", "GET", `${JIRA}/user/assignable/search?issueKey=ATW-52&query=ana&maxResults=20`],
    ["atlassian", "GET", `${JIRA}/user/search?query=ana&maxResults=20`],
    ["atlassian", "GET", `/ex/jira/${CLOUD}/rest/agile/1.0/board?projectKeyOrId=ATW&maxResults=10`],
    ["atlassian", "GET", `/ex/jira/${CLOUD}/rest/agile/1.0/board/7/configuration`],
  ];
  for (const [service, method, path, json] of calls) {
    const parsed = parseProxyRequest({ service, method, path, ...(json === undefined ? {} : { json }) });
    const origin = service === "github" ? "https://api.github.com" : "https://api.atlassian.com";
    assert.equal(new URL(parsed.url).origin, origin);
    assert.equal(parsed.url, `${origin}${path}`);
  }
});

test("anything else on the same service is refused", () => {
  // Real, dangerous calls a token could make that the panels never do.
  refused({ service: "github", method: "GET", path: "/user" }, 403);
  refused({ service: "github", method: "GET", path: "/user/repos" }, 403);
  refused({ service: "github", method: "GET", path: "/repos/o/r/contents/.env" }, 403);
  refused({ service: "github", method: "POST", path: "/repos/o/r/issues", json: {} }, 403);
  refused({ service: "github", method: "PUT", path: "/repos/o/r/issues/1", json: {} }, 403);
  refused({ service: "github", method: "PATCH", path: "/repos/o/r", json: { private: false } }, 403);
  refused({ service: "atlassian", method: "PUT", path: `${JIRA}/project/ATW`, json: {} }, 403);
  refused({ service: "atlassian", method: "GET", path: `${JIRA}/myself` }, 403);
  refused({ service: "atlassian", method: "POST", path: `${JIRA}/issue/ATW-1`, json: {} }, 403);
  // A call of one service, asked of the other.
  refused({ service: "atlassian", method: "GET", path: "/user/installations" }, 403);
});

test("a path cannot be bent to leave the allowed list or the service", () => {
  for (const path of [
    "/repos/o/r/issues/../../../user",
    "/repos/o/r/issues/%2e%2e/%2e%2e/user",
    "/repos/o/r/issues%2F1",
    "//evil.example/repos/o/r/issues",
    "/repos/o/r/issues\\..\\..",
    "/repos/o/r/issues#x",
    "/repos/o/r/issues?x=1#y",
    "/repos/o/r/issues?a=b\nc",
    "@evil.example/user/installations",
    ".evil.example/user/installations",
    "https://evil.example/user/installations",
    "",
  ]) {
    assert.throws(() => parseProxyRequest({ service: "github", method: "GET", path }), HttpError, path);
  }
});

test("the shape of the request is checked", () => {
  refused(null, 400);
  refused([], 400);
  refused({ service: "gitlab", method: "GET", path: "/user/installations" }, 400);
  refused({ service: "github", method: "DELETE", path: "/repos/o/r/issues/1" }, 400);
  refused({ service: "github", method: "GET", path: 5 }, 400);
  refused({ service: "github", method: "GET", path: "/user/installations", json: {} }, 400);
  refused({ service: "github", method: "PATCH", path: "/repos/o/r/issues/1" }, 400);
  refused({ service: "github", method: "PATCH", path: "/repos/o/r/issues/1", json: [] }, 400);
  refused({ service: "github", method: "PATCH", path: "/repos/o/r/issues/1", json: { body: "x".repeat(300 * 1024) } }, 413);
  refused({ service: "github", method: "GET", path: "/user/installations", ifNoneMatch: "bad\r\nX-Evil: 1" }, 400);
});

test("the token only goes in the Authorization header, and an etag passes through", () => {
  const request = parseProxyRequest({ service: "github", method: "GET", path: "/user/installations", ifNoneMatch: 'W/"abc"' });
  const headers = proxyHeaders(request, "secret");
  assert.equal(headers.Authorization, "Bearer secret");
  assert.equal(headers["If-None-Match"], 'W/"abc"');
  assert.ok(!request.url.includes("secret"));
  assert.equal(headers["Content-Type"], undefined);
  assert.equal(proxyHeaders(parseProxyRequest({ service: "atlassian", method: "PUT", path: `${JIRA}/issue/A-1`, json: {} }), "s")["Content-Type"], "application/json");
});

test("a rate limit is told apart from a plain refusal", () => {
  assert.equal(isRateLimited(429, null), true);
  assert.equal(isRateLimited(403, "0"), true);
  assert.equal(isRateLimited(403, "12"), false);
  assert.equal(isRateLimited(200, "0"), false);
});

const KEY = randomBytes(32);
const TOKENS = { accessToken: "gho_secret", refreshToken: "ghr_secret", expiresIn: 3600 };

test("sealed tokens open with the same key, owner and service", () => {
  const sealed = sealTokens(TOKENS, KEY, "uid1", "github");
  assert.deepEqual(openTokens(sealed, KEY, "uid1", "github"), TOKENS);
  assert.ok(!sealed.toString("latin1").includes("gho_secret"), "nothing readable is stored");
  assert.ok(!sealed.toString("latin1").includes("ghr_secret"));
});

test("a sealed value does not open for someone else, another service or another key", () => {
  const sealed = sealTokens(TOKENS, KEY, "uid1", "github");
  assert.equal(openTokens(sealed, KEY, "uid2", "github"), undefined);
  assert.equal(openTokens(sealed, KEY, "uid1", "atlassian"), undefined);
  assert.equal(openTokens(sealed, randomBytes(32), "uid1", "github"), undefined);
});

test("a changed or malformed value does not open", () => {
  const sealed = sealTokens(TOKENS, KEY, "uid1", "github");
  const changed = Buffer.from(sealed);
  changed[changed.length - 1]! ^= 1;
  assert.equal(openTokens(changed, KEY, "uid1", "github"), undefined);
  assert.equal(openTokens(Buffer.from("nope"), KEY, "uid1", "github"), undefined);
  assert.equal(openTokens(Buffer.alloc(0), KEY, "uid1", "github"), undefined);
});

test("no key, no connection: tokens are never stored unprotected", () => {
  const notConfigured = (env: Record<string, string | undefined>) =>
    assert.throws(() => connectorKey(env), (error: unknown) => error instanceof HttpError && error.status === 503);
  notConfigured({});
  notConfigured({ PICODE_ENCRYPTION_KEY: "" });
  notConfigured({ PICODE_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") });
});

test("the tokens' key is derived: it is not the key that protects synced data", () => {
  const master = randomBytes(32);
  const key = connectorKey({ PICODE_ENCRYPTION_KEY: master.toString("base64") });
  assert.equal(key.length, 32);
  assert.ok(!key.equals(master));
  assert.ok(key.equals(connectorKey({ PICODE_ENCRYPTION_KEY: master.toString("base64") })), "the same every time");
});

test("a token is renewed a little before it dies, and one with no expiry is not", () => {
  assert.equal(expiryOf({ accessToken: "a" }, 1000), null);
  assert.equal(expiryOf({ accessToken: "a", expiresIn: 60 }, 1000), 61_000);
  assert.equal(needsRenewal(null, 1000), false);
  assert.equal(needsRenewal(undefined, 1000), false);
  assert.equal(needsRenewal(1000 + 120_000, 1000), false);
  assert.equal(needsRenewal(1000 + 30_000, 1000), true);
});

test("a repository may have two dots in its name, but a path may not climb", () => {
  assert.equal(parseProxyRequest({ service: "github", method: "GET", path: "/repos/o/a..b/issues" }).url, "https://api.github.com/repos/o/a..b/issues");
  refused({ service: "github", method: "GET", path: "/repos/../r/issues" }, 400);
  refused({ service: "github", method: "GET", path: "/repos/o/../issues" }, 400);
});

test("only an etag the next read can send back is passed on", () => {
  assert.equal(usableEtag('W/"abc"'), 'W/"abc"');
  assert.equal(usableEtag("abc"), undefined);
  assert.equal(usableEtag('"a b"'), undefined);
  assert.equal(usableEtag(null), undefined);
});
