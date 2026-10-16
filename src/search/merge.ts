import { normalizeTitle, uniq } from "../lib/text.ts";
import { searchEuropePmc } from "../providers/europepmc.ts";
import { canSearch, searchOpenAlex } from "../providers/openalex.ts";
import { searchPubMed } from "../providers/pubmed.ts";
import { searchS2, searchS2Bulk } from "../providers/semanticscholar.ts";
import { ToolError } from "../tools/types.ts";
import { analyzeQuery } from "./query.ts";

import type { PaperAuthor, PaperRecord, ProviderDeps, ProviderName } from "../providers/types.ts";

/**
 * search_papers core: fan out to the search providers in parallel, dedup by
 * DOI, then PMID, then normalized title, merge fields preferring the richer
 * value, sort, and page.
 *
 * Paging: none of the providers share a paging model (Europe PMC uses a
 * cursor, OpenAlex pages, S2 offsets capped at 1000), so each provider is
 * asked for its first `offset + limit` hits (capped at FETCH_CAP) and the
 * merged list is sliced. Deep offsets therefore see fewer candidates.
 */

export type SearchSource = "europepmc" | "openalex" | "semanticscholar" | "pubmed";
export type SearchSort = "relevance" | "date" | "citations";

export const SEARCH_SOURCES: readonly SearchSource[] = [
  "europepmc",
  "openalex",
  "semanticscholar",
  "pubmed",
];
/** Relevance tie-break order and field-precedence order. */
const PROVIDER_ORDER: readonly ProviderName[] = [
  "europepmc",
  "openalex",
  "semanticscholar",
  "pubmed",
];
const FETCH_CAP = 200;
const S2_CAP = 100;
/** Titles shorter than this (normalized) are too generic to dedup on. */
const MIN_TITLE_KEY = 12;

export interface SearchOptions {
  query: string;
  fromYear?: number;
  toYear?: number;
  sort?: SearchSort;
  sources?: SearchSource[];
  limit?: number;
  offset?: number;
}

export interface MergedPaper extends Omit<PaperRecord, "source" | "rank"> {
  sources: ProviderName[];
  /** Best (lowest) provider rank of any source that returned it. */
  best_rank: number;
}

export interface ProviderStatus {
  status: "ok" | "error" | "skipped";
  hits?: number;
  total?: number;
  endpoint?: string;
  reason?: string;
  error?: string;
  http_status?: number;
}

export interface SearchOutcome {
  results: MergedPaper[];
  merged_total: number;
  providers: Partial<Record<SearchSource, ProviderStatus>>;
}

function orderOf(source: ProviderName): number {
  const i = PROVIDER_ORDER.indexOf(source);
  return i === -1 ? PROVIDER_ORDER.length : i;
}

function richerAuthors(
  a: PaperAuthor[] | undefined,
  b: PaperAuthor[] | undefined,
): PaperAuthor[] | undefined {
  if (!a?.length) return b?.length ? b : a;
  if (!b?.length) return a;
  if (b.length > a.length) return b;
  if (b.length === a.length) {
    const affA = a.filter((x) => x.affiliations?.length).length;
    const affB = b.filter((x) => x.affiliations?.length).length;
    if (affB > affA) return b;
  }
  return a;
}

const FIRST_WINS = [
  "doi",
  "pmid",
  "pmcid",
  "arxiv",
  "openalex_id",
  "s2_id",
  "title",
  "journal",
  "publisher",
  "volume",
  "issue",
  "pages",
  "year",
  "publication_date",
  "type",
  "oa_url",
  "pdf_url",
  "license",
] as const;

/** Merges `rec` into `into` in place. `into` holds the higher-precedence data. */
export function mergeInto(into: MergedPaper, rec: PaperRecord): void {
  const target = into as unknown as Record<string, unknown>;
  const source = rec as unknown as Record<string, unknown>;
  for (const key of FIRST_WINS) {
    if (target[key] === undefined && source[key] !== undefined && source[key] !== "")
      target[key] = source[key];
  }
  if (rec.abstract && (!into.abstract || rec.abstract.length > into.abstract.length))
    into.abstract = rec.abstract;
  into.authors = richerAuthors(into.authors, rec.authors);
  into.author_count =
    Math.max(into.author_count ?? 0, rec.author_count ?? 0, into.authors?.length ?? 0) || undefined;
  if (rec.citation_count !== undefined) {
    into.citation_count = Math.max(into.citation_count ?? 0, rec.citation_count);
  }
  // oa_status is an Unpaywall-style label; only OpenAlex and S2 emit one.
  if (!into.oa_status && rec.oa_status) into.oa_status = rec.oa_status;
  if (rec.is_oa) into.is_oa = true;
  else if (into.is_oa === undefined && rec.is_oa === false) into.is_oa = false;
  if (rec.is_retracted) into.is_retracted = true;
  if (rec.issn?.length) into.issn = uniq([...(into.issn ?? []), ...rec.issn]);
  if (rec.mesh?.length) into.mesh = uniq([...(into.mesh ?? []), ...rec.mesh]);
  if (!into.sources.includes(rec.source)) into.sources.push(rec.source);
  into.best_rank = Math.min(into.best_rank, rec.rank ?? Number.MAX_SAFE_INTEGER);
}

function emptyMerged(): MergedPaper {
  return { sources: [], best_rank: Number.MAX_SAFE_INTEGER };
}

function keysOf(rec: PaperRecord | MergedPaper): string[] {
  const keys: string[] = [];
  if (rec.doi) keys.push(`doi:${rec.doi.toLowerCase()}`);
  if (rec.pmid) keys.push(`pmid:${rec.pmid}`);
  const t = normalizeTitle(rec.title);
  if (t && t.length >= MIN_TITLE_KEY) keys.push(`title:${t}`);
  return keys;
}

/**
 * Dedups records from several providers. Records are visited in provider
 * order, so earlier providers win "first non-empty" fields. A record that
 * matches two existing groups (DOI in one, PMID in another) joins them.
 */
export function dedupMerge(records: PaperRecord[]): MergedPaper[] {
  const sorted = [...records].sort(
    (a, b) => orderOf(a.source) - orderOf(b.source) || (a.rank ?? 0) - (b.rank ?? 0),
  );
  const groups: (MergedPaper | null)[] = [];
  const index = new Map<string, number>();

  for (const rec of sorted) {
    const recKeys = keysOf(rec);
    const hits = uniq(recKeys.map((k) => index.get(k)));
    let target: number;
    if (hits.length === 0) {
      target = groups.length;
      groups.push(emptyMerged());
    } else {
      target = Math.min(...hits);
      for (const other of hits) {
        if (other === target) continue;
        const absorbed = groups[other];
        const into = groups[target];
        if (!absorbed || !into) continue;
        for (const src of absorbed.sources) {
          mergeInto(into, { ...absorbed, source: src, rank: absorbed.best_rank } as PaperRecord);
        }
        for (const k of keysOf(absorbed)) index.set(k, target);
        groups[other] = null;
      }
    }
    const group = groups[target] as MergedPaper;
    mergeInto(group, rec);
    for (const k of [...recKeys, ...keysOf(group)]) index.set(k, target);
  }
  return groups.filter((g): g is MergedPaper => g !== null);
}

function dateKey(p: MergedPaper): string {
  return p.publication_date ?? (p.year !== undefined ? String(p.year) : "");
}

export interface SortOptions {
  /**
   * Papers returned by this provider rank ahead of the rest, each group in
   * the requested order. Used for PubMed-syntax queries: PubMed applies the
   * field tags precisely, while the other providers only see the stripped
   * words and, under a citation sort, can push huge off-topic papers to the
   * top.
   */
  preferSource?: ProviderName;
}

export function sortMerged(
  papers: MergedPaper[],
  sort: SearchSort,
  opts: SortOptions = {},
): MergedPaper[] {
  if (opts.preferSource) {
    const preferred = papers.filter((p) => p.sources.includes(opts.preferSource as ProviderName));
    const rest = papers.filter((p) => !p.sources.includes(opts.preferSource as ProviderName));
    return [...sortMerged(preferred, sort), ...sortMerged(rest, sort)];
  }
  const out = [...papers];
  if (sort === "date") {
    out.sort((a, b) => dateKey(b).localeCompare(dateKey(a)) || a.best_rank - b.best_rank);
  } else if (sort === "citations") {
    out.sort(
      (a, b) => (b.citation_count ?? -1) - (a.citation_count ?? -1) || a.best_rank - b.best_rank,
    );
  } else {
    out.sort(
      (a, b) =>
        a.best_rank - b.best_rank ||
        b.sources.length - a.sources.length ||
        Math.min(...a.sources.map(orderOf)) - Math.min(...b.sources.map(orderOf)),
    );
  }
  return out;
}

function failure(err: unknown): ProviderStatus {
  if (err instanceof ToolError) {
    const status =
      typeof err.details["status"] === "number" ? (err.details["status"] as number) : undefined;
    return { status: "error", error: err.message, http_status: status || undefined };
  }
  return { status: "error", error: err instanceof Error ? err.message : String(err) };
}

/** Runs one search across providers. Never throws for a single provider failure. */
export async function searchPapers(
  deps: ProviderDeps,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const q = analyzeQuery(opts.query);
  if (!q.raw) throw new ToolError("query is empty", { source: "search" });
  const sort = opts.sort ?? "relevance";
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const want = Math.min(FETCH_CAP, offset + limit);
  const selected: SearchSource[] = opts.sources?.length
    ? SEARCH_SOURCES.filter((s) => opts.sources?.includes(s))
    : SEARCH_SOURCES.filter((s) => s !== "pubmed" || q.hasPubMedTags);
  const years = { fromYear: opts.fromYear, toYear: opts.toYear };

  const providers: Partial<Record<SearchSource, ProviderStatus>> = {};
  const tasks: {
    source: SearchSource;
    run: () => Promise<{ total: number; records: PaperRecord[] }>;
  }[] = [];

  for (const source of selected) {
    switch (source) {
      case "europepmc":
        if (!q.europepmc) {
          providers.europepmc = {
            status: "skipped",
            reason: "query empty after removing PubMed tags",
          };
          break;
        }
        tasks.push({
          source,
          run: () => searchEuropePmc(deps, { query: q.europepmc, pageSize: want, sort, ...years }),
        });
        break;
      case "openalex":
        if (!q.openalex) {
          providers.openalex = { status: "skipped", reason: "query empty after translation" };
          break;
        }
        tasks.push({
          source,
          run: async () => {
            if (!(await canSearch(deps))) {
              throw new ToolError("daily budget", { source: "openalex", skipped: true });
            }
            return searchOpenAlex(deps, { query: q.openalex, perPage: want, sort, ...years });
          },
        });
        break;
      case "semanticscholar": {
        // Bulk understands boolean syntax but is unranked, so it is only used
        // when the caller wants date or citation order; relevance ordering
        // uses /paper/search with operators stripped.
        const useBulk = q.isBoolean && sort !== "relevance";
        const text = useBulk ? q.s2Bulk : q.s2Plain;
        if (!text) {
          providers.semanticscholar = {
            status: "skipped",
            reason: "query empty after translation",
          };
          break;
        }
        tasks.push({
          source,
          run: async () => {
            const res = useBulk
              ? await searchS2Bulk(deps, {
                  query: text,
                  limit: Math.min(S2_CAP, want),
                  sort: sort === "date" ? "date" : "citations",
                  ...years,
                })
              : await searchS2(deps, { query: text, limit: Math.min(S2_CAP, want), ...years });
            providers.semanticscholar = { status: "ok", endpoint: useBulk ? "bulk" : "search" };
            return res;
          },
        });
        break;
      }
      case "pubmed":
        tasks.push({
          source,
          run: () =>
            searchPubMed(deps, {
              term: q.pubmed,
              retmax: want,
              sort: sort === "date" ? "pub_date" : "relevance",
              mindate: opts.fromYear,
              maxdate: opts.toYear,
            }),
        });
        break;
    }
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const all: PaperRecord[] = [];
  settled.forEach((result, i) => {
    const source = (tasks[i] as (typeof tasks)[number]).source;
    if (result.status === "fulfilled") {
      providers[source] = {
        ...providers[source],
        status: "ok",
        hits: result.value.records.length,
        total: result.value.total,
      };
      all.push(...result.value.records);
    } else if (result.reason instanceof ToolError && result.reason.details["skipped"]) {
      providers[source] = { status: "skipped", reason: "openalex daily budget nearly spent" };
    } else {
      providers[source] = failure(result.reason);
    }
  });

  const merged = sortMerged(dedupMerge(all), sort, {
    ...(q.hasPubMedTags ? { preferSource: "pubmed" as ProviderName } : {}),
  });
  return { results: merged.slice(offset, offset + limit), merged_total: merged.length, providers };
}
