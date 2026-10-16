import type { ToolDeps } from "../tools/types.ts";

/**
 * Seams the full-text chain wires in later. They live in a module-level
 * registry (not in ToolDeps) because the SciNetRequest Durable Object is
 * constructed by the runtime and cannot receive arguments; the Worker entry
 * point calls `setScinetHooks` once at module load and both the tools and the
 * DO (same isolate) read the current value at call time.
 */

/** PDF bytes to markdown/plain text. */
export type TextOf = (bytes: Uint8Array) => Promise<string>;

/** Whether the OA chain (sections 4.1 to 4.6) can already deliver the paper. */
export type IsObtainable = (deps: ToolDeps, doi: string) => Promise<false | { source: string }>;

export interface ScinetHooks {
  textOf: TextOf;
  isObtainable: IsObtainable;
}

/** Bytes scanned at each end of the file by `bytesContainDoi`. */
export const DOI_SCAN_WINDOW = 2 * 1024 * 1024;

function lowerAscii(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b | 0x20 : b;
}

/** Bytes that JavaScript's `\s` matches in latin1 text. */
function isSpaceByte(b: number): boolean {
  return b === 0x20 || (b >= 0x09 && b <= 0x0d) || b === 0xa0;
}

function scanFor(hay: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  for (let i = 0; i < hay.length; i++) {
    if (lowerAscii(hay[i] as number) !== first) continue;
    let j = 1;
    let k = i + 1;
    while (j < needle.length && k < hay.length) {
      const b = hay[k] as number;
      if (isSpaceByte(b)) {
        // A DOI wrapped across lines still counts, as with the text check.
        k++;
        continue;
      }
      if (lowerAscii(b) !== needle[j]) break;
      j++;
      k++;
    }
    if (j === needle.length) return true;
  }
  return false;
}

/**
 * Whether the raw bytes contain the DOI (ASCII case-insensitive, whitespace
 * inside the match ignored). Not text extraction: the machine uses it only as
 * a second place to look for the DOI during the sanity check, because
 * uncompressed PDFs and the XMP metadata many publishers embed uncompressed
 * expose the DOI this way. Only the first and last DOI_SCAN_WINDOW bytes are
 * scanned (XMP and the first page live there), and no string is built, so a
 * 50 MB PDF costs no extra memory.
 */
export function bytesContainDoi(bytes: Uint8Array, doi: string): boolean {
  const needle = new TextEncoder().encode(doi.trim().toLowerCase());
  if (needle.length === 0) return false;
  if (bytes.length <= DOI_SCAN_WINDOW * 2) return scanFor(bytes, needle);
  return (
    scanFor(bytes.subarray(0, DOI_SCAN_WINDOW), needle) ||
    scanFor(bytes.subarray(bytes.length - DOI_SCAN_WINDOW), needle)
  );
}

/**
 * Default extractor: none. Returns "" so no garbage is stored as text; the
 * sanity check then relies on the raw-bytes DOI scan, and anything that fails
 * it lands in `needs_owner`, the safe direction. The chain wires pdfToText.
 */
export const noText: TextOf = async () => "";

export const scinetHooks: ScinetHooks = {
  textOf: noText,
  isObtainable: async () => false,
};

export function setScinetHooks(hooks: Partial<ScinetHooks>): void {
  Object.assign(scinetHooks, hooks);
}
