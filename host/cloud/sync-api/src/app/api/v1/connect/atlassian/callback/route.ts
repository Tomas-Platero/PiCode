import { NextRequest, NextResponse } from "next/server";
import { editorCallbackUrl, isCallbackCode, isCallbackState } from "@/lib/connect";
import { AttemptRecord, isAttemptState } from "@/lib/connect-attempts";
import { connectAttempts, connectWithCode } from "@/lib/connect-store";
import { textResponse } from "@/lib/http";
import { readUserPlan } from "@/lib/quota";

export const dynamic = "force-dynamic";

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // No scripts, no outside loads: the only thing the page can do is post its own form back here.
  // It cannot be framed, so the confirmation cannot be clicked without being seen.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

const STYLE = "body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}main{max-width:26rem;padding:2rem;text-align:center}a,button{display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;border:0;border-radius:.5rem;background:#4f8cff;color:#fff;font:inherit;text-decoration:none;cursor:pointer}small{display:block;margin-top:1.5rem;color:#aaa}";

function page(title: string, body: string, head = ""): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${head}<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return textResponse(html, 200, PAGE_HEADERS);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const notConnected = (): NextResponse =>
  page("Jira was not connected", "<h1>Jira was not connected</h1><p>Go back to PiCode and try again.</p>");

const notPro = (): NextResponse =>
  page("Jira was not connected", "<h1>Jira was not connected</h1><p>Connecting Jira needs a PiCode Pro plan.</p>");

const connected = (): NextResponse =>
  page("Jira is connected", "<h1>Jira is connected</h1><p>You can close this page and go back to PiCode.</p>");

function confirmation(attempt: AttemptRecord, state: string, code: string): NextResponse {
  return page(
    "Connect Jira",
    `<h1>Connect Jira to PiCode?</h1><p>Jira will be connected to <strong>${escapeHtml(attempt.accountLabel)}</strong>.</p>`
    + `<form method="post"><input type="hidden" name="state" value="${escapeHtml(state)}"><input type="hidden" name="code" value="${escapeHtml(code)}"><button type="submit">Connect</button></form>`
    + "<small>Only continue if you started this in PiCode and you recognise this account. If not, close this page: whoever holds it would see your Jira.</small>",
  );
}

/** How an attempt stands when there is nothing left to confirm. */
function outcome(attempt: AttemptRecord | undefined): NextResponse {
  switch (attempt?.status) {
    case "connected":
      return connected();
    case "trading":
      return page("Connecting Jira", "<h1>Connecting Jira</h1><p>Go back to PiCode: it will show when this is done.</p>");
    case "notPro":
      return notPro();
    default:
      return notConnected();
  }
}

/**
 * GET /api/v1/connect/atlassian/callback
 * Where Atlassian sends the browser after the person agrees. With an attempt open on this server
 * it asks to confirm the account (`POST` below). Without one, the editor is from before attempts:
 * it gets the code and the `state` through `picode://` and checks the state is its own.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const query = request.nextUrl.searchParams;
  const state = query.get("state");
  if (isCallbackState(state) && isAttemptState(state)) {
    // Never the page below, even when the attempt is gone: this code must not leave through a link.
    try {
      const attempt = await connectAttempts.find(state);
      const code = query.get("code");
      if (attempt?.status === "pending" && (query.has("error") || !isCallbackCode(code))) {
        // The person said no on Atlassian's page: the editor can stop waiting.
        await connectAttempts.finish(state, "failed");
        return notConnected();
      }
      return attempt?.status === "pending" && isCallbackCode(code) ? confirmation(attempt, state, code) : outcome(attempt);
    } catch {
      return notConnected();
    }
  }
  const target = editorCallbackUrl(query);
  if (!target) {
    return notConnected();
  }
  // `target` holds only token characters and percent-escapes, so it is safe inside an attribute.
  return page(
    "Back to PiCode",
    `<h1>Jira is almost connected</h1><p>Return to PiCode to finish.</p><a href="${target}">Open PiCode</a>`,
    `<meta http-equiv="refresh" content="0;url=${target}">`,
  );
}

/**
 * POST /api/v1/connect/atlassian/callback
 * The person confirmed the account: trade the code for that account's connection. The plan is
 * read here, not trusted from when the attempt was opened.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData().catch(() => undefined);
  const state = form?.get("state");
  const code = form?.get("code");
  if (!isCallbackState(state) || !isAttemptState(state) || !isCallbackCode(code)) {
    return notConnected();
  }
  try {
    const { won, record } = await connectAttempts.claim(state);
    if (!won || !record) {
      return outcome(record);
    }
    if ((await readUserPlan(record.uid)) !== "pro") {
      await connectAttempts.finish(state, "notPro");
      return notPro();
    }
    await connectWithCode(record.uid, { service: "atlassian", grant: "authorization_code", code });
  } catch {
    await connectAttempts.finish(state, "failed").catch(() => undefined);
    return notConnected();
  }
  // Connected already: failing to note it must not tell the person otherwise.
  await connectAttempts.finish(state, "connected").catch(() => undefined);
  return connected();
}
