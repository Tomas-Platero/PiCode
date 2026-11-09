import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { parseConnectRequest } from "@/lib/connect";
import { connectWithCode } from "@/lib/connect-store";
import { errorResponse, jsonResponse, operationIdHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Called from the editor's renderer, so CORS applies (same reasoning as `/api/v1/account`). */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-name, x-client-version, x-account-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * POST /api/v1/connect/token
 * Trades a Jira code for the connection of the signed-in Pro account, for editors from before
 * `/api/v1/connect/atlassian`: they receive the code through `picode://`. The editor is only told
 * it worked.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const connect = parseConnectRequest(await request.json().catch(() => undefined));
    await connectWithCode(context.uid, connect);
    return jsonResponse({ connected: true }, 200, CORS);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...CORS, ...operationIdHeaders() } });
}
