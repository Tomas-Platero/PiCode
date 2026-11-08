import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { isRateLimited, parseProxyRequest, proxyHeaders, usableEtag } from "@/lib/connect-proxy";
import type { ProxyRequest } from "@/lib/connect-proxy";
import { accessTokenFor, deleteAllConnections } from "@/lib/connect-store";
import { HttpError } from "@/lib/errors";
import { errorResponse, jsonResponse, operationIdHeaders } from "@/lib/http";
import { forgetCachedPlan, readUserPlan } from "@/lib/quota";

export const dynamic = "force-dynamic";

/** Waiting for another renewal, renewing, and the call itself. */
export const maxDuration = 60;

/** Called from the editor's renderer, so CORS applies (same reasoning as `/api/v1/account`). */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-name, x-client-version, x-account-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function call(request: ProxyRequest, accessToken: string): Promise<Response> {
  try {
    return await fetch(request.url, {
      method: request.method,
      headers: proxyHeaders(request, accessToken),
      ...(request.body === undefined ? {} : { body: request.body }),
      // A redirect must not carry the token anywhere: it is passed back as an answer, not followed.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(502, "BadGateway", "The service could not be reached.");
  }
}

/**
 * POST /api/v1/connect/proxy
 * Makes one call to GitHub or Jira for the signed-in account, with its stored connection. This is
 * what makes the issues a Pro feature for real: the editor holds no token, so without this route
 * it has no way to reach them, and the plan is read from the server's own records on every call.
 * Only the calls in `connect-proxy.ts` exist. The answer goes back as it came, minus any header
 * but the etag.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    if (context.plan !== "pro") {
      // The plan is cached for a minute per server: someone who just upgraded must not lose what
      // they just connected, so this is asked again before anything is deleted.
      forgetCachedPlan(context.uid);
      const plan = await readUserPlan(context.uid);
      if (plan !== "pro") {
        // A plan that ended leaves no credentials behind.
        await deleteAllConnections(context.uid).catch(() => undefined);
        requirePro({ ...context, plan });
      }
    }
    const proxied = parseProxyRequest(await request.json().catch(() => undefined));

    let token = await accessTokenFor(context.uid, proxied.service);
    if (!token) {
      return jsonResponse({ status: 401, connected: false }, 200, CORS);
    }
    let response = await call(proxied, token);
    if (response.status === 401) {
      // The token died early (revoked, or the service says so): one renewal and one more try.
      // A second refusal is the service's answer: Atlassian also says 401 for a missing permission.
      const renewed = await accessTokenFor(context.uid, proxied.service, token);
      if (!renewed) {
        return jsonResponse({ status: 401, connected: false }, 200, CORS);
      }
      token = renewed;
      response = await call(proxied, token);
    }
    const text = response.status === 304 ? "" : await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return jsonResponse(
      {
        status: response.status,
        connected: true,
        json,
        etag: usableEtag(response.headers.get("etag")),
        rateLimited: isRateLimited(response.status, response.headers.get("x-ratelimit-remaining")),
      },
      200,
      CORS,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...CORS, ...operationIdHeaders() } });
}
