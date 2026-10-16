/**
 * R2 cache for fetched PDFs and extracted text, plus signed download links.
 *
 * Keys: `pdf/<doi>.pdf` and `text/<doi>.md`, DOI lowercased with its `/`
 * kept (R2 keys are flat; the slash only reads like a directory). Objects
 * carry customMetadata `{ source, fetched_at }` and are kept indefinitely.
 *
 * Download links: R2 presigned URLs need S3 API credentials the Worker does
 * not have, so get_pdf hands out a link to the Worker itself instead:
 *   `${origin}/download/<doi>?exp=<unix seconds>&sig=<token>`
 * where token = base64url(HMAC-SHA256(REQUEST_TOKEN_SECRET,
 * "download\n<doi lowercased>\n<exp>")). The "download" prefix keeps these
 * tokens from ever validating as (or being forged from) the request tokens
 * that get_full_text signs with the same secret. Each DOI path segment is
 * percent-encoded (DOIs may contain `<`, `>`, `;`, `#`, `?`); the route must
 * decode the path back to the DOI before calling verifyDownloadToken.
 */

import type { Env } from "../env.ts";

export const DOWNLOAD_TTL_SECONDS = 3600;

export interface CacheMeta {
  source: string;
  fetched_at: string;
}

export interface CachedPdf {
  bytes: Uint8Array;
  size: number;
  source?: string;
  fetched_at?: string;
}

export interface CachedText {
  text: string;
  source?: string;
  fetched_at?: string;
}

export function normalizeDoi(doi: string): string {
  return doi.trim().toLowerCase();
}

export function pdfKey(doi: string): string {
  return `pdf/${normalizeDoi(doi)}.pdf`;
}

export function textKey(doi: string): string {
  return `text/${normalizeDoi(doi)}.md`;
}

function metaOf(obj: R2Object): Partial<CacheMeta> {
  const m = obj.customMetadata ?? {};
  const out: Partial<CacheMeta> = {};
  if (m["source"] !== undefined) out.source = m["source"];
  if (m["fetched_at"] !== undefined) out.fetched_at = m["fetched_at"];
  return out;
}

export async function getCachedPdf(bucket: R2Bucket, doi: string): Promise<CachedPdf | null> {
  const obj = await bucket.get(pdfKey(doi));
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return { bytes, size: obj.size, ...metaOf(obj) };
}

export async function putPdf(
  bucket: R2Bucket,
  doi: string,
  bytes: Uint8Array,
  meta: { source: string },
  now: Date = new Date(),
): Promise<void> {
  const customMetadata: CacheMeta = { source: meta.source, fetched_at: now.toISOString() };
  await bucket.put(pdfKey(doi), bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { ...customMetadata },
  });
}

export async function getCachedText(bucket: R2Bucket, doi: string): Promise<CachedText | null> {
  const obj = await bucket.get(textKey(doi));
  if (!obj) return null;
  return { text: await obj.text(), ...metaOf(obj) };
}

export async function putText(
  bucket: R2Bucket,
  doi: string,
  text: string,
  meta: { source: string },
  now: Date = new Date(),
): Promise<void> {
  const customMetadata: CacheMeta = { source: meta.source, fetched_at: now.toISOString() };
  await bucket.put(textKey(doi), text, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { ...customMetadata },
  });
}

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function tokenMessage(doi: string, expiresAt: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`download\n${normalizeDoi(doi)}\n${expiresAt}`));
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(
      s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4),
    );
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** HMAC-SHA256 token for a download link; `expiresAt` is unix seconds. */
export async function makeDownloadToken(
  secret: string,
  doi: string,
  expiresAt: number,
): Promise<string> {
  if (!secret) throw new Error("REQUEST_TOKEN_SECRET is not set");
  if (!Number.isSafeInteger(expiresAt))
    throw new Error("expiresAt must be an integer (unix seconds)");
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    tokenMessage(doi, expiresAt),
  );
  return base64url(new Uint8Array(sig));
}

/**
 * True when `token` signs (doi, expiresAt) and the link has not expired.
 * `expiresAt` may be the raw `exp` query string. Uses crypto.subtle.verify,
 * which compares in constant time. Never throws on malformed input.
 */
export async function verifyDownloadToken(
  secret: string | undefined,
  doi: string,
  expiresAt: number | string,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!secret || !token) return false;
  const exp =
    typeof expiresAt === "number"
      ? expiresAt
      : /^\d{1,15}$/.test(expiresAt)
        ? Number(expiresAt)
        : NaN;
  if (!Number.isSafeInteger(exp)) return false;
  if (exp <= Math.floor(now.getTime() / 1000)) return false;
  const sig = fromBase64url(token);
  if (!sig || sig.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig, tokenMessage(doi, exp));
}

/** URL path for a DOI download, each segment percent-encoded, `/` kept. */
export function downloadPath(doi: string): string {
  return `/download/${normalizeDoi(doi).split("/").map(encodeURIComponent).join("/")}`;
}

export interface PresignDeps {
  env: Pick<Env, "REQUEST_TOKEN_SECRET">;
  origin: string;
  now: () => Date;
}

/**
 * A time-limited link to the PDF, served by the Worker's /download route (a
 * stand-in for an R2 presigned URL; see the header comment). Throws when
 * REQUEST_TOKEN_SECRET is unset.
 */
export async function presignPdfUrl(
  deps: PresignDeps,
  doi: string,
  ttlSeconds = DOWNLOAD_TTL_SECONDS,
): Promise<string> {
  const secret = deps.env.REQUEST_TOKEN_SECRET;
  if (!secret) throw new Error("REQUEST_TOKEN_SECRET is not set");
  const exp = Math.floor(deps.now().getTime() / 1000) + ttlSeconds;
  const sig = await makeDownloadToken(secret, doi, exp);
  return `${deps.origin.replace(/\/+$/, "")}${downloadPath(doi)}?exp=${exp}&sig=${sig}`;
}
