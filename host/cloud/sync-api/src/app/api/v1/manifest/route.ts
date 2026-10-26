import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { readOrCreateManifest } from "@/lib/store";
import {
  errorResponse,
  etagHeader,
  jsonResponse,
  normalizeIfHeader,
  operationIdHeaders,
} from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/manifest
 * Returns the user's manifest (`{ latest, session, ref }`) with `ETag` set to
 * the manifest ref. When `If-None-Match` matches the current ref, answers 304
 * with the same ETag and no body.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const manifest = await readOrCreateManifest(context.uid);
    const ifNoneMatch = normalizeIfHeader(request.headers.get("if-none-match"));
    if (ifNoneMatch && ifNoneMatch === manifest.ref) {
      return new NextResponse(null, {
        status: 304,
        headers: etagHeader(manifest.ref),
      });
    }
    return jsonResponse(manifest, 200, etagHeader(manifest.ref));
  } catch (error) {
    return errorResponse(error);
  }
}

export function HEAD(): NextResponse {
  return new NextResponse(null, { status: 405, headers: operationIdHeaders() });
}
