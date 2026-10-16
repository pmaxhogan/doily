import { ToolError } from "../tools/types.ts";

/**
 * Stateless request tokens: `<base64url(doi)>.<base64url(HMAC-SHA256(doi))>`.
 * get_full_text hands one out on total failure so request_paper can be called
 * later without get_full_text creating any state. The DOI is embedded so
 * verification can return it; the MAC stops an agent from forging tokens for
 * arbitrary DOIs (request_paper still re-checks obtainability either way).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (secret === undefined || secret === "") {
    throw new ToolError("request tokens are not configured (REQUEST_TOKEN_SECRET unset)");
  }
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function makeRequestToken(secret: string | undefined, doi: string): Promise<string> {
  const key = await hmacKey(secret);
  const data = enc.encode(doi);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return `${b64urlEncode(data)}.${b64urlEncode(mac)}`;
}

/** The DOI inside a valid token, or null when the token is malformed or forged. */
export async function verifyRequestToken(
  secret: string | undefined,
  token: string,
): Promise<string | null> {
  const key = await hmacKey(secret);
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;
  const data = b64urlDecode(parts[0] ?? "");
  const mac = b64urlDecode(parts[1] ?? "");
  if (data === null || mac === null || data.byteLength === 0) return null;
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", key, mac, data);
  return ok ? dec.decode(data) : null;
}
