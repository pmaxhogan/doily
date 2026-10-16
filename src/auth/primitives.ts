// Byte and cookie primitives shared by the auth modules.
//
// WebCrypto plus TextEncoder only, no Worker-only types and no Node built-ins,
// so the modules built on top (bearer, access) run unchanged in the plain-Node
// unit project and in workerd. Adapted from pmaxhogan/healthy (MIT).

const encoder = new TextEncoder();

/** A `Uint8Array` backed by a plain `ArrayBuffer`, which `crypto.subtle` accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** UTF-8 bytes of `value`, re-homed in a fresh `ArrayBuffer` (see `Bytes`). */
export function utf8(value: string): Bytes {
  const encoded = encoder.encode(value);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

/**
 * Constant-time comparison for equal-length inputs. The early return on a
 * length mismatch is deliberate: callers compare fixed-width digests, whose
 * length is public. `crypto.subtle.timingSafeEqual` is workerd-only, and this
 * module must also run in Node for the unit tests.
 */
export function timingSafeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (const [index, byte] of a.entries()) diff |= byte ^ (b.at(index) ?? 0);
  return diff === 0;
}

/** SHA-256 of a UTF-8 string. */
export async function sha256(value: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value)));
}

/** One cookie out of a request's `Cookie` header, or null. Splits on the first `=`. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    if (trimmed.slice(0, equals) === name) return trimmed.slice(equals + 1);
  }
  return null;
}
