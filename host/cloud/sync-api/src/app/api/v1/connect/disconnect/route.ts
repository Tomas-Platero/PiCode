import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { deleteConnection } from "@/lib/connect-store";
import { HttpError } from "@/lib/errors";
import { errorResponse, jsonResponse, operationIdHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Called from the editor's renderer, so CORS applies (same reasoning as `/api/v1/account`). */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-name, x-client-version, x-account-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * POST /api/v1/connect/disconnect
 * Forgets one connection of the signed-in account. Not Pro-gated: anyone may take their
 * credentials off this server, whatever their plan.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    const body = (await request.json().catch(() => undefined)) as { service?: unknown } | undefined;
    if (body?.service !== "github" && body?.service !== "atlassian") {
      throw new HttpError(400, "BadRequest", "Unknown service.");
    }
    await deleteConnection(context.uid, body.service);
    return jsonResponse({ connected: false }, 200, CORS);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...CORS, ...operationIdHeaders() } });
}
