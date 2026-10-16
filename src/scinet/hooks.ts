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

/**
 * The raw bytes as latin1. Not text extraction: the machine uses it only as a
 * second place to look for the DOI during the sanity check, because
 * uncompressed PDFs and the XMP metadata many publishers embed uncompressed
 * expose the DOI this way.
 */
export function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
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
