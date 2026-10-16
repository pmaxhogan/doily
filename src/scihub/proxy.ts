/**
 * Through-proxy mode for every Sci-Hub request (mirror discovery, health
 * checks, article pages, PDFs).
 *
 * Cloudflare egress IPs are often challenged by Sci-Hub mirrors, so when
 * `SCIHUB_PROXY_URL` is set the Worker never contacts a mirror directly. It
 * asks a small bearer-gated fetch proxy (planned as a Custom App on the NAS) to
 * do the request from a residential IP instead.
 *
 * Contract, so the proxy can be built against it later:
 *
 * Request (Worker -> proxy):
 *
 *     POST <SCIHUB_PROXY_URL>/fetch
 *     Authorization: Bearer <SCIHUB_PROXY_TOKEN>
 *     Content-Type: application/json
 *
 *     { "url": "https://sci-hub.ru/10.1038/nature12373",
 *       "method": "GET",
 *       "headers": { "User-Agent": "...", "Accept": "text/html,...", "Referer": "..." } }
 *
 *   - `url` is always an absolute http(s) URL. The proxy may restrict it to an
 *     allowlist (sci-hub.* hosts, sci.bban.top, the mirror-list pages).
 *   - `method` is "GET" (the only method the resolver uses today).
 *   - `headers` are forwarded verbatim to the upstream.
 *
 * Response (proxy -> Worker):
 *
 *   - The proxy follows redirects and returns the FINAL upstream response:
 *     its HTTP status as the proxy response status, its body verbatim (raw
 *     bytes, not base64, streamed if possible), and its Content-Type.
 *   - It MUST set `X-Upstream-Status: <upstream status code>` on every response
 *     that carries an upstream result, including upstream 4xx/5xx.
 *   - A response WITHOUT `X-Upstream-Status` is a proxy-level failure (bad or
 *     missing token -> 401, upstream unreachable or DNS failure -> 502,
 *     upstream timeout -> 504, disallowed host -> 403). The resolver maps it to
 *     outcome "error" (or "timeout" for 504) instead of treating the status as
 *     the mirror's answer, so a wrong token never looks like "not_found".
 *   - The proxy should apply its own upstream timeout no longer than 30 s; the
 *     Worker aborts its side after the per-request budget anyway.
 */

/** Header the proxy sets to mark a response as carrying an upstream result. */
export const UPSTREAM_STATUS_HEADER = "x-upstream-status";

export interface ProxyConfig {
  url: string;
  token: string;
}

export interface ProxyFetchBody {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Proxy settings from env, or null when direct mode applies. */
export function proxyConfig(env: {
  SCIHUB_PROXY_URL?: string;
  SCIHUB_PROXY_TOKEN?: string;
}): ProxyConfig | null {
  const url = env.SCIHUB_PROXY_URL?.trim();
  if (!url) return null;
  return { url: url.replace(/\/+$/, ""), token: env.SCIHUB_PROXY_TOKEN?.trim() ?? "" };
}

/** Build the `fetch` arguments for one upstream request routed through the proxy. */
export function buildProxyRequest(
  cfg: ProxyConfig,
  body: ProxyFetchBody,
): { url: string; init: RequestInit } {
  return {
    url: `${cfg.url}/fetch`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

/**
 * Read the upstream status out of a proxy response. Returns null when the
 * response is a proxy-level failure (no `X-Upstream-Status` header).
 */
export function upstreamStatus(res: Response): number | null {
  const raw = res.headers.get(UPSTREAM_STATUS_HEADER);
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : null;
}
