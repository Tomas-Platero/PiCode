import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { buildProviderRequest, parseConnectRequest, readProviderTokens } from "@/lib/connect";
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
 * POST /api/v1/connect/token
 * Trades a code (Atlassian) or renews a token (Atlassian, GitHub) for the signed-in Pro account.
 * The provider's secret lives in this server's environment; the tokens go back to the editor
 * and are not stored here.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const connect = parseConnectRequest(await request.json().catch(() => undefined));
    const provider = buildProviderRequest(connect, process.env);
    let response: Response;
    try {
      response = await fetch(provider.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PiCode" },
        body: JSON.stringify(provider.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, "BadGateway", "The service could not be reached.");
    }
    const tokens = readProviderTokens(await response.json().catch(() => undefined));
    if (!tokens) {
      // The provider refused (revoked, expired, wrong code). The editor treats 401 as "connect again".
      throw new HttpError(401, "Unauthorized", "The connection needs to be made again.");
    }
    return jsonResponse(tokens, 200, CORS);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...CORS, ...operationIdHeaders() } });
}
