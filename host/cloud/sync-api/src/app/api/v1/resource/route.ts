import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { deleteAllResources } from "@/lib/store";
import { emptyResponse, errorResponse, operationIdHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/resource
 * Clears all the user's data: every resource, every ref, and the manifest.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    await deleteAllResources(context.uid);
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
