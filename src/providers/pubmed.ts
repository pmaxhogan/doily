import { contactEmail, fetchJsonRequired, fetchText, qs } from "../lib/http.ts";
import { cleanText, normalizeIssn, uniq, yearOf } from "../lib/text.ts";

import type { PaperRecord, ProviderDeps } from "./types.ts";

/**
 * NCBI E-utilities (PubMed esearch/esummary/efetch) and the PMC ID converter.
 * Only NCBI APIs; pmc.ncbi.nlm.nih.gov HTML is never scraped.
 */

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const IDCONV = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";

function ncbiParams(deps: ProviderDeps): Record<string, string | undefined> {
  return {
    tool: "doily",
    email: contactEmail(deps.env),
    api_key: deps.env.NCBI_API_KEY || undefined,
  };
}

export interface EsearchOptions {
  term: string;
  retmax: number;
  retstart?: number;
  sort?: "relevance" | "pub_date";
  mindate?: number;
  maxdate?: number;
}

export interface EsearchResult {
  count: number;
  ids: string[];
}

interface EsearchResponse {
  esearchresult?: { count?: string; idlist?: string[]; ERROR?: string };
}

export function parseEsearch(body: EsearchResponse): EsearchResult {
  const r = body.esearchresult ?? {};
  return { count: Number(r.count ?? 0) || 0, ids: (r.idlist ?? []).map(String) };
}

export async function esearchPubMed(
  deps: ProviderDeps,
  opts: EsearchOptions,
): Promise<EsearchResult> {
  const dates =
    opts.mindate !== undefined || opts.maxdate !== undefined
      ? {
          datetype: "pdat",
          mindate: String(opts.mindate ?? 1800),
          maxdate: String(opts.maxdate ?? 3000),
        }
      : {};
  const url = `${EUTILS}/esearch.fcgi?${qs({
    db: "pubmed",
    term: opts.term,
    retmode: "json",
    usehistory: "n",
    retmax: opts.retmax,
    retstart: opts.retstart,
    sort: opts.sort,
    ...dates,
    ...ncbiParams(deps),
  })}`;
  const { data } = await fetchJsonRequired<EsearchResponse>(deps, {
    source: "pubmed",
    url,
    bucket: "ncbi",
    secrets: [deps.env.NCBI_API_KEY],
  });
  return parseEsearch(data);
}

interface EsummaryDoc {
  uid?: string;
  pubdate?: string;
  epubdate?: string;
  source?: string;
  fulljournalname?: string;
  authors?: { name?: string; authtype?: string }[];
  title?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  essn?: string;
  pubtype?: string[];
  articleids?: { idtype?: string; value?: string }[];
  sortpubdate?: string;
}

interface EsummaryResponse {
  result?: { uids?: string[] } & Record<string, unknown>;
}

export function parseEsummaryDoc(doc: EsummaryDoc): PaperRecord {
  const idOf = (type: string) => doc.articleids?.find((a) => a.idtype === type)?.value;
  const pmcRaw = idOf("pmc") ?? idOf("pmcid");
  const pmcid = pmcRaw ? /PMC\d+/i.exec(pmcRaw)?.[0]?.toUpperCase() : undefined;
  const authors = (doc.authors ?? [])
    .filter((a) => a.name)
    .map((a) => ({ name: a.name as string }));
  const date = doc.sortpubdate ? doc.sortpubdate.slice(0, 10).replace(/\//g, "-") : undefined;
  return {
    source: "pubmed",
    pmid: doc.uid,
    doi: idOf("doi")?.toLowerCase(),
    pmcid,
    title: cleanText(doc.title),
    authors,
    author_count: authors.length,
    journal: cleanText(doc.fulljournalname) ?? cleanText(doc.source),
    issn: uniq([normalizeIssn(doc.issn), normalizeIssn(doc.essn)]),
    volume: doc.volume || undefined,
    issue: doc.issue || undefined,
    pages: doc.pages || undefined,
    year: yearOf(doc.pubdate) ?? yearOf(doc.epubdate),
    publication_date: date,
    type: doc.pubtype?.[0],
  };
}

export function parseEsummary(body: EsummaryResponse): PaperRecord[] {
  const result = body.result;
  if (!result) return [];
  return (result.uids ?? [])
    .map((uid) => result[uid] as EsummaryDoc | undefined)
    .filter((d): d is EsummaryDoc => Boolean(d && !("error" in d)))
    .map(parseEsummaryDoc);
}

export async function esummaryPubMed(deps: ProviderDeps, ids: string[]): Promise<PaperRecord[]> {
  if (ids.length === 0) return [];
  const url = `${EUTILS}/esummary.fcgi?${qs({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
    ...ncbiParams(deps),
  })}`;
  const { data } = await fetchJsonRequired<EsummaryResponse>(deps, {
    source: "pubmed",
    url,
    bucket: "ncbi",
    secrets: [deps.env.NCBI_API_KEY],
  });
  const byId = new Map(parseEsummary(data).map((r) => [r.pmid, r]));
  // esummary does not promise input order; restore it so ranks stay meaningful.
  return ids.map((id) => byId.get(id)).filter((r): r is PaperRecord => Boolean(r));
}

/** esearch + esummary, ranks assigned in esearch order. */
export async function searchPubMed(
  deps: ProviderDeps,
  opts: EsearchOptions,
): Promise<{ total: number; records: PaperRecord[] }> {
  const found = await esearchPubMed(deps, opts);
  const records = await esummaryPubMed(deps, found.ids);
  return { total: found.count, records: records.map((r, rank) => ({ ...r, rank })) };
}

/** efetch raw text (PubMed XML by default, or db=pmc JATS for the fulltext chain). */
export async function efetch(
  deps: ProviderDeps,
  ids: string[],
  opts: { db?: "pubmed" | "pmc"; rettype?: string; retmode?: string } = {},
): Promise<string> {
  const url = `${EUTILS}/efetch.fcgi?${qs({
    db: opts.db ?? "pubmed",
    id: ids.join(","),
    rettype: opts.rettype,
    retmode: opts.retmode ?? "xml",
    ...ncbiParams(deps),
  })}`;
  const result = await fetchText(deps, {
    source: "pubmed",
    url,
    bucket: "ncbi",
    secrets: [deps.env.NCBI_API_KEY],
  });
  return result?.data ?? "";
}

export interface ConvertedIds {
  requested: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
}

interface IdconvResponse {
  status?: string;
  records?: {
    "requested-id"?: string;
    doi?: string;
    pmid?: string | number;
    pmcid?: string;
    status?: string;
    errmsg?: string;
  }[];
}

export function parseIdconv(body: IdconvResponse): ConvertedIds[] {
  return (body.records ?? [])
    .filter((r) => r.status !== "error")
    .map((r) => ({
      requested: String(r["requested-id"] ?? ""),
      doi: r.doi ? r.doi.toLowerCase() : undefined,
      pmid: r.pmid !== undefined && r.pmid !== null && r.pmid !== "" ? String(r.pmid) : undefined,
      pmcid: r.pmcid ? r.pmcid.toUpperCase() : undefined,
    }));
}

/** PMC ID converter: any mix of PMIDs, PMCIDs and DOIs, up to 200 per call. */
export async function convertIds(deps: ProviderDeps, ids: string[]): Promise<ConvertedIds[]> {
  if (ids.length === 0) return [];
  const out: ConvertedIds[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const url = `${IDCONV}?${qs({
      ids: ids.slice(i, i + 200).join(","),
      format: "json",
      // The converter is not an E-utility; it takes tool/email but no api_key.
      tool: "doily",
      email: contactEmail(deps.env),
    })}`;
    const { data } = await fetchJsonRequired<IdconvResponse>(deps, {
      source: "ncbi_idconv",
      url,
      bucket: "ncbi",
    });
    out.push(...parseIdconv(data));
  }
  return out;
}
