import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { REF_PATTERN } from "@/lib/contract";
import {
  emptyResponse,
  errorResponse,
  jsonResponse,
  operationIdHeaders,
} from "@/lib/http";
import { deleteCollection } from "@/lib/store";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * DELETE /api/v1/collection/:id
 * Deletes one collection doc (idempotent). Answers 200 with an empty body.
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    if (!REF_PATTERN.test(params.id)) {
      return jsonResponse(
        { error: "BadRequest", message: "Invalid collection id." },
        400,
      );
    }
    const context = await authenticateRequest(request);
    requirePro(context);
    await deleteCollection(context.uid, params.id);
    return emptyResponse(200);
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET(): NextResponse {
  return new NextResponse(null, { status: 405, headers: operationIdHeaders() });
}

export function POST(): NextResponse {
  return new NextResponse(null, { status: 405, headers: operationIdHeaders() });
}
