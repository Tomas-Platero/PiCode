import { NextResponse } from "next/server";
import { readDownloads } from "@/lib/downloads";
import { readStats } from "@/lib/usage-store";

export const dynamic = "force-dynamic";

/** The numbers move once a day at most; an hour of CDN cache keeps this to a few reads an hour. */
const CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

/**
 * GET /api/stats
 * The public, anonymous usage summary the website shows: active installs over the last 30 days,
 * the OS / channel / version mix, and the downloads of each channel's current release. Open to
 * any origin; there is nothing personal in it.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const [usage, downloads] = await Promise.all([readStats(), readDownloads()]);
    return NextResponse.json(
      { ...usage, downloads },
      { headers: { "Cache-Control": CACHE, "Access-Control-Allow-Origin": "*" } },
    );
  } catch (error) {
    console.error("[picode-usage] could not build the stats:", error);
    return NextResponse.json(
      { error: "InternalError", message: "Stats are unavailable right now." },
      { status: 503, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
