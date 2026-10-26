import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { NON_EXISTING_RESOURCE_REF } from "@/lib/contract";
import {
  errorResponse,
  etagHeader,
  normalizeIfHeader,
} from "@/lib/http";
import { assertResourceName, readLatestResource } from "@/lib/store";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { r: string };
}

/**
 * GET /api/v1/resource/:r/latest
 * Returns the latest ref's ISyncData JSON string with `ETag: "<ref>"`, or 304
 * when `If-None-Match` matches. A resource without data answers **204 No Content**
 * with `ETag: "0"` (the client's NON_EXISTING_RESOURCE_REF): the client's
 * `hasNoContent()` check treats 204 as "no remote data" — a 200 with an empty
 * body would be parsed as sync content and fail with IncompatibleRemoteContent.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    assertResourceName(params.r);
    const context = await authenticateRequest(request);
    requirePro(context);

    const data = await readLatestResource(context.uid, params.r);
    if (!data) {
      const ifNoneMatch = normalizeIfHeader(
        request.headers.get("if-none-match"),
      );
      if (ifNoneMatch === NON_EXISTING_RESOURCE_REF) {
        return new NextResponse(null, {
          status: 304,
          headers: etagHeader(NON_EXISTING_RESOURCE_REF),
        });
      }
      return new NextResponse(null, {
        status: 204,
        headers: etagHeader(NON_EXISTING_RESOURCE_REF),
      });
    }

    const ifNoneMatch = normalizeIfHeader(request.headers.get("if-none-match"));
    if (ifNoneMatch && ifNoneMatch === data.ref) {
      return new NextResponse(null, {
        status: 304,
        headers: etagHeader(data.ref),
      });
    }
    return new NextResponse(data.content, {
      status: 200,
      headers: etagHeader(data.ref),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
