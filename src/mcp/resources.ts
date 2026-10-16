/**
 * The `doily://pdf/{+doi}` resource template: a cached PDF served straight out
 * of R2 (`pdf/<doi>.pdf`, written by the full-text chain and by `get_pdf`).
 *
 * The template uses the `+` (reserved) operator rather than the spec's literal
 * `{doi}`: a DOI always contains a `/` (`10.1038/nature12373`), and the SDK's
 * matcher compiles a plain `{doi}` to `([^/,]+)`, which can never match one.
 * The URI clients see is unchanged: `doily://pdf/10.1038/nature12373`.
 *
 * Only reachable through `/mcp`, so it is behind the same auth as every tool.
 */

import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";

import type { ToolDeps } from "../tools/types.ts";
import type { McpServer, ReadResourceResult } from "@modelcontextprotocol/server";

export const PDF_URI_TEMPLATE = "doily://pdf/{+doi}";
const PDF_MIME = "application/pdf";

/** The R2 key the full-text cache stores a DOI's PDF under. */
export function pdfKey(doi: string): string {
  return `pdf/${doi}.pdf`;
}

/**
 * The DOI out of the template variable: percent-decoded (a client may encode
 * the slash), trimmed, and rejected if it is not shaped like a DOI at all so a
 * crafted URI cannot address some other R2 key (`../text/x.md`).
 */
export function doiFromVariable(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (!value) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    return null;
  }
  if (!/^10\.\d{4,9}\/\S+$/u.test(decoded) || decoded.includes("..")) return null;
  return decoded;
}

/**
 * Largest PDF served inline. A resource read holds the bytes, their base64
 * (4/3 of the size) and the SDK's JSON-serialized result (another 4/3), so
 * 16 MiB peaks near 70 MB, well inside the 128 MB isolate limit; a 50 MB PDF
 * would not fit. Bigger files go through get_pdf's download link.
 */
export const MAX_INLINE_PDF_BYTES = 16 * 1024 * 1024;

/**
 * base64 of a byte array, encoded in 3-byte-aligned chunks joined once at the
 * end. Never builds the whole binary string (which would be another full
 * copy plus rope flattening), and never spreads more than one chunk into
 * `String.fromCharCode`, which would overflow the argument limit.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 3 * 0x2000;
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += CHUNK) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + CHUNK))));
  }
  return parts.join("");
}

/**
 * Read a cached PDF. Tries the DOI as given, then lowercased: DOIs are
 * case-insensitive and the cache writer may have normalized either way.
 */
export async function readPdf(
  deps: ToolDeps,
  uri: string,
  doi: string,
): Promise<ReadResourceResult> {
  const keys = [...new Set([pdfKey(doi), pdfKey(doi.toLowerCase())])];
  for (const key of keys) {
    const object = await deps.env.PDFS.get(key);
    if (!object) continue;
    if (object.size > MAX_INLINE_PDF_BYTES) {
      await object.body.cancel().catch(() => undefined);
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `The cached PDF for ${doi} is ${object.size} bytes, over the ${MAX_INLINE_PDF_BYTES}-byte ` +
          "inline limit; use the download link from get_pdf instead.",
        { uri },
      );
    }
    // A view over R2's buffer, not a copy.
    const bytes = new Uint8Array(await object.arrayBuffer());
    return { contents: [{ uri, mimeType: PDF_MIME, blob: toBase64(bytes) }] };
  }
  throw new ResourceNotFoundError(uri, `No cached PDF for ${doi}; call get_pdf first.`);
}

export function registerPdfResource(server: McpServer, deps: ToolDeps): void {
  server.registerResource(
    "pdf",
    new ResourceTemplate(PDF_URI_TEMPLATE, { list: undefined }),
    {
      title: "Cached paper PDF",
      description:
        "A paper's PDF from doily's cache, as base64. Populated by get_pdf and get_full_text. " +
        "Example: doily://pdf/10.1038/nature12373",
      mimeType: PDF_MIME,
    },
    async (uri, variables) => {
      const doi = doiFromVariable(variables["doi"]);
      if (!doi) throw new ResourceNotFoundError(uri.href, "Not a DOI.");
      return readPdf(deps, uri.href, doi);
    },
  );
}
