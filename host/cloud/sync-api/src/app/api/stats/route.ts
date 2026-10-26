import { NextRequest, NextResponse } from "next/server";
import { readDownloads } from "@/lib/downloads";
import { isStatsCaller } from "@/lib/stats-auth";
import { readStats } from "@/lib/usage-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/stats
 * The usage summary behind the website's private dashboard: active installs over the last 30 days,
 * the OS / channel / version mix, and the downloads of each channel's current release.
 *
 * Private: it answers only the website's server, which sends `Authorization: Bearer <STATS_TOKEN>`.
 * Everyone else gets a 404, so the route does not even look like it exists.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isStatsCaller(request.headers.get("authorization"))) {
    return new NextResponse(null, { status: 404 });
  }
  try {
    const [usage, downloads] = await Promise.all([readStats(), readDownloads()]);
    return NextResponse.json({ ...usage, downloads }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[picode-usage] could not build the stats:", error);
    return NextResponse.json(
      { error: "InternalError", message: "Stats are unavailable right now." },
      { status: 503 },
    );
  }
}
