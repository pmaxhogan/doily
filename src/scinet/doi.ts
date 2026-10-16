/**
 * DOI normalization shared by the Sci-Net tools, the request Durable Object
 * name, the KV request index and the R2 keys. Lowercased because DOIs are
 * case-insensitive by definition and the same paper must map to one DO.
 */

const DOI_RE = /^10\.\d{4,9}\/\S+$/;

/** Strip `doi:` / doi.org URL prefixes, trim, lowercase. Returns null if not a DOI. */
export function normalizeDoi(input: string): string | null {
  let s = input.trim();
  s = s.replace(/^doi:\s*/i, "");
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  try {
    if (/%2f/i.test(s)) s = decodeURIComponent(s);
  } catch {
    return null;
  }
  s = s.toLowerCase();
  return DOI_RE.test(s) ? s : null;
}

/** R2 key of the cached PDF for a normalized DOI. */
export function pdfKey(doi: string): string {
  return `pdf/${doi}.pdf`;
}

/** R2 key of the cached markdown text for a normalized DOI. */
export function textKey(doi: string): string {
  return `text/${doi}.md`;
}

/** R2 key for a fulfilment that failed the sanity check (kept for the owner). */
export function unverifiedPdfKey(doi: string): string {
  return `pdf-unverified/${doi}.pdf`;
}
