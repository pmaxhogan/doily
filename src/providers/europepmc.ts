import { fetchJsonRequired, fetchText, qs } from "../lib/http.ts";
import { cleanText, normalizeIssn, uniq, yearOf } from "../lib/text.ts";

import type { PaperAuthor, PaperRecord, ProviderDeps } from "./types.ts";

/**
 * Europe PMC REST: search (boolean AND/OR/NOT, fielded AUTH:/MESH:/SRC:PPR,
 * HAS_FT:y, OPEN_ACCESS:y all pass straight through) and the full-text JATS
 * endpoint the fulltext chain uses.
 */

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";

export type EuropePmcSort = "relevance" | "date" | "citations";

export interface EuropePmcSearchOptions {
  query: string;
  pageSize: number;
  sort?: EuropePmcSort;
  cursorMark?: string;
  fromYear?: number;
  toYear?: number;
}

interface EpmcAuthor {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  collectiveName?: string;
  authorId?: { type?: string; value?: string };
  authorAffiliationDetailsList?: { authorAffiliation?: { affiliation?: string }[] };
}

export interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authorList?: { author?: EpmcAuthor[] };
  journalInfo?: {
    issue?: string;
    volume?: string;
    dateOfPublication?: string;
    yearOfPublication?: number;
    printPublicationDate?: string;
    journal?: { title?: string; medlineAbbreviation?: string; issn?: string; essn?: string };
  };
  bookOrReportDetails?: { publisher?: string };
  pubYear?: string;
  pageInfo?: string;
  abstractText?: string;
  pubTypeList?: { pubType?: string[] };
  meshHeadingList?: { meshHeading?: { descriptorName?: string }[] };
  isOpenAccess?: string;
  inPMC?: string;
  inEPMC?: string;
  citedByCount?: number;
  firstPublicationDate?: string;
  license?: string;
}

interface EpmcResponse {
  hitCount?: number;
  nextCursorMark?: string;
  resultList?: { result?: EpmcResult[] };
}

function epmcAuthor(a: EpmcAuthor): PaperAuthor | undefined {
  const name =
    a.fullName ??
    a.collectiveName ??
    ([a.firstName, a.lastName].filter(Boolean).join(" ") || undefined);
  if (!name) return undefined;
  const affiliations = uniq(
    (a.authorAffiliationDetailsList?.authorAffiliation ?? []).map((x) => cleanText(x.affiliation)),
  );
  return {
    name,
    orcid: a.authorId?.type === "ORCID" ? a.authorId.value : undefined,
    affiliations: affiliations.length ? affiliations : undefined,
  };
}

/** The preferred publication type: skip MeSH-ish funding tags. */
function pickType(types: string[] | undefined): string | undefined {
  if (!types?.length) return undefined;
  const preferred = [
    "preprint",
    "review",
    "research-article",
    "journal article",
    "letter",
    "editorial",
  ];
  for (const p of preferred) {
    const hit = types.find((t) => t.toLowerCase() === p);
    if (hit) return hit;
  }
  return types.find((t) => !/^research support/i.test(t)) ?? types[0];
}

export function parseEuropePmcResult(r: EpmcResult): PaperRecord {
  const authorsFromList = (r.authorList?.author ?? [])
    .map(epmcAuthor)
    .filter((a): a is PaperAuthor => Boolean(a));
  const authorsFromString = (r.authorString ?? "")
    .replace(/\.$/, "")
    .split(/,\s*/)
    .filter(Boolean)
    .map((name) => ({ name }));
  const authors = authorsFromList.length ? authorsFromList : authorsFromString;
  const j = r.journalInfo;
  const mesh = uniq((r.meshHeadingList?.meshHeading ?? []).map((m) => m.descriptorName));
  const pmid = r.pmid ?? (r.source === "MED" ? r.id : undefined);
  return {
    source: "europepmc",
    doi: r.doi?.toLowerCase(),
    pmid,
    pmcid: r.pmcid?.toUpperCase(),
    title: cleanText(r.title)?.replace(/\.$/, ""),
    abstract: cleanText(r.abstractText),
    authors,
    author_count: authors.length || undefined,
    journal: cleanText(j?.journal?.title),
    issn: uniq([normalizeIssn(j?.journal?.issn), normalizeIssn(j?.journal?.essn)]),
    publisher: r.bookOrReportDetails?.publisher,
    volume: j?.volume,
    issue: j?.issue,
    pages: r.pageInfo,
    year: yearOf(r.pubYear) ?? yearOf(j?.yearOfPublication),
    publication_date: r.firstPublicationDate ?? j?.printPublicationDate,
    type: pickType(r.pubTypeList?.pubType),
    citation_count: typeof r.citedByCount === "number" ? r.citedByCount : undefined,
    // isOpenAccess "N" is common for papers that are free in PMC (author
    // manuscripts), so only a "Y" is evidence; inPMC is reported separately.
    is_oa: r.isOpenAccess === "Y" || r.inPMC === "Y" ? true : undefined,
    license: r.license,
    mesh: mesh.length ? mesh : undefined,
  };
}

export function parseEuropePmcSearch(body: EpmcResponse): {
  total: number;
  nextCursorMark?: string;
  records: PaperRecord[];
} {
  const results = body.resultList?.result ?? [];
  return {
    total: body.hitCount ?? results.length,
    nextCursorMark: body.nextCursorMark,
    records: results.map((r, rank) => ({ ...parseEuropePmcResult(r), rank })),
  };
}

/** Adds the year range as a PUB_YEAR clause; Europe PMC has no separate param. */
export function withYearRange(query: string, fromYear?: number, toYear?: number): string {
  if (fromYear === undefined && toYear === undefined) return query;
  const range = `PUB_YEAR:[${fromYear ?? 1800} TO ${toYear ?? 3000}]`;
  return `(${query}) AND ${range}`;
}

const SORTS: Record<EuropePmcSort, string | undefined> = {
  relevance: undefined,
  date: "P_PDATE_D desc",
  citations: "CITED desc",
};

export async function searchEuropePmc(
  deps: ProviderDeps,
  opts: EuropePmcSearchOptions,
): Promise<{ total: number; nextCursorMark?: string; records: PaperRecord[] }> {
  const url = `${BASE}/search?${qs({
    query: withYearRange(opts.query, opts.fromYear, opts.toYear),
    resultType: "core",
    format: "json",
    pageSize: Math.min(1000, Math.max(1, opts.pageSize)),
    cursorMark: opts.cursorMark ?? "*",
    sort: SORTS[opts.sort ?? "relevance"],
  })}`;
  const { data } = await fetchJsonRequired<EpmcResponse>(deps, {
    source: "europepmc",
    url,
    bucket: "europepmc",
  });
  return parseEuropePmcSearch(data);
}

/** One record by DOI, PMID or PMCID (first match wins), or null. */
export async function getEuropePmcRecord(
  deps: ProviderDeps,
  ids: { doi?: string; pmid?: string; pmcid?: string },
): Promise<PaperRecord | null> {
  let query: string | undefined;
  if (ids.pmid) query = `EXT_ID:${ids.pmid} AND SRC:MED`;
  else if (ids.pmcid) query = `PMCID:${ids.pmcid}`;
  else if (ids.doi) query = `DOI:"${ids.doi}"`;
  if (!query) return null;
  const { records } = await searchEuropePmc(deps, { query, pageSize: 1 });
  return records[0] ?? null;
}

/**
 * Full-text JATS XML for an open-access PMC article, or null when Europe PMC
 * has no full text for it (404). Used by the fulltext chain, hop 1.
 */
export async function fetchEuropePmcFullTextXml(
  deps: ProviderDeps,
  pmcid: string,
): Promise<string | null> {
  const id = pmcid.toUpperCase().startsWith("PMC") ? pmcid.toUpperCase() : `PMC${pmcid}`;
  if (!/^PMC\d+$/.test(id)) return null;
  const result = await fetchText(deps, {
    source: "europepmc",
    url: `${BASE}/${id}/fullTextXML`,
    bucket: "europepmc",
    headers: { Accept: "application/xml" },
    allowNotFound: true,
  });
  if (!result || !result.data.trim()) return null;
  return result.data;
}
