import type { ToolDeps } from "../tools/types.ts";
import { buildProxyRequest, proxyConfig, upstreamStatus } from "./proxy.ts";

/**
 * The single HTTP path for everything Sci-Hub: discovery pages, health checks,
 * article pages and PDFs. It owns the timeout, the byte cap and the
 * direct-vs-proxy switch, so no caller can forget any of them.
 */

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Safari/537.36";

export const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type FetchFailureKind = "timeout" | "error";

/** Thrown when no upstream status could be obtained at all. */
export class ScihubFetchError extends Error {
  constructor(
    public readonly kind: FetchFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ScihubFetchError";
  }
}

export interface ScihubFetchOptions {
  headers?: Record<string, string>;
  /** Whole-request budget: headers plus body. */
  timeoutMs: number;
  /** Stop reading once the body exceeds this; the result is flagged `overCap`. */
  maxBytes: number;
  /**
   * When the deadline hits after the status line arrived, return the bytes read
   * so far (flagged `partial`) instead of failing. Some mirrors send a page and
   * then keep the connection open; the page is still usable.
   */
  partialOnTimeout?: boolean;
}

export interface ScihubFetchResult {
  status: number;
  contentType: string;
  body: Uint8Array;
  overCap: boolean;
  partial: boolean;
}

/** Fetch one Sci-Hub URL directly or through the configured proxy. */
export async function scihubFetch(
  deps: Pick<ToolDeps, "env" | "fetch">,
  url: string,
  opts: ScihubFetchOptions,
): Promise<ScihubFetchResult> {
  const headers = { "User-Agent": BROWSER_USER_AGENT, ...opts.headers };
  const proxy = proxyConfig(deps.env);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ScihubFetchError("timeout", `timeout after ${opts.timeoutMs}ms`));
  }, opts.timeoutMs);

  try {
    let res: Response;
    try {
      if (proxy) {
        const req = buildProxyRequest(proxy, { url, method: "GET", headers });
        res = await deps.fetch(req.url, { ...req.init, signal: controller.signal });
      } else {
        res = await deps.fetch(url, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: controller.signal,
        });
      }
    } catch (err) {
      if (timedOut) throw new ScihubFetchError("timeout", `timeout after ${opts.timeoutMs}ms`);
      throw new ScihubFetchError("error", errorName(err));
    }

    let status = res.status;
    if (proxy) {
      const up = upstreamStatus(res);
      if (up == null) {
        await cancelBody(res);
        // 504 from the proxy itself means the upstream timed out behind it.
        if (res.status === 504) throw new ScihubFetchError("timeout", "proxy upstream timeout");
        throw new ScihubFetchError("error", `proxy failure ${res.status}`);
      }
      status = up;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await cancelBody(res);
      return { status, contentType, body: new Uint8Array(0), overCap: true, partial: false };
    }

    const read = await readCapped(res, opts.maxBytes, () => timedOut);
    if (read.timedOut && !opts.partialOnTimeout) {
      throw new ScihubFetchError("timeout", `body timeout after ${opts.timeoutMs}ms`);
    }
    return {
      status,
      contentType,
      body: read.bytes,
      overCap: read.overCap,
      partial: read.timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(
  res: Response,
  maxBytes: number,
  isTimedOut: () => boolean,
): Promise<{ bytes: Uint8Array; overCap: boolean; timedOut: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), overCap: false, timedOut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overCap = false;
  let timedOut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        overCap = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (!isTimedOut()) throw new ScihubFetchError("error", errorName(err));
    timedOut = true;
  }
  if (overCap) return { bytes: new Uint8Array(0), overCap, timedOut };
  return { bytes: concat(chunks), overCap, timedOut };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing useful to do; the response is being discarded anyway.
  }
}

/** Error class name only: messages can embed URLs, which we do not log. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/** Decode a body as text for HTML parsing (latin1-safe fallback is not needed: pages are UTF-8). */
export function bodyText(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body);
}
