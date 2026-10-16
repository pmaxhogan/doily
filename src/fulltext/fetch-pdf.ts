/**
 * A byte-capped PDF fetcher for arbitrary open-access hosts (publisher sites,
 * institutional repositories, preprint servers) found by Unpaywall, OpenAlex,
 * Semantic Scholar, bioRxiv and CORE.
 *
 * - https only: the initial URL and every redirect Location must be https.
 *   Redirects are followed by hand (`redirect: "manual"`, at most
 *   MAX_REDIRECTS) so no intermediate hop can downgrade to http.
 * - A polite User-Agent (src/lib/http.ts) and `Accept: application/pdf`.
 * - A wall-clock timeout over the whole exchange, body included.
 * - The body is read as a stream and abandoned the moment it passes the cap,
 *   so a multi-gigabyte response never sits in memory.
 * - The body must start with `%PDF`; an HTML landing page (or anything else)
 *   comes back as `{ kind: "html" }` and is never scraped.
 *
 * There is no token bucket here: OA hosts are many and each is hit at most a
 * few times per chain run, so the provider buckets in src/lib/ratelimit.ts do
 * not apply. Error reasons never include the URL (a CORE download URL could
 * in principle carry a key in its query string).
 */

import { userAgent } from "../lib/http.ts";
import { MAX_PDF_BYTES } from "./pdf.ts";

import type { ToolDeps } from "../tools/types.ts";

export const FETCH_PDF_TIMEOUT_MS = 60_000;
export const MAX_REDIRECTS = 5;
const ACCEPT = "application/pdf,*/*;q=0.8";

export type FetchPdfErrorCode = "bad_url" | "http" | "network" | "timeout" | "over_cap";

export type FetchPdfResult =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "html"; status: number }
  | { kind: "error"; code: FetchPdfErrorCode; reason: string };

export interface FetchPdfOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export type FetchPdfDeps = Pick<ToolDeps, "fetch" | "env">;

class OverCap extends Error {}

function httpsUrl(raw: string, base?: string): URL | null {
  try {
    const url = base === undefined ? new URL(raw) : new URL(raw, base);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  // "%PDF"; some servers prepend a few bytes of whitespace or a BOM, which
  // PDF readers tolerate within the first 1024 bytes. Accept that too.
  const limit = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46
    )
      return true;
    const b = bytes[i];
    // Only whitespace, NUL and a UTF-8 BOM may come before the magic.
    if (
      b !== 0x20 &&
      b !== 0x09 &&
      b !== 0x0a &&
      b !== 0x0d &&
      b !== 0x00 &&
      b !== 0xef &&
      b !== 0xbb &&
      b !== 0xbf
    )
      return false;
  }
  return false;
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new OverCap();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OverCap();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetches `url` and classifies the body. Never throws. */
export async function fetchPdf(
  deps: FetchPdfDeps,
  url: string,
  opts: FetchPdfOptions = {},
): Promise<FetchPdfResult> {
  const maxBytes = opts.maxBytes ?? MAX_PDF_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_PDF_TIMEOUT_MS;
  let current = httpsUrl(url);
  if (!current) return { kind: "error", code: "bad_url", reason: "not an https URL" };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FetchPdfResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "error", code: "timeout", reason: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });

  const work = (async (): Promise<FetchPdfResult> => {
    const headers = { "User-Agent": userAgent(deps.env), Accept: ACCEPT };
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await deps.fetch(current.href, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        return { kind: "error", code: "network", reason: `request failed: ${message(err)}` };
      }

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location)
          return { kind: "error", code: "http", reason: `HTTP ${res.status} without Location` };
        if (hop >= MAX_REDIRECTS)
          return { kind: "error", code: "http", reason: "too many redirects" };
        const next = httpsUrl(location, current.href);
        if (!next) return { kind: "error", code: "bad_url", reason: "redirect to a non-https URL" };
        current = next;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "error", code: "http", reason: `HTTP ${res.status}` };
      }

      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("text/html")) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "html", status: res.status };
      }

      let bytes: Uint8Array;
      try {
        bytes = await readCapped(res, maxBytes);
      } catch (err) {
        if (err instanceof OverCap)
          return { kind: "error", code: "over_cap", reason: `larger than ${maxBytes} bytes` };
        return {
          kind: "error",
          code: "network",
          reason: `reading the body failed: ${message(err)}`,
        };
      }
      if (!startsWithPdfMagic(bytes)) return { kind: "html", status: res.status };
      return { kind: "pdf", bytes };
    }
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    work.catch(() => undefined);
  }
}
