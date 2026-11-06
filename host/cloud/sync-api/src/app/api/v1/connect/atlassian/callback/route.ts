import { NextRequest, NextResponse } from "next/server";
import { editorCallbackUrl } from "@/lib/connect";
import { textResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // No scripts, no outside loads: the page is a link back to the editor and nothing else.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
};

function page(title: string, body: string, head = ""): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${head}<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}main{max-width:26rem;padding:2rem;text-align:center}a{display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;border-radius:.5rem;background:#4f8cff;color:#fff;text-decoration:none}</style></head><body><main>${body}</main></body></html>`;
  return textResponse(html, 200, PAGE_HEADERS);
}

/**
 * GET /api/v1/connect/atlassian/callback
 * Where Atlassian sends the browser after the person agrees. It hands the code and the `state`
 * to the editor through the `picode://` address; the editor checks the state is its own.
 */
export function GET(request: NextRequest): NextResponse {
  const target = editorCallbackUrl(request.nextUrl.searchParams);
  if (!target) {
    return page("Jira was not connected", "<h1>Jira was not connected</h1><p>Go back to PiCode and try again.</p>");
  }
  // `target` holds only token characters and percent-escapes, so it is safe inside an attribute.
  return page(
    "Back to PiCode",
    `<h1>Jira is almost connected</h1><p>Return to PiCode to finish.</p><a href="${target}">Open PiCode</a>`,
    `<meta http-equiv="refresh" content="0;url=${target}">`,
  );
}
