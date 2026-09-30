import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { errorResponse, jsonResponse, operationIdHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * The editor calls this route from its renderer (a Chromium context), so CORS
 * applies: preflights must be answered and every response must carry
 * Access-Control-Allow-Origin. `*` is safe here — the route accepts no
 * credentials; auth is carried by the Bearer ID token itself, and the sync
 * routes remain enforceable server-side regardless of CORS.
 */
function corsHeaders(request: NextRequest): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-name, x-client-version, x-account-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}


/**
 * GET /api/v1/account
 * Account info for the authenticated user. Answers 200 for free users too —
 * this is what the editor calls to decide whether sync is available
 * (intentionally NOT Pro-gated).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    return jsonResponse(
      {
        uid: context.uid,
        email: context.email ?? null,
        plan: context.plan,
      },
      200,
      corsHeaders(request),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS(request: NextRequest): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(request), ...operationIdHeaders() },
  });
}

export function HEAD(): NextResponse {
  return new NextResponse(null, {
    status: 405,
    headers: operationIdHeaders(),
  });
}
