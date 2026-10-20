import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import {
  MAX_BODY_BYTES,
  SyncDataPayload,
} from "@/lib/contract";
import {
  emptyResponse,
  errorResponse,
  etagHeader,
  jsonResponse,
  normalizeIfHeader,
  operationIdHeaders,
} from "@/lib/http";
import {
  assertResourceName,
  deleteResource,
  listResourceRefs,
  writeResource,
} from "@/lib/store";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { r: string };
}

/**
 * GET /api/v1/resource/:r
 * Lists the refs of one resource: `[{ url, created }, ...]` (oldest first).
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    assertResourceName(params.r);
    const context = await authenticateRequest(request);
    requirePro(context);
    const origin = request.nextUrl.origin;
    const buildUrl = (ref: string) =>
      `${origin}/api/v1/resource/${params.r}/${ref}`;
    const refs = await listResourceRefs(context.uid, params.r, buildUrl);
    return jsonResponse(refs, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/v1/resource/:r
 * Appends a new resource revision (ISyncData JSON string body). With
 * `If-Match`, a stale-but-existing ref answers 412 and an unknown ref answers
 * 409. Answers with `ETag: "<newRef>"` and an empty body.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    assertResourceName(params.r);
    const context = await authenticateRequest(request);
    requirePro(context);

    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return jsonResponse(
        { error: "TooLarge", message: "Serialized body exceeds the size limit." },
        413,
      );
    }

    // The body is OPAQUE to the server: synchronizers wrap their payload in an
    // ISyncData envelope client-side, but other store clients (e.g. the machines
    // service) post raw JSON. The server only stores and serves bytes.
    const payload: SyncDataPayload = { version: 1, content: body };

    const ifMatch = normalizeIfHeader(request.headers.get("if-match"));

    // The plan-based quota is enforced inside `writeResource`, in the same transaction that would
    // change the total — see the note there. Checking it here used to mean reading every stored
    // revision of the user before the transaction even opened, which was the bulk of the sync's
    // cost and grew with every sync. `context.plan` is already read for the Pro gate.
    const newRef = await writeResource(
      context.uid,
      params.r,
      payload,
      ifMatch,
      context.plan,
    );
    return emptyResponse(200, etagHeader(newRef));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/v1/resource/:r
 * Deletes the resource's refs and resets its manifest entry to "0".
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    assertResourceName(params.r);
    const context = await authenticateRequest(request);
    requirePro(context);
    await deleteResource(context.uid, params.r);
    return emptyResponse(200);
  } catch (error) {
    return errorResponse(error);
  }
}

export function HEAD(): NextResponse {
  return new NextResponse(null, {
    status: 405,
    headers: { "x-operation-id": randomUUID(), ...operationIdHeaders() },
  });
}
