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

const { buildProviderRequest, editorCallbackUrl, parseConnectRequest, readProviderTokens } = await import("../src/lib/connect.ts");
const { HttpError } = await import("../src/lib/errors.ts");

const ENV = {
  GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret",
  ATLASSIAN_CLIENT_ID: "at-id", ATLASSIAN_CLIENT_SECRET: "at-secret", ATLASSIAN_REDIRECT_URI: "https://api.example/cb",
};

const rejects = (fn: () => unknown, status: number): void =>
  assert.throws(fn, (error: unknown) => error instanceof HttpError && error.status === status);

test("an Atlassian code is accepted, a GitHub code is not (GitHub trades its own in the editor)", () => {
  assert.deepEqual(parseConnectRequest({ service: "atlassian", grant: "authorization_code", code: "abc.DEF-1" }),
    { service: "atlassian", grant: "authorization_code", code: "abc.DEF-1" });
  rejects(() => parseConnectRequest({ service: "github", grant: "authorization_code", code: "abc" }), 400);
});

test("a refresh token is accepted for both services", () => {
  for (const service of ["github", "atlassian"]) {
    assert.equal(parseConnectRequest({ service, grant: "refresh_token", refreshToken: "r1" }).refreshToken, "r1");
  }
});

test("anything that is not a plain request is refused", () => {
  rejects(() => parseConnectRequest(null), 400);
  rejects(() => parseConnectRequest([]), 400);
  rejects(() => parseConnectRequest({ service: "gitlab", grant: "refresh_token", refreshToken: "r" }), 400);
  rejects(() => parseConnectRequest({ service: "atlassian", grant: "password" }), 400);
  rejects(() => parseConnectRequest({ service: "atlassian", grant: "refresh_token", refreshToken: "a b" }), 400);
  rejects(() => parseConnectRequest({ service: "atlassian", grant: "authorization_code", code: "x".repeat(5000) }), 400);
});

test("the redirect address is the server's, whatever the editor sends", () => {
  const request = parseConnectRequest({ service: "atlassian", grant: "authorization_code", code: "c", redirectUri: "https://evil.example" });
  assert.equal(buildProviderRequest(request, ENV).body.redirect_uri, "https://api.example/cb");
});

test("the secrets go to the provider and nowhere else", () => {
  const atlassian = buildProviderRequest({ service: "atlassian", grant: "refresh_token", refreshToken: "r" }, ENV);
  assert.equal(atlassian.url, "https://auth.atlassian.com/oauth/token");
  assert.equal(atlassian.body.client_secret, "at-secret");
  const github = buildProviderRequest({ service: "github", grant: "refresh_token", refreshToken: "r" }, ENV);
  assert.equal(github.url, "https://github.com/login/oauth/access_token");
  assert.equal(github.body.grant_type, "refresh_token");
});

test("a service that is not set up answers 503 without saying which setting is missing", () => {
  assert.throws(
    () => buildProviderRequest({ service: "atlassian", grant: "refresh_token", refreshToken: "r" }, {}),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !/ATLASSIAN|SECRET/i.test(error.message),
  );
});

test("only tokens and their lifetime go back to the editor", () => {
  assert.deepEqual(readProviderTokens({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "x", id: 1 }),
    { accessToken: "a", refreshToken: "r", expiresIn: 3600 });
  assert.equal(readProviderTokens({ error: "invalid_grant" }), undefined);
  assert.equal(readProviderTokens(null), undefined);
});

test("the callback address carries a plain code and state, or nothing", () => {
  assert.equal(
    editorCallbackUrl(new URLSearchParams("code=abc123&state=0f8fad5b-d9cb-469f")),
    "picode://connect/callback?service=atlassian&state=0f8fad5b-d9cb-469f&code=abc123",
  );
  assert.equal(editorCallbackUrl(new URLSearchParams("code=abc")), undefined);
  assert.equal(editorCallbackUrl(new URLSearchParams("code=a%22%3E%3Cscript%3E&state=0f8fad5b-d9cb")), undefined);
  assert.equal(editorCallbackUrl(new URLSearchParams("code=abc&state=short")), undefined);
});
