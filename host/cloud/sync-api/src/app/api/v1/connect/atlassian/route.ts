import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { parseAttemptRequest } from "@/lib/connect-attempts";
import { connectAttempts } from "@/lib/connect-store";
import { errorResponse, jsonResponse, operationIdHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Called from the editor's renderer, so CORS applies (same reasoning as `/api/v1/account`). */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-name, x-client-version, x-account-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * POST /api/v1/connect/atlassian
 * `begin` opens a Jira connection attempt for the signed-in Pro account and returns the `state`
 * to send to Atlassian; `poll` says how that attempt is going and `cancel` closes it when the
 * editor stops waiting (`lib/connect-attempts.ts`).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const attempt = parseAttemptRequest(await request.json().catch(() => undefined));
    if (attempt.action === "begin") {
      return jsonResponse({ state: await connectAttempts.begin(context.uid, context.email, context.emailVerified) }, 200, CORS);
    }
    if (attempt.action === "cancel") {
      await connectAttempts.cancel(context.uid, attempt.state);
      return jsonResponse({ cancelled: true }, 200, CORS);
    }
    return jsonResponse({ status: await connectAttempts.poll(context.uid, attempt.state) }, 200, CORS);
  } catch (error) {
    // The editor has to be able to read a refusal: a 402 means "not Pro", not "try again".
    const response = errorResponse(error);
    for (const [name, value] of Object.entries(CORS)) {
      response.headers.set(name, value);
    }
    return response;
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...CORS, ...operationIdHeaders() } });
}
