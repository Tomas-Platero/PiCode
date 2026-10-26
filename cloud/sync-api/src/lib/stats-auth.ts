import { timingSafeEqual } from "node:crypto";

/**
 * Who may read /api/stats: only a caller holding STATS_TOKEN, the secret the website's server sends.
 * With no token configured nobody may, so a missing variable closes the route instead of opening it.
 */
export function isStatsCaller(
  authorization: string | null,
  token: string | undefined = process.env.STATS_TOKEN,
): boolean {
  if (!token || !authorization) {
    return false;
  }
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  if (!match) {
    return false;
  }
  const given = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
