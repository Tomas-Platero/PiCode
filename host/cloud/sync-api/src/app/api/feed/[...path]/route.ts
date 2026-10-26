import { NextRequest, NextResponse } from "next/server";
import { feedUrl, parseFeedPath, sampleOf } from "@/lib/usage";
import { recordCheck } from "@/lib/usage-store";

export const dynamic = "force-dynamic";

/** Counting must never hold an update check up: past this, the editor gets its answer anyway. */
const RECORD_BUDGET_MS = 1500;

/**
 * GET /api/feed/<branch>/updates/<quality>/<platform>/<arch>[/<target>]/latest.json
 *
 * The editor's update check (its `updateUrl` points here). Answers with a redirect to the same
 * document on raw.githubusercontent.com, which stays the only source of the feed, and counts the
 * check on the way (see `lib/usage.ts` for what is and is not counted). A failed count is logged
 * and ignored: updates keep working whatever happens to Firestore.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } },
): Promise<NextResponse> {
  const feed = parseFeedPath(params.path);
  if (!feed) {
    return new NextResponse(null, { status: 404 });
  }

  const recorded = recordCheck(sampleOf(feed, request.headers)).catch((error) => {
    console.error("[picode-usage] could not record an update check:", error);
  });
  await Promise.race([recorded, new Promise((resolve) => setTimeout(resolve, RECORD_BUDGET_MS))]);

  return NextResponse.redirect(feedUrl(feed), {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  });
}
