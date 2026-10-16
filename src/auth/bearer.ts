// The secondary credential on /mcp: a static bearer (Worker secret
// DOILY_BEARER), for curl checks and scripts that cannot do OAuth.
//
// Both sides are hashed with SHA-256 before the constant-time compare, so the
// comparison always runs over 32 bytes and neither the content nor the length
// of the configured secret leaks through timing. A request whose bearer does
// not match is NOT rejected here: it falls through to the OAuth provider, which
// owns the 401 and its WWW-Authenticate challenge (and accepts its own tokens).

import { sha256, timingSafeEqual } from "./primitives.ts";

/** The token out of `Authorization: Bearer <token>`, or null. Scheme is case-insensitive. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)[ ]*$/iu.exec(header);
  return match?.[1] ?? null;
}

/**
 * True when the request carries exactly the configured static bearer. An unset
 * or empty secret never matches anything: misconfiguration is not a bypass.
 */
export async function hasStaticBearer(
  request: Request,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected) return false;
  const presented = bearerToken(request);
  if (presented === null) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return timingSafeEqual(a, b);
}
