import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requirePro } from "@/lib/auth";
import { buildGithubDeviceRequest, parseGithubDeviceRequest, readGithubDeviceAnswer, readProviderTokens } from "@/lib/connect";
import { saveConnection } from "@/lib/connect-store";
import { HttpError } from "@/lib/errors";
import { errorResponse, jsonResponse, operationIdHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Called from the editor's renderer, so CORS applies (same reasoning as `/api/v1/connect/token`). */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-name, x-client-version, x-account-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * POST /api/v1/connect/github
 * Asks GitHub for a one-time sign-in code (`start`) or whether it was entered (`poll`), for the
 * signed-in Pro account. GitHub's login pages do not accept calls from the editor's window, so
 * the editor asks here. When the code was entered the tokens stay here, sealed, and the editor is
 * only told it worked.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const context = await authenticateRequest(request);
    requirePro(context);
    const device = parseGithubDeviceRequest(await request.json().catch(() => undefined));
    const provider = buildGithubDeviceRequest(device, process.env);
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
    const json = await response.json().catch(() => undefined);
    const tokens = device.action === "poll" ? readProviderTokens(json) : undefined;
    if (tokens) {
      await saveConnection(context.uid, "github", tokens);
      return jsonResponse({ connected: true }, 200, CORS);
    }
    const answer = readGithubDeviceAnswer(device.action, json);
    if (!answer) {
      throw new HttpError(502, "BadGateway", "The service gave an answer that could not be used.");
    }
    return jsonResponse(answer, 200, CORS);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...CORS, ...operationIdHeaders() } });
}
