/**
 * GET /download/<doi>?exp=<unix seconds>&sig=<token>: streams a cached PDF
 * out of R2 to whoever holds a link minted by get_pdf (presignPdfUrl in
 * cache.ts). The HMAC in the query string is the only credential, so this
 * route sits outside the OAuth/bearer layer (and must be excluded from
 * Cloudflare Access, like /mcp).
 *
 * 403 for a missing, bad or expired signature (checked before R2 is
 * touched), 404 for a malformed DOI path or an uncached PDF, 405 for methods
 * other than GET and HEAD.
 */

import { normalizeDoi, pdfKey, verifyDownloadToken } from "./cache.ts";

import type { Env } from "../env.ts";

const PREFIX = "/download/";

/** The DOI out of the path, each segment percent-decoded, or null. */
export function doiFromDownloadPath(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  let doi: string;
  try {
    doi = pathname.slice(PREFIX.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  doi = normalizeDoi(doi);
  if (!/^10\.\d{4,9}\/\S+$/u.test(doi) || doi.includes("..")) return null;
  return doi;
}

/** `10.1038/nature12373` -> `10.1038_nature12373.pdf`, safe inside quotes. */
export function downloadFilename(doi: string): string {
  // eslint-disable-next-line no-control-regex -- control characters cannot appear in a header value
  return `${doi.replace(/\//g, "_").replace(/["\\\u0000-\u001f\u007f]/g, "_")}.pdf`;
}

export async function serveDownload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const doi = doiFromDownloadPath(url.pathname);
  if (!doi) return new Response("not found", { status: 404 });

  const ok = await verifyDownloadToken(
    env.REQUEST_TOKEN_SECRET,
    doi,
    url.searchParams.get("exp") ?? "",
    url.searchParams.get("sig") ?? "",
  );
  if (!ok) {
    return new Response("invalid or expired link; call get_pdf again", {
      status: 403,
      headers: { "cache-control": "private, no-store" },
    });
  }

  const head = request.method === "HEAD";
  const obj = head ? await env.PDFS.head(pdfKey(doi)) : await env.PDFS.get(pdfKey(doi));
  if (!obj) return new Response("not found", { status: 404 });

  const headers = {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${downloadFilename(doi)}"`,
    "content-length": String(obj.size),
    "cache-control": "private, no-store",
  };
  const body = "body" in obj ? (obj as R2ObjectBody).body : null;
  return new Response(head ? null : body, { status: 200, headers });
}
