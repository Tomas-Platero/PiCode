import { HttpError } from "./errors";

/**
 * Connecting the editor to GitHub and Jira: the part that needs a secret.
 *
 * Atlassian will not trade a code for tokens (or renew them) without a client secret, and a secret
 * inside an installed editor can be read by anyone. So the editor asks this server, which holds the
 * secret in its environment. The tokens stay here too (`connect-store.ts`, sealed): they never go
 * back to the editor, which asks this server to make each call. That is what keeps the issues Pro.
 *
 * Pure (no Next.js, no network): the route does the call, this file decides what to ask and what
 * to tell the editor, so `node --test` can check it.
 */

export type ConnectService = "github" | "atlassian";
export type ConnectGrant = "authorization_code" | "refresh_token";

export interface ConnectRequest {
  readonly service: ConnectService;
  readonly grant: ConnectGrant;
  readonly code?: string;
  readonly refreshToken?: string;
}

export interface ProviderRequest {
  readonly url: string;
  readonly body: Record<string, string>;
}

export interface ConnectTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}

/** Codes and tokens are opaque and short-lived; this only rules out anything that is not a plain token. */
const OPAQUE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

export function parseConnectRequest(raw: unknown): ConnectRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "BadRequest", "Expected a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  const { service, grant, code } = body;
  if (service !== "github" && service !== "atlassian") {
    throw new HttpError(400, "BadRequest", "Unknown service.");
  }
  // Renewing is this server's own business (`connect-store.ts`): the editor has no token to renew.
  if (grant !== "authorization_code") {
    throw new HttpError(400, "BadRequest", "Unknown grant.");
  }
  // GitHub's sign-in comes through the one-time-code route; only Atlassian's code comes here.
  if (service !== "atlassian" || typeof code !== "string" || !OPAQUE.test(code)) {
    throw new HttpError(400, "BadRequest", "A code is only accepted for Atlassian.");
  }
  return { service, grant, code };
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    // Not the person's doing and not fixable by them: say so, and say nothing about which variable.
    throw new HttpError(503, "NotConfigured", "This connection is not available yet.");
  }
  return value;
}

/** What to ask the provider. The redirect address comes from the server, never from the editor. */
export function buildProviderRequest(request: ConnectRequest, env: Env): ProviderRequest {
  if (request.service === "github") {
    return {
      url: "https://github.com/login/oauth/access_token",
      body: {
        client_id: required(env, "GITHUB_CLIENT_ID"),
        client_secret: required(env, "GITHUB_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: request.refreshToken ?? "",
      },
    };
  }
  const base = {
    client_id: required(env, "ATLASSIAN_CLIENT_ID"),
    client_secret: required(env, "ATLASSIAN_CLIENT_SECRET"),
    grant_type: request.grant,
  };
  return {
    url: "https://auth.atlassian.com/oauth/token",
    body: request.grant === "authorization_code"
      ? { ...base, code: request.code ?? "", redirect_uri: required(env, "ATLASSIAN_REDIRECT_URI") }
      : { ...base, refresh_token: request.refreshToken ?? "" },
  };
}

/**
 * The provider's answer, reduced to the three things the editor keeps. Anything else it said
 * (scopes, ids, errors with details) stays here.
 */
export function readProviderTokens(json: unknown): ConnectTokens | undefined {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const data = json as Record<string, unknown>;
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    return undefined;
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : undefined,
  };
}

/**
 * Whether the provider says this refresh token is no good, which is the only thing that ends a
 * connection: Atlassian answers `invalid_grant`, GitHub `bad_refresh_token`. Anything else (a rate
 * limit, an error page, our own wrong secret) says nothing about the person's account.
 */
export function isRefreshRefused(json: unknown): boolean {
  const error = typeof json === "object" && json !== null ? (json as Record<string, unknown>).error : undefined;
  return error === "invalid_grant" || error === "bad_refresh_token";
}

/**
 * GitHub's one-time-code sign-in, asked through this server. GitHub's `login` pages do not allow
 * calls from the editor's window (no cross-origin permission), so the editor cannot ask them
 * itself; this server asks and passes the answer back. The client id is the server's own.
 */
export type GithubDeviceRequest =
  | { readonly action: "start" }
  | { readonly action: "poll"; readonly deviceCode: string };

export function parseGithubDeviceRequest(raw: unknown): GithubDeviceRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "BadRequest", "Expected a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  if (body.action === "start") {
    return { action: "start" };
  }
  if (body.action === "poll" && typeof body.deviceCode === "string" && OPAQUE.test(body.deviceCode)) {
    return { action: "poll", deviceCode: body.deviceCode };
  }
  throw new HttpError(400, "BadRequest", "Unknown action.");
}

export function buildGithubDeviceRequest(request: GithubDeviceRequest, env: Env): ProviderRequest {
  const clientId = required(env, "GITHUB_CLIENT_ID");
  if (request.action === "start") {
    return { url: "https://github.com/login/device/code", body: { client_id: clientId } };
  }
  return {
    url: "https://github.com/login/oauth/access_token",
    body: { client_id: clientId, device_code: request.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
  };
}

/**
 * GitHub's answer, reduced to what the editor reads (same names GitHub uses). Tokens are never
 * part of it: the route stores them and only says it is connected. `undefined` means the answer
 * was not one GitHub gives.
 */
export function readGithubDeviceAnswer(action: GithubDeviceRequest["action"], json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const data = json as Record<string, unknown>;
  if (action === "start") {
    if (typeof data.device_code !== "string" || typeof data.user_code !== "string" || typeof data.verification_uri !== "string") {
      return undefined;
    }
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      interval: typeof data.interval === "number" ? data.interval : undefined,
      expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
    };
  }
  if (typeof data.error === "string" && /^[a-z_]{1,64}$/.test(data.error)) {
    return { error: data.error, interval: typeof data.interval === "number" ? data.interval : undefined };
  }
  return undefined;
}

export function isCallbackCode(code: unknown): code is string {
  return typeof code === "string" && OPAQUE.test(code);
}

export function isCallbackState(state: unknown): state is string {
  return typeof state === "string" && /^[A-Za-z0-9-]{8,128}$/.test(state);
}

/**
 * Where the browser goes after Atlassian when the editor is from before connection attempts: back
 * into it, carrying the code and the `state` it must recognise. Nothing but plain token characters
 * is passed on, so the address can not be bent into something else.
 */
export function editorCallbackUrl(query: URLSearchParams): string | undefined {
  const code = query.get("code");
  const state = query.get("state");
  if (!isCallbackCode(code) || !isCallbackState(state)) {
    return undefined;
  }
  return `picode://connect/callback?service=atlassian&state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;
}
