import { DecodedIdToken, getAuth } from "firebase-admin/auth";
import { NextRequest, NextResponse } from "next/server";
import { firebaseAdmin } from "./firebase-admin";
import { SyncRequestContext } from "./contract";
import { HttpError } from "./http";
import { readUserPlan } from "./quota";

/**
 * The sync client authenticates every request with the Firebase ID token of
 * the configured authentication provider:
 *
 *   Authorization: Bearer <firebaseIdToken>
 *   X-Account-Type: <authenticationProviderId>
 *
 * A missing/invalid token answers 401 (the client clears its token and
 * re-authenticates). A valid token from a disallowed client answers 403.
 * Firebase ID tokens are verified with full revocation checking.
 */

const ALLOWED_CLIENT_NAMES = new Set(
  (process.env.PICODE_ALLOWED_CLIENTS ?? "picode")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function extractBearerToken(request: NextRequest): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return undefined;
  }
  const [scheme, value] = authorization.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !value) {
    return undefined;
  }
  return value.trim() || undefined;
}

function unauthorized(reason: string): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized", message: reason },
    { status: 401 },
  );
}

/**
 * Pro-only gate. Throws 402 for non-Pro accounts; 402 is intentionally
 * outside the sync client's known error map — the editor gates before
 * reaching the API, and this server-side check is the authoritative backstop.
 */
export function requirePro(context: SyncRequestContext): void {
  if (context.plan !== "pro") {
    throw new HttpError(
      402,
      "PaymentRequired",
      "PiCode Sync requires a Pro account. Upgrade at https://www.getpicode.app",
    );
  }
}

/**
 * Verify the request and return its sync context, or throw the HttpError to
 * map (401 for missing/invalid credentials, 403 for a disallowed client).
 */
export async function authenticateRequest(
  request: NextRequest,
): Promise<SyncRequestContext> {
  const token = extractBearerToken(request);
  if (!token) {
    throw new HttpError(401, "Unauthorized", "Missing bearer token.");
  }

  let decoded: DecodedIdToken;
  try {
    decoded = await getAuth(firebaseAdmin()).verifyIdToken(token, true);
  } catch {
    throw new HttpError(401, "Unauthorized", "Invalid or expired token.");
  }

  const accountType = request.headers.get("x-account-type")?.trim();
  if (!accountType) {
    throw new HttpError(401, "Unauthorized", "Missing X-Account-Type header.");
  }

  const clientName = request.headers.get("x-client-name")?.trim() ?? "";
  if (!clientName || !ALLOWED_CLIENT_NAMES.has(clientName)) {
    throw new HttpError(403, "Forbidden", `Client not allowed: ${clientName}`);
  }

  // One extra Firestore read per request (plan); acceptable, no caching.
  const plan = await readUserPlan(decoded.uid);

  return {
    uid: decoded.uid,
    email: typeof decoded.email === "string" && decoded.email ? decoded.email : undefined,
    accountType,
    clientName,
    clientVersion: request.headers.get("x-client-version") ?? "0",
    clientCommit: request.headers.get("x-client-commit") ?? undefined,
    machineSessionId: request.headers.get("x-machine-session-id") ?? undefined,
    userSessionId: request.headers.get("x-user-session-id") ?? undefined,
    executionId: request.headers.get("x-execution-id") ?? undefined,
    plan,
  };
}
