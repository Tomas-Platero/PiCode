import { NextResponse } from "next/server";

/**
 * Liveness probe. Does NOT touch Firebase: it must succeed even before the
 * service account is configured, so deploys can be validated early.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "picode-sync-api",
    version: "0.1.0",
  });
}
