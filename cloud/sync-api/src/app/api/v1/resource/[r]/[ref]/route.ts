import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { REF_PATTERN } from "@/lib/contract";
import {
  emptyResponse,
  errorResponse,
  etagHeader,
  jsonResponse,
  operationIdHeaders,
} from "@/lib/http";
import {
  assertResourceName,
  deleteResourceRef,
  readResourceRef,
} from "@/lib/store";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { r: string; ref: string };
}

/**
 * GET /api/v1/resource/:r/:ref
 * Returns that specific ref's ISyncData JSON string with `ETag: "<ref>"`.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    assertResourceName(params.r);
    if (!REF_PATTERN.test(params.ref)) {
      return jsonResponse(
        { error: "BadRequest", message: "Invalid ref." },
        400,
      );
    }
    const context = await authenticateRequest(request);
    requirePro(context);
    const data = await readResourceRef(context.uid, params.r, params.ref);
    if (!data) {
      return jsonResponse(
        { error: "NotFound", message: "Ref not found." },
        404,
      );
    }
    return new NextResponse(data.content, {
      status: 200,
      headers: etagHeader(data.ref),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/v1/resource/:r/:ref
 * Deletes one ref doc; updates the manifest when it was the latest.
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    assertResourceName(params.r);
    if (!REF_PATTERN.test(params.ref)) {
      return jsonResponse(
        { error: "BadRequest", message: "Invalid ref." },
        400,
      );
    }
    const context = await authenticateRequest(request);
    requirePro(context);
    await deleteResourceRef(context.uid, params.r, params.ref);
    return emptyResponse(200);
  } catch (error) {
    return errorResponse(error);
  }
}

export function HEAD(): NextResponse {
  return new NextResponse(null, {
    status: 405,
    headers: operationIdHeaders(),
  });
}
