/**
 * PDF bytes to plain text: unpdf first, Workers AI `toMarkdown` as fallback.
 *
 * Bundling: plain `import { getDocumentProxy } from "unpdf"` is enough for
 * workerd. unpdf ships a serverless build of PDF.js and loads it lazily with
 * `import("unpdf/pdfjs")`, which wrangler's esbuild inlines into the Worker
 * bundle; it needs no Node polyfills beyond the `nodejs_compat` flag the
 * Worker already sets, and no `definePDFJSModule` call. Verified with
 * `wrangler deploy --dry-run` (the dry run proves bundling, not execution).
 *
 * Text is extracted page by page (rather than `extractText(pdf, { mergePages:
 * true })`) because dropping running headers and footers needs page
 * boundaries, and because a page loop is the only place a deadline can be
 * checked. Promise.race alone cannot stop CPU-bound parsing, and inside
 * workerd the clock only advances across I/O, so the page cap (400) is the
 * real bound on work; the timeout catches parses that stall between pages.
 */

import { getDocumentProxy } from "unpdf";

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 400;
export const UNPDF_TIMEOUT_MS = 60_000;
/** Below this many characters on a document of more than 2 pages, assume a scan. */
const SPARSE_TEXT_CHARS = 200;
const SPARSE_MIN_PAGES = 2;

export interface PdfDeps {
  ai?: Ai;
  /** Override for tests; defaults to UNPDF_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface PdfTextResult {
  text: string;
  pages?: number;
  method: "unpdf" | "ai";
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

interface RawPages {
  pages: string[];
  numPages: number;
}

/** The subset of a PDF.js text item this module reads. */
interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  height?: number;
  transform?: number[];
}

export async function pdfToText(bytes: Uint8Array, deps: PdfDeps = {}): Promise<PdfTextResult> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfError(`PDF is ${bytes.byteLength} bytes; the limit is ${MAX_PDF_BYTES} (50 MB)`);
  }

  let raw: RawPages | undefined;
  let unpdfError: unknown;
  try {
    raw = await extractPages(bytes, deps.timeoutMs ?? UNPDF_TIMEOUT_MS);
  } catch (err) {
    unpdfError = err;
  }

  const text = raw ? cleanupPages(raw.pages) : "";
  const chars = text.trim().length;
  const sparse = raw !== undefined && chars < SPARSE_TEXT_CHARS && raw.numPages > SPARSE_MIN_PAGES;
  if (raw && chars > 0 && !sparse) {
    return { text, pages: raw.numPages, method: "unpdf" };
  }

  const why = unpdfError
    ? `unpdf failed: ${errorMessage(unpdfError)}`
    : chars === 0
      ? "unpdf found no text (scanned PDF?)"
      : `unpdf found only ${chars} chars on ${raw?.numPages} pages`;

  if (!deps.ai) {
    // Sparse text is still better than nothing when there is no AI binding.
    if (raw && chars > 0) return { text, pages: raw.numPages, method: "unpdf" };
    throw new PdfError(`${why}; no AI binding for the fallback`);
  }

  try {
    const md = await aiToMarkdown(deps.ai, bytes);
    return raw ? { text: md, pages: raw.numPages, method: "ai" } : { text: md, method: "ai" };
  } catch (err) {
    if (raw && chars > 0) return { text, pages: raw.numPages, method: "unpdf" };
    throw new PdfError(`${why}; AI fallback failed: ${errorMessage(err)}`);
  }
}

/**
 * The bytes as a BlobPart. The Blob constructor copies its parts anyway, so
 * an ArrayBuffer-backed view is passed as is; only a view over a
 * SharedArrayBuffer (which BlobPart does not accept) is copied first.
 */
function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

async function aiToMarkdown(ai: Ai, bytes: Uint8Array): Promise<string> {
  const blob = new Blob([blobPart(bytes)], { type: "application/pdf" });
  const res = await ai.toMarkdown({ name: "doc.pdf", blob });
  if (res.format === "error") throw new Error(res.error);
  const text = res.data
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new Error("toMarkdown returned no text");
  return text;
}

async function extractPages(bytes: Uint8Array, timeoutMs: number): Promise<RawPages> {
  const deadline = Date.now() + timeoutMs;
  const work = (async (): Promise<RawPages> => {
    // PDF.js transfers (detaches) the buffer it is given, so it gets a copy
    // and the caller's bytes stay intact for caching. This is the only copy:
    // it is released when the document is destroyed below, normally before
    // any AI fallback builds its Blob, so two PDFs' worth are live, not three.
    const pdf = await getDocumentProxy(bytes.slice());
    try {
      const count = Math.min(pdf.numPages, MAX_PDF_PAGES);
      const pages: string[] = [];
      for (let i = 1; i <= count; i++) {
        // `>=`: with timeoutMs 0 the deadline is already reached at page 1.
        if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms at page ${i}`);
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(itemsToText(content.items as TextItemLike[]));
        page.cleanup();
      }
      return { pages, numPages: pdf.numPages };
    } finally {
      await pdf.loadingTask.destroy().catch(() => undefined);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // If the timeout won, the parse may still reject later; swallow it so it
    // is not reported as an unhandled rejection.
    work.catch(() => undefined);
  }
}

/**
 * Joins a page's text items into lines. A vertical gap clearly larger than
 * the line height between two lines becomes a blank line (paragraph break).
 */
function itemsToText(items: TextItemLike[]): string {
  let out = "";
  let lastY: number | undefined;
  let lastHeight = 0;
  let lineStart = true;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (lineStart && lastY !== undefined && y !== undefined && out) {
      const gap = lastY - y;
      const h = item.height || lastHeight || 10;
      if (gap > h * 1.8) out += "\n";
    }
    out += item.str;
    if (y !== undefined && item.str.trim()) {
      lastY = y;
      lastHeight = item.height || lastHeight;
    }
    lineStart = item.hasEOL === true;
    if (lineStart) out += "\n";
  }
  return out;
}

const EDGE_LINES = 3;
const MIN_PAGES_FOR_HEADERS = 3;

/**
 * Keys a header/footer candidate line contributes. Every edge line matches
 * exactly (whitespace and case normalized); the outermost line of a page,
 * where page numbers live, also matches with digits normalized, so "Page 3"
 * and "Page 4" agree without letting numbered body lines near the edge match
 * each other.
 */
function edgeKeys(line: string, outermost: boolean): string[] {
  const exact = line.replace(/\s+/g, " ").trim().toLowerCase();
  if (!exact) return [];
  return outermost ? [`e:${exact}`, `d:${exact.replace(/\d+/g, "#")}`] : [`e:${exact}`];
}

/**
 * Light cleanup over per-page text: drop running headers and footers (lines
 * among the first or last 3 of a page that repeat, per edgeKeys, on more than
 * half of the pages), re-join hyphenated line breaks, reflow lines into
 * paragraphs, and collapse whitespace while keeping blank-line paragraph
 * breaks.
 */
export function cleanupPages(pages: string[]): string {
  const split = pages.map((p) =>
    p
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- stripping control characters PDF.js sometimes emits is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .split("\n")
      .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()),
  );

  if (split.length >= MIN_PAGES_FOR_HEADERS) {
    const counts = new Map<string, number>();
    for (const lines of split) {
      const seen = new Set<string>();
      for (const [idx, outermost] of edgeIndexes(lines)) {
        for (const key of edgeKeys(lines[idx] ?? "", outermost)) seen.add(key);
      }
      for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = new Set([...counts].filter(([, n]) => n > split.length / 2).map(([k]) => k));
    if (repeated.size > 0) {
      for (const lines of split) {
        for (const [idx, outermost] of edgeIndexes(lines)) {
          if (edgeKeys(lines[idx] ?? "", outermost).some((k) => repeated.has(k))) lines[idx] = "";
        }
      }
    }
  }

  const text = split
    .map((lines) => trimBlankEdges(lines).join("\n"))
    .filter((p) => p.trim())
    .join("\n\n");

  return (
    text
      // Hyphenated line break inside a word: "exam-\nple" -> "example".
      .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
      // Reflow: single newlines inside a paragraph become spaces.
      .replace(/([^\n])\n(?!\n)/g, "$1 ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Indexes of the first and last EDGE_LINES non-empty lines of a page, each
 * flagged when it is the page's very first or very last non-empty line.
 */
function edgeIndexes(lines: string[]): [number, boolean][] {
  const nonEmpty: number[] = [];
  lines.forEach((l, i) => {
    if (l) nonEmpty.push(i);
  });
  const picked =
    nonEmpty.length <= EDGE_LINES * 2
      ? nonEmpty
      : [...nonEmpty.slice(0, EDGE_LINES), ...nonEmpty.slice(-EDGE_LINES)];
  const first = nonEmpty[0];
  const last = nonEmpty[nonEmpty.length - 1];
  return picked.map((i) => [i, i === first || i === last]);
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]) a++;
  while (b > a && !lines[b - 1]) b--;
  return lines.slice(a, b);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
