import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { errorResponse, jsonResponse, operationIdHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/download/latest — not used in v1; answered with a 404 JSON
 * body. Still authenticated and Pro-gated: every sync route enforces the
 * same account requirements, even this unused stub.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    return jsonResponse(
      { error: "NotFound", message: "Download is not supported in v1." },
      404,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export function HEAD(): NextResponse {
  return new NextResponse(null, { status: 405, headers: operationIdHeaders() });
}
