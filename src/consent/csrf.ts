// The same-origin layer of the consent POST's CSRF defence (the other layer is
// the OAuth library's single-use, cookie-bound consent handle). Kept apart from
// authorize.ts so it is unit-testable in Node without the provider's
// `cloudflare:workers` import.

/**
 * True when the request proves it came from this origin: `Origin` equal to
 * this origin, or `Sec-Fetch-Site: same-origin`. Browsers set both on a form
 * POST and script cannot forge either. A request carrying neither is refused.
 */
export function hasSameOriginProof(request: Request): boolean {
  const origin = request.headers.get("origin");
  const originMatches = origin !== null && origin === new URL(request.url).origin;
  return originMatches || request.headers.get("sec-fetch-site") === "same-origin";
}
