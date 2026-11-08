import type { ConnectService } from "./connect";
import { HttpError } from "./errors";

/**
 * The calls to GitHub and Jira the editor may ask this server to make with the person's stored
 * connection, and nothing else. The list is the exact set the issues panels use, so a stolen
 * session cannot turn this route into a general door to someone's GitHub or Jira account.
 *
 * Pure (no Next.js, no network), so `node --test` can check it.
 */

export type ProxyMethod = "GET" | "POST" | "PUT" | "PATCH";

export interface ProxyRequest {
  readonly service: ConnectService;
  readonly method: ProxyMethod;
  /** Always on the service's own address: built here from the fixed base, never taken from the editor. */
  readonly url: string;
  readonly body?: string;
  readonly ifNoneMatch?: string;
}

const BASE: Record<ConnectService, string> = {
  github: "https://api.github.com",
  atlassian: "https://api.atlassian.com",
};

const NAME = "[A-Za-z0-9_.-]{1,100}";
const REPO = `/repos/${NAME}/${NAME}`;
const CLOUD = "/ex/jira/[0-9a-fA-F-]{36}";
const JIRA = `${CLOUD}/rest/api/3`;
const AGILE = `${CLOUD}/rest/agile/1.0`;
const PROJECT = "[A-Z][A-Z0-9_]{0,63}";
const ISSUE = `${PROJECT}-\\d{1,12}`;

const ALLOWED: Record<ConnectService, ReadonlyArray<{ readonly method: ProxyMethod; readonly path: RegExp }>> = {
  github: [
    { method: "GET", path: /^\/user\/installations$/ },
    { method: "GET", path: /^\/user\/installations\/\d{1,20}\/repositories$/ },
    { method: "GET", path: new RegExp(`^${REPO}/issues$`) },
    { method: "GET", path: new RegExp(`^${REPO}/labels$`) },
    { method: "GET", path: new RegExp(`^${REPO}/assignees$`) },
    { method: "PATCH", path: new RegExp(`^${REPO}/issues/\\d{1,12}$`) },
  ],
  atlassian: [
    { method: "GET", path: /^\/oauth\/token\/accessible-resources$/ },
    { method: "GET", path: new RegExp(`^${JIRA}/project/search$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/project/${PROJECT}$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/project/${PROJECT}/statuses$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/search/jql$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/priority$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/issue/${ISSUE}/editmeta$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/issue/${ISSUE}/transitions$`) },
    { method: "POST", path: new RegExp(`^${JIRA}/issue/${ISSUE}/transitions$`) },
    { method: "PUT", path: new RegExp(`^${JIRA}/issue/${ISSUE}$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/user/assignable/search$`) },
    { method: "GET", path: new RegExp(`^${JIRA}/user/search$`) },
    { method: "GET", path: new RegExp(`^${AGILE}/board$`) },
    { method: "GET", path: new RegExp(`^${AGILE}/board/\\d{1,12}/configuration$`) },
  ],
};

/** What an encoded query may hold: the output of `encodeURIComponent`, joined with `&` and `=`. */
const QUERY = /^[A-Za-z0-9._~%+=&,()*!'-]{0,4096}$/;

/** An edit of an issue is small; a larger body is not one of ours. */
const MAX_BODY_BYTES = 256 * 1024;

const ETAG = /^(W\/)?"[\x21\x23-\x7e]{1,256}"$/;

/** Only an etag that can come back: the editor repeats it on its next read, where the others are refused. */
export function usableEtag(etag: string | null): string | undefined {
  return etag !== null && ETAG.test(etag) ? etag : undefined;
}

function refuse(message: string): HttpError {
  return new HttpError(400, "BadRequest", message);
}

export function parseProxyRequest(raw: unknown): ProxyRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw refuse("Expected a JSON object.");
  }
  const { service, method, path, json, ifNoneMatch } = raw as Record<string, unknown>;
  if (service !== "github" && service !== "atlassian") {
    throw refuse("Unknown service.");
  }
  if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "PATCH") {
    throw refuse("Unknown method.");
  }
  if (typeof path !== "string" || path.length > 8192) {
    throw refuse("Unknown path.");
  }
  const question = path.indexOf("?");
  const pathname = question === -1 ? path : path.slice(0, question);
  const query = question === -1 ? "" : path.slice(question + 1);
  // The patterns already rule these out; this says so plainly, for whoever reads it next. Dot
  // segments are caught below, where the parsed address must equal what was asked.
  if (pathname.includes("%") || pathname.includes("\\") || pathname.includes("//") || pathname.includes("@")) {
    throw refuse("Unknown path.");
  }
  if (!QUERY.test(query)) {
    throw refuse("Unknown path.");
  }
  if (!ALLOWED[service].some((rule) => rule.method === method && rule.path.test(pathname))) {
    throw new HttpError(403, "Forbidden", "That call is not available.");
  }
  const base = BASE[service];
  const url = new URL(`${base}${path}`);
  if (url.origin !== base || url.pathname !== pathname || url.username || url.password) {
    throw refuse("Unknown path.");
  }

  let body: string | undefined;
  if (method === "GET") {
    if (json !== undefined) {
      throw refuse("A read carries no body.");
    }
  } else {
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw refuse("A change needs a body.");
    }
    body = JSON.stringify(json);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new HttpError(413, "PayloadTooLarge", "That change is too large.");
    }
  }
  if (ifNoneMatch !== undefined && (typeof ifNoneMatch !== "string" || !ETAG.test(ifNoneMatch))) {
    throw refuse("Unknown etag.");
  }
  return {
    service,
    method,
    url: url.toString(),
    ...(body === undefined ? {} : { body }),
    ...(typeof ifNoneMatch === "string" ? { ifNoneMatch } : {}),
  };
}

/** The headers of a call: the token only ever travels to the fixed address above. */
export function proxyHeaders(request: ProxyRequest, accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "PiCode",
  };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (request.ifNoneMatch) {
    headers["If-None-Match"] = request.ifNoneMatch;
  }
  if (request.service === "github") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  return headers;
}

/** Whether the service asked to slow down. */
export function isRateLimited(status: number, remaining: string | null): boolean {
  return status === 429 || (status === 403 && remaining === "0");
}
