/**
 * PDF link extraction from Sci-Hub article pages, by regex (no DOM parser in
 * the Worker and no new dependencies). Covers both page families observed in
 * 2026-10:
 *
 *  - official (sci-hub.ru): `<meta name="citation_pdf_url" content="/storage/...pdf">`
 *    and `<object type = "application/pdf" data = "/storage/...pdf#...">`
 *  - third-party network (sci-hub.ee/.ren/.al): `<iframe|embed src="https://sci.bban.top/pdf/<DOI>.pdf#view=FitH">`
 *    plus a save button `onclick="location.href='https:\/\/sci.bban.top\/pdf\/<DOI>.pdf?download=true'"`
 */

export type CandidateSource =
  "citation_pdf_url" | "object" | "embed" | "iframe" | "onclick" | "bban";

export interface PdfCandidate {
  url: string;
  via: CandidateSource;
}

/** Hosts run by the Sci-Hub project itself (linked from the sci-hub.ru mirror bar). */
export const OFFICIAL_MIRRORS: ReadonlySet<string> = new Set([
  "sci-hub.ru",
  "sci-hub.su",
  "sci-hub.st",
  "sci-hub.red",
  "sci-hub.box",
  "sci-hub.se",
]);

export const BBAN_ORIGIN = "https://sci.bban.top";

/** The third-party network's direct PDF location for a DOI. */
export function bbanPdfUrl(doi: string): string {
  return `${BBAN_ORIGIN}/pdf/${encodeURI(doi)}.pdf`;
}

/** Value of one attribute in a tag's source, tolerating `name = "v"`, single quotes and bare values. */
export function getAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function tags(html: string, name: string): string[] {
  return html.match(new RegExp(`<${name}\\b[\\s\\S]*?>`, "gi")) ?? [];
}

function pathEndsWithPdf(raw: string): boolean {
  const noFrag = raw.split("#")[0] ?? "";
  const noQuery = noFrag.split("?")[0] ?? "";
  return /\.pdf$/i.test(noQuery.trim());
}

/** Unescape, resolve against the mirror, drop the fragment. Null when unusable. */
export function normalizeCandidate(raw: string, mirrorOrigin: string): string | null {
  const unescaped = raw
    .trim()
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*47;|&#x0*2f;/gi, "/");
  if (!unescaped || /^(?:javascript|data|about|blob):/i.test(unescaped)) return null;
  let url: URL;
  try {
    url = new URL(unescaped, mirrorOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  return url.toString();
}

/** Raw (unresolved) candidates in priority order, without the bban fallback. */
function rawCandidates(html: string): { raw: string; via: CandidateSource }[] {
  const out: { raw: string; via: CandidateSource }[] = [];

  for (const tag of tags(html, "meta")) {
    if ((getAttr(tag, "name") ?? "").toLowerCase() !== "citation_pdf_url") continue;
    const v = getAttr(tag, "content");
    if (v) out.push({ raw: v, via: "citation_pdf_url" });
  }
  for (const tag of tags(html, "object")) {
    const v = getAttr(tag, "data");
    if (v && pathEndsWithPdf(v)) out.push({ raw: v, via: "object" });
  }
  for (const tag of tags(html, "embed")) {
    const v = getAttr(tag, "src");
    if (v && pathEndsWithPdf(v)) out.push({ raw: v, via: "embed" });
  }
  for (const tag of tags(html, "iframe")) {
    const v = getAttr(tag, "src");
    if (!v) continue;
    if ((getAttr(tag, "id") ?? "").toLowerCase() === "pdf" || pathEndsWithPdf(v)) {
      out.push({ raw: v, via: "iframe" });
    }
  }
  // Only location.href assignments: the same pages carry ad buttons that use window.open(...).
  const onclick = /\sonclick\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = onclick.exec(html); m; m = onclick.exec(html)) {
    const js = m[1] ?? m[2] ?? "";
    const href = /location\.href\s*=\s*(?:'([^']*)'|"([^"]*)"|&quot;(.*?)&quot;)/i.exec(js);
    const v = href?.[1] ?? href?.[2] ?? href?.[3];
    if (v) out.push({ raw: v, via: "onclick" });
  }
  return out;
}

/** True when the page carries any PDF markup the parser understands. */
export function hasPdfMarkup(html: string): boolean {
  return rawCandidates(html).length > 0;
}

export function isThirdPartyMirror(mirrorOrigin: string, html = ""): boolean {
  let host: string;
  try {
    host = new URL(mirrorOrigin).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (html.includes("sci.bban.top")) return true;
  return !OFFICIAL_MIRRORS.has(host);
}

/**
 * Ordered, de-duplicated PDF candidates for one article page:
 * citation_pdf_url meta, object[data], embed[src], iframe#pdf or *.pdf iframe,
 * onclick location.href, then (third-party mirrors only, when `doi` is given)
 * the direct `https://sci.bban.top/pdf/<DOI>.pdf` pattern.
 */
export function extractPdfUrl(
  html: string,
  mirrorOrigin: string,
  opts: { doi?: string } = {},
): PdfCandidate[] {
  const seen = new Set<string>();
  const out: PdfCandidate[] = [];
  const add = (url: string | null, via: CandidateSource): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, via });
  };
  for (const c of rawCandidates(html)) add(normalizeCandidate(c.raw, mirrorOrigin), c.via);
  if (opts.doi && isThirdPartyMirror(mirrorOrigin, html)) add(bbanPdfUrl(opts.doi), "bban");
  return out;
}
