import { z } from "zod";

import { resolveIds, type ResolvedIds } from "../ids.ts";
import { compact, uniq } from "../lib/text.ts";
import { getPreprintDetails, isPreprintDoi, type PreprintDetails } from "../providers/biorxiv.ts";
import { getCrossrefWork, type CrossrefWork, type RetractionInfo } from "../providers/crossref.ts";
import { getEuropePmcRecord } from "../providers/europepmc.ts";
import {
  getOpenAlexWork,
  parseOpenAlexWork,
  workSourceId,
  type OaWork,
} from "../providers/openalex.ts";
import { getS2Paper, s2LookupId } from "../providers/semanticscholar.ts";
import { getUnpaywall, type UnpaywallRecord } from "../providers/unpaywall.ts";
import { buildJournalBlock, type JournalBlock } from "./journal.ts";
import { ToolError, type ToolDef } from "./types.ts";

import type { PaperAuthor, PaperRecord, ProviderDeps, ProviderName } from "../providers/types.ts";

/**
 * get_paper (spec 3.2): metadata merged from Crossref (record of truth for
 * bibliographic fields and retractions), Europe PMC (abstract, MeSH),
 * OpenAlex (authors with affiliations, OA, venue), Semantic Scholar
 * (citations, OA PDF) and Unpaywall (OA status and locations). Each field
 * group reports the provider it came from in `field_sources`.
 */

export interface GetPaperArgs {
  id: string;
}

type UpstreamStatus = "ok" | "not_found" | "skipped" | { error: string; status?: number };

interface Gathered {
  crossref: CrossrefWork | null;
  europepmc: PaperRecord | null;
  openalexWork: OaWork | null;
  openalex: PaperRecord | null;
  semanticscholar: PaperRecord | null;
  unpaywall: UnpaywallRecord | null;
  biorxiv: PreprintDetails | null;
  upstream: Record<string, UpstreamStatus>;
}

function statusOf(result: PromiseSettledResult<unknown>): UpstreamStatus {
  if (result.status === "fulfilled") return result.value ? "ok" : "not_found";
  const err = result.reason as { message?: string; details?: Record<string, unknown> };
  const status =
    typeof err?.details?.["status"] === "number" ? (err.details["status"] as number) : undefined;
  return { error: err?.message ?? String(result.reason), status: status || undefined };
}

function valueOf<T>(result: PromiseSettledResult<T | null>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

async function gather(deps: ProviderDeps, ids: ResolvedIds): Promise<Gathered> {
  const none = Promise.resolve(null);
  const s2Id = s2LookupId(ids);
  const [crossref, europepmc, openalex, s2, unpaywall, biorxiv] = await Promise.allSettled([
    ids.doi ? getCrossrefWork(deps, ids.doi) : none,
    getEuropePmcRecord(deps, { doi: ids.doi, pmid: ids.pmid, pmcid: ids.pmcid }),
    getOpenAlexWork(deps, {
      doi: ids.doi,
      pmid: ids.pmid,
      pmcid: ids.pmcid,
      openalex: ids.openalex,
    }),
    s2Id ? getS2Paper(deps, s2Id) : none,
    ids.doi ? getUnpaywall(deps, ids.doi) : none,
    ids.doi && isPreprintDoi(ids.doi) ? getPreprintDetails(deps, ids.doi) : none,
  ]);
  const work = valueOf(openalex);
  const upstream: Record<string, UpstreamStatus> = {
    crossref: ids.doi ? statusOf(crossref) : "skipped",
    europepmc: statusOf(europepmc),
    openalex: statusOf(openalex),
    semanticscholar: s2Id ? statusOf(s2) : "skipped",
    unpaywall: ids.doi ? statusOf(unpaywall) : "skipped",
  };
  if (ids.doi && isPreprintDoi(ids.doi)) upstream["biorxiv"] = statusOf(biorxiv);
  return {
    crossref: valueOf(crossref),
    europepmc: valueOf(europepmc),
    openalexWork: work,
    openalex: work ? parseOpenAlexWork(work) : null,
    semanticscholar: valueOf(s2),
    unpaywall: valueOf(unpaywall),
    biorxiv: valueOf(biorxiv),
    upstream,
  };
}

type Field = keyof PaperRecord;

/** First defined value of `field` across records in the given order. */
function first<K extends Field>(
  records: (PaperRecord | null | undefined)[],
  field: K,
): { value?: PaperRecord[K]; source?: ProviderName } {
  for (const r of records) {
    const v = r?.[field];
    if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) {
      return { value: v, source: r?.source };
    }
  }
  return {};
}

function longest(
  records: (PaperRecord | null | undefined)[],
  field: "abstract",
): { value?: string; source?: ProviderName } {
  let best: { value?: string; source?: ProviderName } = {};
  for (const r of records) {
    const v = r?.[field];
    if (v && (!best.value || v.length > best.value.length)) best = { value: v, source: r?.source };
  }
  return best;
}

/** Richest author list: most authors, then most affiliations, then ORCIDs. */
function richestAuthors(records: (PaperRecord | null | undefined)[]): {
  value?: PaperAuthor[];
  source?: ProviderName;
} {
  let best: { value?: PaperAuthor[]; source?: ProviderName; score: number } = { score: -1 };
  for (const r of records) {
    const list = r?.authors;
    if (!list?.length) continue;
    const score =
      list.length * 100 +
      list.filter((a) => a.affiliations?.length).length * 10 +
      list.filter((a) => a.orcid).length;
    if (score > best.score) best = { value: list, source: r?.source, score };
  }
  return { value: best.value, source: best.source };
}

export interface PaperResult {
  ids: Record<string, string | undefined>;
  title?: string;
  abstract?: string;
  authors?: PaperAuthor[];
  author_count?: number;
  venue: Record<string, unknown>;
  publication_date?: string;
  year?: number;
  type?: string;
  open_access: Record<string, unknown>;
  citation_count?: number;
  citation_counts: Partial<Record<ProviderName, number>>;
  mesh?: string[];
  retraction: RetractionInfo & { openalex_is_retracted?: boolean };
  preprint?: Record<string, unknown>;
  journal: JournalBlock | null;
  field_sources: Record<string, string | string[] | undefined>;
  upstream: Record<string, UpstreamStatus>;
}

export function assemblePaper(
  ids: ResolvedIds,
  g: Gathered,
  journal: JournalBlock | null,
): PaperResult {
  const cr = g.crossref?.record ?? null;
  const ep = g.europepmc;
  const oa = g.openalex;
  const s2 = g.semanticscholar;
  const bibliographic = [cr, ep, oa, s2];

  const title = first(bibliographic, "title");
  const abstract = longest([ep, cr, oa, s2], "abstract");
  const authors = richestAuthors([oa, ep, cr, s2]);
  const date = first([cr, oa, ep, s2], "publication_date");
  const year = first([cr, oa, ep, s2], "year");
  const type = first([cr, oa, ep, s2], "type");
  const mesh = first([ep, oa], "mesh");
  const journalName = first(bibliographic, "journal");

  const citationCounts: Partial<Record<ProviderName, number>> = {};
  for (const r of [oa, s2, cr, ep]) {
    if (r?.citation_count !== undefined) citationCounts[r.source] = r.citation_count;
  }
  const counts = Object.values(citationCounts);

  const up = g.unpaywall;
  const best = up?.best_oa_location;
  const oaStatus = up?.oa_status ?? oa?.oa_status ?? s2?.oa_status;
  const openAccess = compact({
    is_oa: up?.is_oa ?? oa?.is_oa ?? s2?.is_oa ?? ep?.is_oa,
    oa_status: oaStatus,
    best_url: best?.url ?? oa?.oa_url ?? s2?.pdf_url,
    pdf_url: best?.url_for_pdf ?? oa?.pdf_url ?? s2?.pdf_url ?? g.biorxiv?.pdf_url,
    landing_page_url: best?.url_for_landing_page,
    license: best?.license ?? oa?.license ?? cr?.license,
    version: best?.version,
    host_type: best?.host_type,
    in_pmc: Boolean(ids.pmcid ?? ep?.pmcid ?? oa?.pmcid) || undefined,
    locations: up?.oa_locations.slice(0, 5),
    tdm_links: g.crossref?.tdm_links.length ? g.crossref.tdm_links : undefined,
  });
  const oaSource: ProviderName | undefined = up
    ? "unpaywall"
    : oa?.oa_status
      ? "openalex"
      : s2?.oa_status
        ? "semanticscholar"
        : undefined;

  const retraction: PaperResult["retraction"] = {
    ...(g.crossref?.retraction ?? { status: "none", is_notice: false, notices: [] }),
    openalex_is_retracted: oa?.is_retracted,
  };
  if (retraction.status === "none" && oa?.is_retracted) retraction.status = "retracted";

  const idsOut = compact({
    doi: ids.doi ?? first(bibliographic, "doi").value,
    pmid: ids.pmid ?? first([ep, oa, s2], "pmid").value,
    pmcid: ids.pmcid ?? first([ep, oa, s2], "pmcid").value,
    arxiv: ids.arxiv ?? s2?.arxiv,
    openalex: oa?.openalex_id,
    s2: s2?.s2_id,
  });

  const preprint = g.biorxiv
    ? compact({
        server: g.biorxiv.server,
        latest_version: g.biorxiv.latest.version,
        latest_date: g.biorxiv.latest.date,
        jatsxml: g.biorxiv.latest.jatsxml,
        pdf_url: g.biorxiv.pdf_url,
        published_doi: g.biorxiv.published_doi,
        category: g.biorxiv.latest.category,
      })
    : undefined;

  return {
    ids: idsOut,
    title: title.value,
    abstract: abstract.value,
    authors: authors.value,
    author_count:
      Math.max(...[cr, ep, oa, s2].map((r) => r?.author_count ?? 0), authors.value?.length ?? 0) ||
      undefined,
    venue: compact({
      name: journalName.value,
      issn: uniq([...(cr?.issn ?? []), ...(oa?.issn ?? []), ...(ep?.issn ?? [])]),
      publisher: first([cr, oa, ep], "publisher").value,
      volume: first([cr, ep, oa, s2], "volume").value,
      issue: first([cr, ep, oa], "issue").value,
      pages: first([cr, ep, oa, s2], "pages").value,
    }),
    publication_date: date.value,
    year: year.value,
    type: type.value,
    open_access: openAccess,
    citation_count: counts.length ? Math.max(...counts) : undefined,
    citation_counts: citationCounts,
    mesh: mesh.value,
    retraction,
    preprint,
    journal,
    field_sources: compact({
      ids: uniq<string>([
        ...ids.resolved_via,
        ...[cr, ep, oa, s2].filter(Boolean).map((r) => (r as PaperRecord).source),
      ]),
      title: title.source,
      abstract: abstract.source,
      authors: authors.source,
      venue: journalName.source,
      publication_date: date.source,
      type: type.source,
      open_access: oaSource,
      citation_count: "max of citation_counts",
      mesh: mesh.source,
      retraction: g.crossref ? "crossref" : oa ? "openalex" : undefined,
      preprint: g.biorxiv ? "biorxiv" : undefined,
      journal: journal?.sources.stats ?? undefined,
    }),
    upstream: g.upstream,
  };
}

export async function getPaper(deps: ProviderDeps, args: GetPaperArgs): Promise<PaperResult> {
  const ids = await resolveIds(deps, args.id);
  if (!ids.doi && !ids.pmid && !ids.pmcid && !ids.openalex) {
    throw new ToolError(
      ids.input.kind === "title"
        ? "no paper matched that title (Semantic Scholar and Europe PMC title match)"
        : "could not resolve that identifier",
      { source: "get_paper", kind: ids.input.kind },
    );
  }
  const g = await gather(deps, ids);
  if (!g.crossref && !g.europepmc && !g.openalex && !g.semanticscholar && !g.unpaywall) {
    throw new ToolError("no provider knows this paper", {
      source: "get_paper",
      upstream: g.upstream,
    });
  }
  const cr = g.crossref?.record;
  let journal: JournalBlock | null = null;
  const sourceId = g.openalexWork ? workSourceId(g.openalexWork) : undefined;
  const issns = uniq([
    ...(cr?.issn ?? []),
    ...(g.openalex?.issn ?? []),
    ...(g.europepmc?.issn ?? []),
  ]);
  if (sourceId || issns.length) {
    try {
      journal = await buildJournalBlock(deps, {
        openalexId: sourceId,
        issns,
        name: cr?.journal ?? g.openalex?.journal ?? g.europepmc?.journal,
        publisher: cr?.publisher,
      });
    } catch (err) {
      g.upstream["openalex_source"] = statusOf({ status: "rejected", reason: err });
    }
  }
  return assemblePaper(ids, g, journal);
}

export const getPaperTool: ToolDef<GetPaperArgs> = {
  name: "get_paper",
  title: "Paper metadata",
  description:
    "Full metadata for one paper: ids (DOI, PMID, PMCID, arXiv, OpenAlex, S2), title, full abstract, " +
    "all authors with affiliations and ORCIDs, venue, publication date, type, open-access status and " +
    "links, citation counts, MeSH terms, retraction/correction status (Crossref updates incl. " +
    "Retraction Watch), preprint versions, and an inline `journal` block identical to get_journal. " +
    "`field_sources` names the provider behind each field. The id can be a DOI, PMID, PMCID, arXiv id, " +
    'a URL containing one, or a title. Example: {"id": "10.1038/nature12373"}',
  inputSchema: {
    id: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        'DOI ("10.1038/nature12373", "https://doi.org/..."), PMID ("23903748"), PMCID ("PMC4221854"), ' +
          'arXiv id ("1304.1068"), a URL containing one, or an exact paper title',
      ),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: (deps, args) => getPaper(deps, args),
};
