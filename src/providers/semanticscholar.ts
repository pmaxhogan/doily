import { fetchJson, fetchJsonRequired, qs } from "../lib/http.ts";
import { cleanText } from "../lib/text.ts";

import type { PaperAuthor, PaperRecord, ProviderDeps } from "./types.ts";

/**
 * Semantic Scholar Graph API: relevance search (plain text only), bulk search
 * (boolean syntax, unranked), single-paper lookup and title match.
 * `x-api-key` is sent only when S2_API_KEY is set.
 */

const BASE = "https://api.semanticscholar.org/graph/v1";
export const S2_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "year",
  "venue",
  "publicationDate",
  "authors",
  "citationCount",
  "openAccessPdf",
  "isOpenAccess",
  "publicationTypes",
  "journal",
].join(",");

export interface S2Paper {
  paperId?: string;
  externalIds?: Record<string, string | number | undefined> | null;
  title?: string | null;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  publicationDate?: string | null;
  authors?: { authorId?: string | null; name?: string | null }[];
  citationCount?: number | null;
  isOpenAccess?: boolean | null;
  openAccessPdf?: { url?: string | null; status?: string | null; license?: string | null } | null;
  publicationTypes?: string[] | null;
  journal?: { name?: string | null; volume?: string | null; pages?: string | null } | null;
}

function headers(deps: ProviderDeps): Record<string, string> {
  return deps.env.S2_API_KEY ? { "x-api-key": deps.env.S2_API_KEY } : {};
}

export function parseS2Paper(p: S2Paper): PaperRecord {
  const ext = p.externalIds ?? {};
  const str = (v: string | number | undefined) =>
    v === undefined || v === null ? undefined : String(v);
  const pmc = str(ext["PubMedCentral"]);
  const authors: PaperAuthor[] = (p.authors ?? [])
    .filter((a) => a.name)
    .map((a) => ({ name: a.name as string }));
  const pdf = p.openAccessPdf?.url || undefined;
  const status = p.openAccessPdf?.status?.toLowerCase() || undefined;
  return {
    source: "semanticscholar",
    s2_id: p.paperId,
    doi: str(ext["DOI"])?.toLowerCase(),
    pmid: str(ext["PubMed"]),
    pmcid: pmc ? `PMC${pmc.replace(/^PMC/i, "")}` : undefined,
    arxiv: str(ext["ArXiv"]),
    title: cleanText(p.title),
    abstract: cleanText(p.abstract),
    authors,
    author_count: authors.length || undefined,
    journal: cleanText(p.journal?.name) ?? cleanText(p.venue),
    volume: p.journal?.volume?.trim() || undefined,
    pages: p.journal?.pages?.replace(/\s+/g, "") || undefined,
    year: p.year ?? undefined,
    publication_date: p.publicationDate ?? undefined,
    type: p.publicationTypes?.[0],
    citation_count: p.citationCount ?? undefined,
    is_oa: p.isOpenAccess ?? (pdf ? true : undefined),
    oa_status: status,
    pdf_url: pdf,
    license: p.openAccessPdf?.license ?? undefined,
  };
}

export interface S2SearchOptions {
  query: string;
  limit: number;
  offset?: number;
  fromYear?: number;
  toYear?: number;
}

function yearParam(fromYear?: number, toYear?: number): string | undefined {
  if (fromYear === undefined && toYear === undefined) return undefined;
  return `${fromYear ?? ""}-${toYear ?? ""}`;
}

interface S2List {
  total?: number;
  offset?: number;
  next?: number;
  token?: string | null;
  data?: S2Paper[];
}

export function parseS2List(
  body: S2List,
  limit?: number,
): { total: number; records: PaperRecord[] } {
  const data = limit === undefined ? (body.data ?? []) : (body.data ?? []).slice(0, limit);
  return {
    total: body.total ?? data.length,
    records: data.map((p, rank) => ({ ...parseS2Paper(p), rank })),
  };
}

/** Relevance-ranked search. Plain text only; boolean operators are not parsed. */
export async function searchS2(
  deps: ProviderDeps,
  opts: S2SearchOptions,
): Promise<{ total: number; records: PaperRecord[] }> {
  const limit = Math.min(100, Math.max(1, opts.limit));
  const offset = Math.min(Math.max(0, opts.offset ?? 0), 999 - limit);
  const url = `${BASE}/paper/search?${qs({
    query: opts.query,
    limit,
    offset: offset > 0 ? offset : undefined,
    year: yearParam(opts.fromYear, opts.toYear),
    fields: S2_FIELDS,
  })}`;
  const { data } = await fetchJsonRequired<S2List>(deps, {
    source: "semanticscholar",
    url,
    bucket: "s2",
    headers: headers(deps),
    secrets: [deps.env.S2_API_KEY],
  });
  return parseS2List(data);
}

export type S2BulkSort = "citations" | "date";

/**
 * Bulk search: supports `+ | - "phrase" * ( ) ~N` but is unranked (and
 * returns up to 1000 rows regardless of `limit`, so the result is sliced).
 * Only used when the caller asked for date or citation order.
 */
export async function searchS2Bulk(
  deps: ProviderDeps,
  opts: S2SearchOptions & { sort?: S2BulkSort },
): Promise<{ total: number; records: PaperRecord[] }> {
  const sort =
    opts.sort === "citations"
      ? "citationCount:desc"
      : opts.sort === "date"
        ? "publicationDate:desc"
        : undefined;
  const url = `${BASE}/paper/search/bulk?${qs({
    query: opts.query,
    year: yearParam(opts.fromYear, opts.toYear),
    sort,
    fields: S2_FIELDS,
  })}`;
  const { data } = await fetchJsonRequired<S2List>(deps, {
    source: "semanticscholar",
    url,
    bucket: "s2",
    headers: headers(deps),
    secrets: [deps.env.S2_API_KEY],
  });
  const offset = opts.offset ?? 0;
  const sliced = { ...data, data: (data.data ?? []).slice(offset, offset + opts.limit) };
  return parseS2List(sliced);
}

/**
 * One paper. `id` is an S2 paper id or a prefixed external id such as
 * `DOI:10.1038/nature12373`, `PMID:23903748`, `PMCID:4221854`, `ARXIV:1304.1068`.
 */
export async function getS2Paper(deps: ProviderDeps, id: string): Promise<PaperRecord | null> {
  const result = await fetchJson<S2Paper>(deps, {
    source: "semanticscholar",
    url: `${BASE}/paper/${encodeURIComponent(id).replace(/%3A/gi, ":").replace(/%2F/gi, "/")}?${qs({ fields: S2_FIELDS })}`,
    bucket: "s2",
    headers: headers(deps),
    allowNotFound: true,
    secrets: [deps.env.S2_API_KEY],
  });
  return result ? parseS2Paper(result.data) : null;
}

/** Best title match, or null when S2 has none (it answers 404). */
export async function matchS2Title(deps: ProviderDeps, title: string): Promise<PaperRecord | null> {
  const result = await fetchJson<S2List & S2Paper>(deps, {
    source: "semanticscholar",
    url: `${BASE}/paper/search/match?${qs({ query: title, fields: S2_FIELDS })}`,
    bucket: "s2",
    headers: headers(deps),
    allowNotFound: true,
    secrets: [deps.env.S2_API_KEY],
  });
  if (!result) return null;
  // The match endpoint wraps its single hit in `data: [...]`.
  const hit = result.data.data?.[0] ?? (result.data.paperId ? result.data : undefined);
  return hit ? parseS2Paper(hit) : null;
}

/** The S2 lookup key for whatever ids are known, best first. */
export function s2LookupId(ids: {
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxiv?: string;
}): string | undefined {
  if (ids.doi) return `DOI:${ids.doi}`;
  if (ids.pmid) return `PMID:${ids.pmid}`;
  if (ids.pmcid) return `PMCID:${ids.pmcid.replace(/^PMC/i, "")}`;
  if (ids.arxiv) return `ARXIV:${ids.arxiv}`;
  return undefined;
}
