/**
 * The open-access full-text chain (spec section 4, hops 1 to 5).
 *
 * Built-in hops, in the locked order:
 *   pmc_jats     Europe PMC fullTextXML by PMCID, then NCBI efetch db=pmc
 *   unpaywall    best_oa_location.url_for_pdf, then other oa_locations
 *   openalex_oa  best_oa_location.pdf_url, then open_access.oa_url
 *   s2_oa        openAccessPdf.url
 *   biorxiv      JATS from the details API's jatsxml, else the .full.pdf
 *   core         downloadUrl, else fullText (needs CORE_API_KEY)
 *
 * Callers append further hops with `extraHops`; they run after the built-in
 * ones, in the order given, under the same timing, error capture and caching.
 *
 * Every run is short-circuited by the R2 cache (src/fulltext/cache.ts). A hit
 * is cached before it is returned: JATS as `jats/<doi>.xml` plus its markdown
 * (references stripped) as `text/<doi>.md`; a PDF as `pdf/<doi>.pdf` plus its
 * extracted text as `text/<doi>.md`.
 *
 * Attempts record what each hop did, so an agent can see why a paper was
 * unavailable. Hop details never carry URLs or secrets.
 */

import { parseId, resolveIds, type ResolvedIds } from "../ids.ts";
import { getPreprintDetails, isPreprintDoi } from "../providers/biorxiv.ts";
import { searchCoreByDoi } from "../providers/core.ts";
import { fetchEuropePmcFullTextXml } from "../providers/europepmc.ts";
import { getOpenAlexWork } from "../providers/openalex.ts";
import { efetch } from "../providers/pubmed.ts";
import { getS2Paper, s2LookupId } from "../providers/semanticscholar.ts";
import { getUnpaywall } from "../providers/unpaywall.ts";
import { fetchText } from "../lib/http.ts";
import { ToolError, type ToolDeps } from "../tools/types.ts";
import {
  getCachedJats,
  getCachedPdf,
  getCachedText,
  headCachedPdf,
  putJats,
  putPdf,
  putText,
} from "./cache.ts";
import { fetchPdf, type FetchPdfOptions } from "./fetch-pdf.ts";
import { jatsToMarkdown } from "./jats.ts";
import { pdfToText } from "./pdf.ts";

/* ---------------------------------------------------------------- types */

export interface HopContext {
  deps: ToolDeps;
  /** Lowercased DOI; every hop and every cache key is keyed on it. */
  doi: string;
  ids: ResolvedIds;
  /** The input, when the agent passed a title rather than an id. */
  title?: string;
}

export type HopFormat = "jats" | "pdf";

export interface HopHit {
  outcome: "hit";
  format: HopFormat;
  /** Ready text. Optional: the chain renders `jats` or extracts `pdf` itself. */
  text?: string;
  pdf?: Uint8Array;
  jats?: string;
}

/**
 * A miss. `outcome` is one of MISS_OUTCOMES for the built-in hops; extra hops
 * may add their own words. `detail` is a short human-readable reason.
 */
export interface HopMiss {
  outcome: string;
  detail?: string;
}

export type HopResult = HopHit | HopMiss;

export interface Hop {
  source: string;
  run(ctx: HopContext): Promise<HopResult>;
}

export const MISS_OUTCOMES = [
  "miss",
  "no_pmcid",
  "landing_page",
  "bad_pdf",
  "over_cap",
  "no_key",
  "error",
  "timeout",
] as const;

/** Recorded by obtainPdf for a hop that yielded text (cached) but no PDF. */
export const TEXT_ONLY = "text_only";

export interface Attempt {
  source: string;
  outcome: string;
  ms: number;
  detail?: string;
}

export interface ChainOptions {
  extraHops?: Hop[];
  includeReferences?: boolean;
  /** Wall-clock budget per hop; defaults to HOP_TIMEOUT_MS. */
  hopTimeoutMs?: number;
  /** Passed to every PDF download (tests shrink the timeout and cap). */
  fetchPdf?: FetchPdfOptions;
  /** Replace the built-in hops (tests). */
  hops?: Hop[];
}

export interface FullTextOk {
  status: "ok";
  doi: string;
  source: string;
  format: HopFormat;
  text: string;
  attempts: Attempt[];
  /** Set when the text came straight from the R2 cache (attempts is then empty). */
  cached?: true;
  /** include_references was asked for but no JATS is cached for this DOI. */
  references_unavailable?: true;
}

export interface Unavailable {
  status: "unavailable";
  doi: string;
  attempts: Attempt[];
}

export type FullTextResult = FullTextOk | Unavailable;

export interface PdfOk {
  status: "ok";
  doi: string;
  source: string;
  size_bytes: number;
  attempts: Attempt[];
  cached?: true;
}

export interface NoPdf {
  status: "no_pdf";
  doi: string;
  text_available: boolean;
  attempts: Attempt[];
}

export type PdfResult = PdfOk | NoPdf;

/** A hop is abandoned (outcome `timeout`) after this long. */
export const HOP_TIMEOUT_MS = 90_000;
/** At most this many candidate PDF URLs are tried per hop. */
export const MAX_URLS_PER_HOP = 3;

/* -------------------------------------------------------------- helpers */

function miss(outcome: string, detail?: string): HopMiss {
  return detail === undefined ? { outcome } : { outcome, detail };
}

function isHit(r: HopResult): r is HopHit {
  return r.outcome === "hit";
}

function hasBody(xml: string): boolean {
  return /<body[\s>]/.test(xml);
}

/** Ranks fetch failures so a hop reports the most informative one. */
const FAILURE_RANK: Record<string, number> = {
  landing_page: 4,
  over_cap: 3,
  timeout: 3,
  error: 2,
  miss: 1,
};

/**
 * Tries candidate PDF URLs in order (deduped, https only, at most
 * MAX_URLS_PER_HOP) and returns the first PDF, else the most informative
 * failure.
 */
export async function tryPdfUrls(
  ctx: HopContext,
  urls: (string | undefined | null)[],
  opts: FetchPdfOptions = {},
): Promise<HopResult> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    candidates.push(u);
  }
  if (candidates.length === 0) return miss("miss", "no open-access PDF URL");

  let worst: HopMiss = miss("miss");
  const notes: string[] = [];
  for (const url of candidates.slice(0, MAX_URLS_PER_HOP)) {
    const res = await fetchPdf(ctx.deps, url, opts);
    if (res.kind === "pdf") return { outcome: "hit", format: "pdf", pdf: res.bytes };
    let failure: HopMiss;
    if (res.kind === "html") failure = miss("landing_page", "got an HTML page, not a PDF");
    else if (res.code === "over_cap") failure = miss("over_cap", res.reason);
    else if (res.code === "timeout") failure = miss("timeout", res.reason);
    else failure = miss("error", res.reason);
    notes.push(failure.detail ?? failure.outcome);
    if ((FAILURE_RANK[failure.outcome] ?? 0) > (FAILURE_RANK[worst.outcome] ?? 0)) worst = failure;
  }
  const tried = Math.min(candidates.length, MAX_URLS_PER_HOP);
  return miss(worst.outcome, `${tried} URL(s) tried: ${notes.join("; ")}`);
}

/* ----------------------------------------------------------------- hops */

export function builtInHops(pdfOpts: FetchPdfOptions = {}): Hop[] {
  return [
    {
      source: "pmc_jats",
      async run(ctx) {
        const pmcid = ctx.ids.pmcid;
        if (!pmcid) return miss("no_pmcid");
        const epmc = await fetchEuropePmcFullTextXml(ctx.deps, pmcid);
        if (epmc && hasBody(epmc)) return { outcome: "hit", format: "jats", jats: epmc };
        // efetch db=pmc takes the numeric id; non-OA articles come back as
        // front matter only (no <body>) or as an <error> element.
        const xml = await efetch(ctx.deps, [pmcid.replace(/^PMC/i, "")], { db: "pmc" });
        if (xml && hasBody(xml)) return { outcome: "hit", format: "jats", jats: xml };
        return miss("miss", "no JATS body in Europe PMC or NCBI");
      },
    },
    {
      source: "unpaywall",
      async run(ctx) {
        const rec = await getUnpaywall(ctx.deps, ctx.doi);
        if (!rec) return miss("miss", "unknown to Unpaywall");
        const urls = [
          rec.best_oa_location?.url_for_pdf,
          ...rec.oa_locations.map((l) => l.url_for_pdf),
        ];
        return tryPdfUrls(ctx, urls, pdfOpts);
      },
    },
    {
      source: "openalex_oa",
      async run(ctx) {
        const work = await getOpenAlexWork(ctx.deps, { doi: ctx.doi });
        if (!work) return miss("miss", "unknown to OpenAlex");
        return tryPdfUrls(ctx, [work.best_oa_location?.pdf_url, work.open_access?.oa_url], pdfOpts);
      },
    },
    {
      source: "s2_oa",
      async run(ctx) {
        const key = s2LookupId({ ...ctx.ids, doi: ctx.doi });
        const paper = key ? await getS2Paper(ctx.deps, key) : null;
        if (!paper) return miss("miss", "unknown to Semantic Scholar");
        return tryPdfUrls(ctx, [paper.pdf_url], pdfOpts);
      },
    },
    {
      source: "biorxiv",
      async run(ctx) {
        if (!isPreprintDoi(ctx.doi)) return miss("miss", "not a bioRxiv/medRxiv DOI");
        const details = await getPreprintDetails(ctx.deps, ctx.doi);
        if (!details) return miss("miss", "unknown to the bioRxiv API");
        const jatsUrl = details.latest.jatsxml;
        if (jatsUrl && /^https:\/\//i.test(jatsUrl)) {
          const res = await fetchText(ctx.deps, {
            source: "biorxiv",
            url: jatsUrl,
            bucket: "biorxiv",
            headers: { Accept: "application/xml" },
            allowNotFound: true,
          }).catch(() => null);
          if (res && hasBody(res.data)) return { outcome: "hit", format: "jats", jats: res.data };
        }
        return tryPdfUrls(ctx, [details.pdf_url], pdfOpts);
      },
    },
    {
      source: "core",
      async run(ctx) {
        if (!ctx.deps.env.CORE_API_KEY) return miss("no_key", "CORE_API_KEY is not set");
        const out = await searchCoreByDoi(ctx.deps, ctx.doi);
        if (!out) return miss("miss", "unknown to CORE");
        let failure: HopResult = miss("miss", "no download URL or full text");
        if (out.download_url) {
          failure = await tryPdfUrls(ctx, [out.download_url], pdfOpts);
          if (isHit(failure)) return failure;
        }
        // CORE's fullText is text CORE extracted from the PDF.
        if (out.full_text?.trim()) return { outcome: "hit", format: "pdf", text: out.full_text };
        return failure;
      },
    },
  ];
}

/* ---------------------------------------------------------------- chain */

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 300);
}

async function runHop(hop: Hop, ctx: HopContext, timeoutMs: number): Promise<HopResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HopResult>((resolve) => {
    timer = setTimeout(
      () => resolve(miss("timeout", `no answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  const work = hop.run(ctx).catch((err: unknown) => miss("error", errorText(err)));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function attempt(source: string, outcome: string, ms: number, detail?: string): Attempt {
  return detail === undefined ? { source, outcome, ms } : { source, outcome, ms, detail };
}

interface Resolved {
  ctx: HopContext;
  hops: Hop[];
  timeoutMs: number;
}

async function resolve(deps: ToolDeps, id: string, opts: ChainOptions): Promise<Resolved> {
  const ids = await resolveIds(deps, id);
  if (!ids.doi) {
    throw new ToolError("could not resolve the identifier to a DOI", {
      source: "ids",
      input: ids.input,
      ...(ids.pmid && { pmid: ids.pmid }),
      ...(ids.pmcid && { pmcid: ids.pmcid }),
    });
  }
  const ctx: HopContext = { deps, doi: ids.doi.toLowerCase(), ids };
  if (ids.input.kind === "title") ctx.title = ids.input.value;
  const hops = [...(opts.hops ?? builtInHops(opts.fetchPdf)), ...(opts.extraHops ?? [])];
  return { ctx, hops, timeoutMs: opts.hopTimeoutMs ?? HOP_TIMEOUT_MS };
}

function render(jats: string, includeReferences: boolean): string {
  return jatsToMarkdown(jats, { includeReferences }).markdown;
}

function elapsed(deps: ToolDeps, start: number): number {
  return Math.max(0, deps.now().getTime() - start);
}

/** PDF bytes to text, falling back to Workers AI when unpdf finds nothing. */
async function extract(deps: ToolDeps, bytes: Uint8Array): Promise<string> {
  const ai = (deps.env as { AI?: Ai }).AI;
  const { text } = await pdfToText(bytes, ai ? { ai } : {});
  return text;
}

/** The DOI when the input is a DOI (or a URL around one), else undefined. */
function directDoi(id: string): string | undefined {
  const parsed = parseId(id);
  return parsed.kind === "doi" ? parsed.value.toLowerCase() : undefined;
}

/** Cached text, or text extracted from a cached PDF; null on a miss. */
async function fromTextCache(
  deps: ToolDeps,
  doi: string,
  refs: boolean,
): Promise<FullTextOk | null> {
  const bucket = deps.env.PDFS;
  const cached = await getCachedText(bucket, doi);
  if (cached) {
    const format: HopFormat = cached.format === "jats" ? "jats" : "pdf";
    const ok: FullTextOk = {
      status: "ok",
      doi,
      source: cached.source ?? "cache",
      format,
      text: cached.text,
      attempts: [],
      cached: true,
    };
    return refs ? withReferences(bucket, ok) : ok;
  }

  // A PDF cached by get_pdf (which skips extraction) still saves a fetch.
  const cachedPdf = await getCachedPdf(bucket, doi);
  if (!cachedPdf) return null;
  try {
    const text = await extract(deps, cachedPdf.bytes);
    const source = cachedPdf.source ?? "cache";
    await putText(bucket, doi, text, { source, format: "pdf" }, deps.now());
    const ok: FullTextOk = {
      status: "ok",
      doi,
      source,
      format: "pdf",
      text,
      attempts: [],
      cached: true,
    };
    return refs ? { ...ok, references_unavailable: true } : ok;
  } catch {
    // Unreadable cached PDF: run the chain for a better copy.
    return null;
  }
}

/**
 * Text (markdown) for a paper: the R2 cache, then every hop in order until
 * one yields text. Throws ToolError only when the id cannot be resolved to a
 * DOI; every other failure is in `attempts`.
 */
export async function obtainFullText(
  deps: ToolDeps,
  id: string,
  opts: ChainOptions = {},
): Promise<FullTextResult> {
  const refs = opts.includeReferences === true;
  // A bare DOI needs no resolution to hit the cache; skip the idconv call.
  const direct = directDoi(id);
  if (direct) {
    const hit = await fromTextCache(deps, direct, refs);
    if (hit) return hit;
  }
  const { ctx, hops, timeoutMs } = await resolve(deps, id, opts);
  const { doi } = ctx;
  if (doi !== direct) {
    const hit = await fromTextCache(deps, doi, refs);
    if (hit) return hit;
  }

  const attempts: Attempt[] = [];
  for (const hop of hops) {
    const start = deps.now().getTime();
    const result = await runHop(hop, ctx, timeoutMs);
    if (!isHit(result)) {
      attempts.push(attempt(hop.source, result.outcome, elapsed(deps, start), result.detail));
      continue;
    }
    try {
      const ok = await storeHit(deps, doi, hop.source, result, refs);
      attempts.push(attempt(hop.source, "hit", elapsed(deps, start)));
      return { ...ok, attempts };
    } catch (err) {
      // Extraction failures are bad PDFs; anything else (R2) is an error.
      const outcome = result.pdf !== undefined && result.text === undefined ? "bad_pdf" : "error";
      attempts.push(attempt(hop.source, outcome, elapsed(deps, start), errorText(err)));
    }
  }
  return { status: "unavailable", doi, attempts };
}

/** Caches a hit and returns the text to hand back (without attempts). */
async function storeHit(
  deps: ToolDeps,
  doi: string,
  source: string,
  hit: HopHit,
  refs: boolean,
): Promise<Omit<FullTextOk, "attempts">> {
  const bucket = deps.env.PDFS;
  const now = deps.now();
  if (hit.jats !== undefined) {
    const plain = hit.text ?? render(hit.jats, false);
    await putJats(bucket, doi, hit.jats, { source }, now);
    await putText(bucket, doi, plain, { source, format: "jats" }, now);
    return {
      status: "ok",
      doi,
      source,
      format: "jats",
      text: refs ? render(hit.jats, true) : plain,
    };
  }
  if (hit.pdf !== undefined) {
    // Cache the PDF even when extraction fails: get_pdf can still serve it.
    await putPdf(bucket, doi, hit.pdf, { source }, now);
    const text = hit.text ?? (await extract(deps, hit.pdf));
    await putText(bucket, doi, text, { source, format: "pdf" }, now);
    return {
      status: "ok",
      doi,
      source,
      format: "pdf",
      text,
      ...(refs && { references_unavailable: true as const }),
    };
  }
  if (hit.text !== undefined && hit.text.trim()) {
    await putText(bucket, doi, hit.text, { source, format: hit.format }, now);
    return {
      status: "ok",
      doi,
      source,
      format: hit.format,
      text: hit.text,
      ...(refs && { references_unavailable: true as const }),
    };
  }
  throw new Error("hop reported a hit with no text, JATS or PDF");
}

async function withReferences(bucket: R2Bucket, ok: FullTextOk): Promise<FullTextOk> {
  const jats = await getCachedJats(bucket, ok.doi);
  if (!jats) return { ...ok, references_unavailable: true };
  return { ...ok, text: render(jats.xml, true) };
}

/**
 * A PDF for a paper: the R2 cache, then every hop in order until one yields
 * a PDF. A JATS or text hit along the way is cached as text (so a later
 * get_full_text is free) but does not end the search.
 */
export async function obtainPdf(
  deps: ToolDeps,
  id: string,
  opts: ChainOptions = {},
): Promise<PdfResult> {
  const bucket = deps.env.PDFS;
  const fromCache = async (doi: string): Promise<PdfOk | null> => {
    const head = await headCachedPdf(bucket, doi);
    if (!head) return null;
    return {
      status: "ok",
      doi,
      source: head.source ?? "cache",
      size_bytes: head.size,
      attempts: [],
      cached: true,
    };
  };
  const direct = directDoi(id);
  if (direct) {
    const hit = await fromCache(direct);
    if (hit) return hit;
  }
  const { ctx, hops, timeoutMs } = await resolve(deps, id, opts);
  const { doi } = ctx;
  if (doi !== direct) {
    const hit = await fromCache(doi);
    if (hit) return hit;
  }

  let textAvailable = (await getCachedText(bucket, doi)) !== null;
  const attempts: Attempt[] = [];
  for (const hop of hops) {
    const start = deps.now().getTime();
    const result = await runHop(hop, ctx, timeoutMs);
    if (!isHit(result)) {
      attempts.push(attempt(hop.source, result.outcome, elapsed(deps, start), result.detail));
      continue;
    }
    if (result.pdf !== undefined) {
      await putPdf(bucket, doi, result.pdf, { source: hop.source }, deps.now());
      attempts.push(attempt(hop.source, "hit", elapsed(deps, start)));
      return { status: "ok", doi, source: hop.source, size_bytes: result.pdf.byteLength, attempts };
    }
    // Text but no PDF: keep it for get_full_text, keep looking for a PDF.
    if (!textAvailable) {
      try {
        await storeHit(deps, doi, hop.source, result, false);
        textAvailable = true;
      } catch {
        // A text hit that cannot be stored is not worth failing get_pdf over.
      }
    }
    attempts.push(
      attempt(hop.source, TEXT_ONLY, elapsed(deps, start), `${result.format} text, no PDF`),
    );
  }
  return { status: "no_pdf", doi, text_available: textAvailable, attempts };
}
