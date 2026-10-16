import type { ToolDeps } from "../tools/types.ts";

/**
 * What a provider client needs. A subset of `ToolDeps`, so a tool handler can
 * pass its own `deps` straight through. `sleep` is injectable so rate-limit
 * waits and 429 back-off are instant under test; it defaults to setTimeout.
 */
export type ProviderDeps = Pick<ToolDeps, "fetch" | "env" | "now"> & {
  sleep?: (ms: number) => Promise<void>;
};

export type ProviderName =
  | "europepmc"
  | "openalex"
  | "semanticscholar"
  | "pubmed"
  | "crossref"
  | "unpaywall"
  | "core"
  | "biorxiv"
  | "ncbi_idconv";

export interface PaperAuthor {
  name: string;
  orcid?: string;
  affiliations?: string[];
}

/**
 * One provider's view of a paper, normalized. Every field is optional because
 * each upstream knows a different slice; `src/search/merge.ts` combines them.
 * DOIs are lowercase without a prefix; PMIDs and PMCIDs are strings.
 */
export interface PaperRecord {
  source: ProviderName;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxiv?: string;
  openalex_id?: string;
  s2_id?: string;
  title?: string;
  abstract?: string;
  authors?: PaperAuthor[];
  author_count?: number;
  journal?: string;
  issn?: string[];
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  year?: number;
  publication_date?: string;
  type?: string;
  citation_count?: number;
  is_oa?: boolean;
  oa_status?: string;
  oa_url?: string;
  pdf_url?: string;
  license?: string;
  mesh?: string[];
  is_retracted?: boolean;
  /** 0-based position in the provider's own result list (search only). */
  rank?: number;
}
