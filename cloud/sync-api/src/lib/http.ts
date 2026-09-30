import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Response helpers shared by all contract routes. Every response carries an
 * `x-operation-id` header (UUID) for diagnostics, matching the sync client's
 * HEADER_OPERATION_ID.
 */

export interface ErrorBody {
  error: string;
  message: string;
}

/** Thrown by store helpers; caught and mapped by route handlers. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function operationIdHeaders(): Record<string, string> {
  return { "x-operation-id": randomUUID() };
}

/** Quote an ETag value as required for ETag headers. */
export function etagHeader(value: string): Record<string, string> {
  return { ETag: `"${value}"`, ...operationIdHeaders() };
}

/** Normalize If-None-Match / If-Match values: strip optional surrounding quotes. */
export function normalizeIfHeader(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  // HTTP validators arrive as `"<ref>"` or weak `W/"<ref>"` (intermediaries
  // weaken strong ETags when they compress responses). Strip the weak marker,
  // the quotes and any whitespace, leaving the bare ref the server minted —
  // Firestore document ids must not carry them.
  const stripped = value
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return stripped || undefined;
}

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...operationIdHeaders(), ...headers },
  });
}

export function emptyResponse(
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return new NextResponse(null, {
    status,
    headers: { ...operationIdHeaders(), ...headers },
  });
}

export function textResponse(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { ...operationIdHeaders(), ...headers },
  });
}

/** Map an HttpError (or unexpected error) to the contract's error responses. */
export function errorResponse(error: unknown): NextResponse {
  if (!(error instanceof HttpError)) {
    // Unexpected server errors MUST be logged with their stack — a silent 500
    // is undiagnosable from Vercel logs alone.
    console.error("[picode-sync] unhandled route error:", error);
    // TEMPORARY DEBUG (remove after the opaque-POST investigation): surface the
    // cause in the response so the E2E harness can read it without log access.
    if (process.env.PICODE_DEBUG_500 === "1") { // TEMPORARY DEBUG — revert after opaque-POST investigation
      return jsonResponse(
        {
          error: "InternalError",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        500,
      );
    }
  }
  if (error instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (error.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(error.retryAfterSeconds);
    }
    return jsonResponse(
      { error: error.code, message: error.message },
      error.status,
      headers,
    );
  }
  return jsonResponse(
    { error: "InternalError", message: "Unexpected server error." },
    500,
  );
}
