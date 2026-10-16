import { z } from "zod";

import { truncate } from "../lib/text.ts";
import {
  SEARCH_SOURCES,
  searchPapers,
  type MergedPaper,
  type SearchSort,
  type SearchSource,
} from "../search/merge.ts";
import { ToolError, type ToolDef } from "./types.ts";

import type { ProviderDeps } from "../providers/types.ts";

/** search_papers (spec 3.1). */

const ABSTRACT_CHARS = 300;

export interface SearchPapersArgs {
  query: string;
  from_year?: number;
  to_year?: number;
  sort?: SearchSort;
  sources?: SearchSource[];
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  doi?: string;
  title?: string;
  authors: string[];
  author_count?: number;
  journal?: string;
  year?: number;
  pmid?: string;
  pmcid?: string;
  citation_count?: number;
  oa_status?: string;
  abstract?: string;
  sources: string[];
}

export function toHit(p: MergedPaper): SearchHit {
  const authors = (p.authors ?? []).slice(0, 3).map((a) => a.name);
  return {
    doi: p.doi,
    title: p.title,
    authors,
    author_count: p.author_count ?? p.authors?.length,
    journal: p.journal,
    year: p.year,
    pmid: p.pmid,
    pmcid: p.pmcid,
    citation_count: p.citation_count,
    oa_status:
      p.oa_status ??
      (p.is_oa === true ? "open (unclassified)" : p.is_oa === false ? "closed" : undefined),
    abstract: truncate(p.abstract, ABSTRACT_CHARS),
    sources: p.sources,
  };
}

export async function searchPapersTool(
  deps: ProviderDeps,
  args: SearchPapersArgs,
): Promise<unknown> {
  if (args.from_year !== undefined && args.to_year !== undefined && args.from_year > args.to_year) {
    throw new ToolError("from_year is after to_year", { source: "search_papers" });
  }
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const sort = args.sort ?? "relevance";
  const outcome = await searchPapers(deps, {
    query: args.query,
    fromYear: args.from_year,
    toYear: args.to_year,
    sort,
    sources: args.sources,
    limit,
    offset,
  });
  const anyOk = Object.values(outcome.providers).some((p) => p?.status === "ok");
  if (!anyOk) {
    throw new ToolError("every search provider failed", {
      source: "search_papers",
      providers: outcome.providers,
    });
  }
  return {
    query: args.query,
    sort,
    offset,
    limit,
    count: outcome.results.length,
    merged_candidates: outcome.merged_total,
    results: outcome.results.map(toHit),
    providers: outcome.providers,
  };
}

export const searchPapersToolDef: ToolDef<SearchPapersArgs> = {
  name: "search_papers",
  title: "Search papers",
  description:
    "Search the biomedical and general literature across Europe PMC, OpenAlex and Semantic Scholar in " +
    "parallel (plus PubMed when the query uses PubMed field tags like [mh] or [tiab]); results are " +
    "deduplicated by DOI, PMID and title and merged. Free text works everywhere; AND/OR/NOT, quoted " +
    "phrases and fielded terms (AUTH:, MESH:, SRC:PPR, OPEN_ACCESS:y) are passed to providers that " +
    "support them and stripped for the rest. Each hit has doi, title, first 3 authors + author_count, " +
    "journal, year, pmid, pmcid, citation_count, oa_status, a 300-char abstract and the providers that " +
    'returned it. Example: {"query": "CRISPR AND malaria", "from_year": 2020, "sort": "citations", "limit": 10}',
  inputSchema: {
    query: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        'Search query: free text, boolean (AND/OR/NOT, "quoted phrases"), or PubMed syntax ("malaria[mh] AND crispr[tiab]")',
      ),
    from_year: z
      .number()
      .int()
      .min(1800)
      .max(2100)
      .optional()
      .describe("Earliest publication year, inclusive"),
    to_year: z
      .number()
      .int()
      .min(1800)
      .max(2100)
      .optional()
      .describe("Latest publication year, inclusive"),
    sort: z
      .enum(["relevance", "date", "citations"])
      .optional()
      .describe(
        "Result order: relevance (default), date (newest first) or citations (most cited first)",
      ),
    sources: z
      .array(z.enum(SEARCH_SOURCES as [SearchSource, ...SearchSource[]]))
      .optional()
      .describe(
        "Restrict to these providers (europepmc, openalex, semanticscholar, pubmed); default all applicable",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results to return, 1-100 (default 20)"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(199)
      .optional()
      .describe(
        "Results to skip, for paging (default 0, max 199: each provider contributes at most its top 200 hits)",
      ),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: (deps, args) => searchPapersTool(deps, args),
};
