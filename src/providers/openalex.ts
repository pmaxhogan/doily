import { encodeDoiPath, fetchJson, qs, type HttpResult } from "../lib/http.ts";
import { cleanText, invertAbstract, normalizeIssn, uniq } from "../lib/text.ts";
import { ToolError } from "../tools/types.ts";

import type { Env } from "../env.ts";
import type { PaperAuthor, PaperRecord, ProviderDeps } from "./types.ts";

/**
 * OpenAlex works, authors and sources.
 *
 * OpenAlex is metered in USD per call. Singleton lookups (`/works/<id>`,
 * `/sources/issn:...`) cost 0; list/search calls cost about $0.001. Unkeyed
 * calls share $0.10/day per egress IP, keyed calls get $1.00/day. Spend is
 * read from the `X-RateLimit-Cost-USD` header (falling back to
 * `meta.cost_usd`), accumulated per UTC day in KV `openalex:spend:<day>`, and
 * keyword searches stop at 90% of the budget. When the response also carries
 * `X-RateLimit-Remaining-USD` the tracker takes the larger of the two views,
 * since the unkeyed budget is shared with everyone on the same egress IP.
 */

const BASE = "https://api.openalex.org";
const BUDGET_UNKEYED = 0.1;
const BUDGET_KEYED = 1.0;
const CUTOFF = 0.9;

export function dailyBudgetUsd(env: Partial<Env>): number {
  return env.OPENALEX_API_KEY ? BUDGET_KEYED : BUDGET_UNKEYED;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const memorySpend = new Map<string, number>();

/** Test hook. */
export function resetOpenAlexSpend(): void {
  memorySpend.clear();
}

function kvOf(deps: ProviderDeps): KVNamespace | undefined {
  const kv = (deps.env as Partial<Env>).DOILY_KV;
  return kv && typeof kv.get === "function" ? kv : undefined;
}

export async function getSpend(deps: ProviderDeps): Promise<number> {
  const key = `openalex:spend:${utcDay(deps.now())}`;
  const mem = memorySpend.get(key) ?? 0;
  const kv = kvOf(deps);
  if (!kv) return mem;
  try {
    const stored = Number(await kv.get(key));
    return Math.max(mem, Number.isFinite(stored) ? stored : 0);
  } catch {
    return mem;
  }
}

/** Records a call's cost; `remainingUsd` (from the header) can only raise spend. */
export async function addSpend(
  deps: ProviderDeps,
  cost: number,
  remainingUsd?: number,
): Promise<number> {
  const key = `openalex:spend:${utcDay(deps.now())}`;
  const budget = dailyBudgetUsd(deps.env);
  const before = await getSpend(deps);
  let spend = before + (Number.isFinite(cost) ? cost : 0);
  if (remainingUsd !== undefined && Number.isFinite(remainingUsd)) {
    spend = Math.max(spend, budget - remainingUsd);
  }
  memorySpend.set(key, spend);
  const kv = kvOf(deps);
  // Persist any raise, including one derived only from the remaining header.
  if (kv && spend > before) {
    try {
      await kv.put(key, String(spend), { expirationTtl: 2 * 86400 });
    } catch {
      // Best effort; the in-memory copy still protects this isolate.
    }
  }
  return spend;
}

/** False once today's spend reaches 90% of the budget (keyword searches only). */
export async function canSearch(deps: ProviderDeps): Promise<boolean> {
  // Epsilon so float noise (0.9 * 0.1 = 0.09000000000000001) cannot let 90% through.
  return (await getSpend(deps)) < CUTOFF * dailyBudgetUsd(deps.env) - 1e-9;
}

async function track(deps: ProviderDeps, result: HttpResult<unknown>): Promise<void> {
  const header = result.headers.get("X-RateLimit-Cost-USD");
  const meta = (result.data as { meta?: { cost_usd?: number } } | null)?.meta;
  const cost = header !== null && header !== "" ? Number(header) : Number(meta?.cost_usd ?? 0);
  const remainingHeader = result.headers.get("X-RateLimit-Remaining-USD");
  const remaining =
    remainingHeader !== null && remainingHeader !== "" ? Number(remainingHeader) : undefined;
  if (cost > 0 || remaining !== undefined) await addSpend(deps, cost, remaining);
}

function withKey(deps: ProviderDeps, params: Record<string, string | number | undefined>): string {
  return qs({ ...params, api_key: deps.env.OPENALEX_API_KEY || undefined });
}

async function get<T>(
  deps: ProviderDeps,
  path: string,
  params: Record<string, string | number | undefined>,
  allowNotFound: boolean,
): Promise<T | null> {
  const query = withKey(deps, params);
  const result = await fetchJson<T>(deps, {
    source: "openalex",
    url: `${BASE}${path}${query ? `?${query}` : ""}`,
    bucket: "openalex",
    allowNotFound,
    secrets: [deps.env.OPENALEX_API_KEY],
  });
  if (!result) return null;
  await track(deps, result);
  return result.data;
}

async function assertBudget(deps: ProviderDeps): Promise<void> {
  if (!(await canSearch(deps))) {
    throw new ToolError("openalex daily budget nearly spent; keyword search skipped", {
      source: "openalex",
      status: 0,
      budget_usd: dailyBudgetUsd(deps.env),
    });
  }
}

/* ---------------------------------------------------------------- works */

export interface OaSource {
  id?: string;
  display_name?: string;
  issn_l?: string;
  issn?: string[];
  is_oa?: boolean;
  is_in_doaj?: boolean;
  is_core?: boolean;
  host_organization_name?: string;
  type?: string;
}

export interface OaLocation {
  is_oa?: boolean;
  landing_page_url?: string;
  pdf_url?: string;
  license?: string;
  version?: string;
  source?: OaSource | null;
}

export interface OaWork {
  id?: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  publication_date?: string;
  ids?: { openalex?: string; doi?: string; pmid?: string; pmcid?: string; mag?: string };
  type?: string;
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string };
  cited_by_count?: number;
  biblio?: { volume?: string; issue?: string; first_page?: string; last_page?: string };
  is_retracted?: boolean;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: OaLocation | null;
  best_oa_location?: OaLocation | null;
  locations?: OaLocation[];
  authorships?: {
    author?: { id?: string; display_name?: string; orcid?: string | null };
    institutions?: { display_name?: string }[];
    raw_author_name?: string;
    raw_affiliation_strings?: string[];
  }[];
  mesh?: { descriptor_ui?: string; descriptor_name?: string; qualifier_ui?: string | null }[];
  topics?: { display_name?: string }[];
}

export function stripDoiUrl(doi: string | null | undefined): string | undefined {
  if (!doi) return undefined;
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
}

function stripOpenAlexUrl(id: string | null | undefined): string | undefined {
  return id ? id.replace(/^https?:\/\/openalex\.org\//i, "") : undefined;
}

function stripOrcid(orcid: string | null | undefined): string | undefined {
  return orcid ? orcid.replace(/^https?:\/\/orcid\.org\//i, "") : undefined;
}

export function parseOpenAlexWork(w: OaWork): PaperRecord {
  const authors: PaperAuthor[] = (w.authorships ?? [])
    .map((a): PaperAuthor | undefined => {
      const name = a.author?.display_name ?? a.raw_author_name;
      if (!name) return undefined;
      const affiliations = uniq([
        ...(a.raw_affiliation_strings ?? []).map((s) => cleanText(s)),
        ...((a.raw_affiliation_strings?.length ? [] : a.institutions) ?? []).map(
          (i) => i.display_name,
        ),
      ]);
      return {
        name,
        orcid: stripOrcid(a.author?.orcid),
        affiliations: affiliations.length ? affiliations : undefined,
      };
    })
    .filter((a): a is PaperAuthor => Boolean(a));
  const pmid = w.ids?.pmid
    ?.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, "")
    .replace(/\/$/, "");
  const pmcid = w.ids?.pmcid ? /PMC\d+/i.exec(w.ids.pmcid)?.[0]?.toUpperCase() : undefined;
  const source = w.primary_location?.source ?? undefined;
  const meshSeen = new Set<string>();
  const mesh: string[] = [];
  for (const m of w.mesh ?? []) {
    const key = `${m.descriptor_ui ?? m.descriptor_name}|${m.qualifier_ui ?? ""}`;
    if (meshSeen.has(key) || !m.descriptor_name) continue;
    meshSeen.add(key);
    if (!mesh.includes(m.descriptor_name)) mesh.push(m.descriptor_name);
  }
  const b = w.biblio;
  const pages = b?.first_page
    ? b.last_page
      ? `${b.first_page}-${b.last_page}`
      : b.first_page
    : undefined;
  const best = w.best_oa_location ?? undefined;
  return {
    source: "openalex",
    openalex_id: stripOpenAlexUrl(w.id),
    doi: stripDoiUrl(w.doi ?? w.ids?.doi),
    pmid: pmid || undefined,
    pmcid,
    title: cleanText(w.title ?? w.display_name),
    abstract: invertAbstract(w.abstract_inverted_index),
    authors,
    author_count: authors.length || undefined,
    journal: cleanText(source?.display_name),
    issn: uniq([normalizeIssn(source?.issn_l), ...(source?.issn ?? []).map(normalizeIssn)]),
    publisher: source?.host_organization_name,
    volume: b?.volume ?? undefined,
    issue: b?.issue ?? undefined,
    pages,
    year: w.publication_year ?? undefined,
    publication_date: w.publication_date ?? undefined,
    type: w.type,
    citation_count: w.cited_by_count,
    is_oa: w.open_access?.is_oa,
    oa_status: w.open_access?.oa_status,
    oa_url: w.open_access?.oa_url ?? best?.landing_page_url ?? undefined,
    pdf_url: best?.pdf_url ?? undefined,
    license: best?.license ?? undefined,
    mesh: mesh.length ? mesh : undefined,
    is_retracted: w.is_retracted,
  };
}

/** The OpenAlex source id (S...) of a work's primary venue, if any. */
export function workSourceId(w: OaWork): string | undefined {
  return stripOpenAlexUrl(w.primary_location?.source?.id);
}

const WORK_SELECT = [
  "id",
  "doi",
  "title",
  "display_name",
  "publication_year",
  "publication_date",
  "ids",
  "type",
  "open_access",
  "cited_by_count",
  "biblio",
  "is_retracted",
  "abstract_inverted_index",
  "primary_location",
  "best_oa_location",
  "authorships",
].join(",");

export type OpenAlexSort = "relevance" | "date" | "citations";

export interface OpenAlexSearchOptions {
  query: string;
  perPage: number;
  page?: number;
  sort?: OpenAlexSort;
  fromYear?: number;
  toYear?: number;
}

interface OaList<T> {
  meta?: { count?: number; cost_usd?: number };
  results?: T[];
}

export function parseOpenAlexSearch(body: OaList<OaWork>): {
  total: number;
  records: PaperRecord[];
} {
  const results = body.results ?? [];
  return {
    total: body.meta?.count ?? results.length,
    records: results.map((w, rank) => ({ ...parseOpenAlexWork(w), rank })),
  };
}

function yearFilter(fromYear?: number, toYear?: number): string | undefined {
  if (fromYear === undefined && toYear === undefined) return undefined;
  if (fromYear !== undefined && toYear !== undefined)
    return `publication_year:${fromYear}-${toYear}`;
  if (fromYear !== undefined) return `publication_year:>${fromYear - 1}`;
  return `publication_year:<${(toYear as number) + 1}`;
}

const OA_SORTS: Record<OpenAlexSort, string | undefined> = {
  relevance: undefined,
  date: "publication_date:desc",
  citations: "cited_by_count:desc",
};

/** Keyword search over works. Throws ToolError when the daily budget is spent. */
export async function searchOpenAlex(
  deps: ProviderDeps,
  opts: OpenAlexSearchOptions,
): Promise<{ total: number; records: PaperRecord[] }> {
  await assertBudget(deps);
  const body = await get<OaList<OaWork>>(
    deps,
    "/works",
    {
      // Plain `search=` also matches full text and ranks noisy hits first;
      // title+abstract search costs the same and ranks far better.
      "search.title_and_abstract": opts.query,
      filter: yearFilter(opts.fromYear, opts.toYear),
      "per-page": Math.min(200, Math.max(1, opts.perPage)),
      page: opts.page,
      sort: OA_SORTS[opts.sort ?? "relevance"],
      select: WORK_SELECT,
    },
    false,
  );
  return parseOpenAlexSearch(body ?? {});
}

/** One work by DOI, PMID, PMCID or OpenAlex id (free singleton lookups). */
export async function getOpenAlexWork(
  deps: ProviderDeps,
  ids: { doi?: string; pmid?: string; pmcid?: string; openalex?: string },
): Promise<OaWork | null> {
  let path: string | undefined;
  if (ids.openalex) path = `/works/${encodeURIComponent(ids.openalex)}`;
  else if (ids.doi) path = `/works/https://doi.org/${encodeDoiPath(ids.doi)}`;
  else if (ids.pmid) path = `/works/pmid:${encodeURIComponent(ids.pmid)}`;
  else if (ids.pmcid) path = `/works/pmcid:${encodeURIComponent(ids.pmcid)}`;
  if (!path) return null;
  return get<OaWork>(deps, path, { select: `${WORK_SELECT},mesh,topics` }, true);
}

/* -------------------------------------------------------------- authors */

export interface OaAuthor {
  id?: string;
  orcid?: string | null;
  display_name?: string;
  works_count?: number;
  cited_by_count?: number;
  summary_stats?: { "2yr_mean_citedness"?: number; h_index?: number; i10_index?: number };
  last_known_institutions?: { id?: string; display_name?: string; country_code?: string }[];
  affiliations?: {
    institution?: { id?: string; display_name?: string; country_code?: string };
    years?: number[];
  }[];
  topics?: { id?: string; display_name?: string; count?: number }[];
}

export interface AuthorProfile {
  openalex_id?: string;
  name?: string;
  orcid?: string;
  works_count?: number;
  cited_by_count?: number;
  h_index?: number;
  i10_index?: number;
  two_year_mean_citedness?: number;
  last_known_institutions: { name?: string; country?: string }[];
  affiliations: { name?: string; country?: string; years?: number[] }[];
  top_topics: { name?: string; works?: number }[];
}

export function parseOpenAlexAuthor(a: OaAuthor): AuthorProfile {
  return {
    openalex_id: stripOpenAlexUrl(a.id),
    name: a.display_name,
    orcid: stripOrcid(a.orcid),
    works_count: a.works_count,
    cited_by_count: a.cited_by_count,
    h_index: a.summary_stats?.h_index,
    i10_index: a.summary_stats?.i10_index,
    two_year_mean_citedness: a.summary_stats?.["2yr_mean_citedness"],
    last_known_institutions: (a.last_known_institutions ?? []).map((i) => ({
      name: i.display_name,
      country: i.country_code,
    })),
    affiliations: (a.affiliations ?? []).slice(0, 10).map((x) => ({
      name: x.institution?.display_name,
      country: x.institution?.country_code,
      years: x.years?.length ? [Math.min(...x.years), Math.max(...x.years)] : undefined,
    })),
    top_topics: (a.topics ?? []).slice(0, 5).map((t) => ({ name: t.display_name, works: t.count })),
  };
}

/** Author by OpenAlex id (A...) or ORCID; free singleton lookup. */
export async function getOpenAlexAuthor(
  deps: ProviderDeps,
  ids: { openalex?: string; orcid?: string },
): Promise<OaAuthor | null> {
  let path: string | undefined;
  if (ids.openalex) path = `/authors/${encodeURIComponent(ids.openalex)}`;
  else if (ids.orcid) path = `/authors/orcid:${encodeURIComponent(ids.orcid)}`;
  if (!path) return null;
  return get<OaAuthor>(deps, path, {}, true);
}

/** Author name search (metered like any search, so it respects the budget). */
export async function searchOpenAlexAuthors(
  deps: ProviderDeps,
  name: string,
  perPage = 5,
): Promise<OaAuthor[]> {
  await assertBudget(deps);
  const body = await get<OaList<OaAuthor>>(
    deps,
    "/authors",
    { search: name, "per-page": perPage },
    false,
  );
  return body?.results ?? [];
}

/* -------------------------------------------------------------- sources */

export interface OaSourceFull {
  id?: string;
  issn_l?: string;
  issn?: string[];
  display_name?: string;
  host_organization_name?: string;
  works_count?: number;
  cited_by_count?: number;
  summary_stats?: { "2yr_mean_citedness"?: number; h_index?: number; i10_index?: number };
  is_oa?: boolean;
  is_in_doaj?: boolean;
  is_core?: boolean;
  listed_in?: string[];
  homepage_url?: string;
  apc_usd?: number | null;
  country_code?: string;
  type?: string;
}

/** Source by OpenAlex id (S...) or ISSN; free singleton lookup. */
export async function getOpenAlexSource(
  deps: ProviderDeps,
  ids: { openalex?: string; issn?: string },
): Promise<OaSourceFull | null> {
  let path: string | undefined;
  if (ids.openalex) path = `/sources/${encodeURIComponent(ids.openalex)}`;
  else if (ids.issn) path = `/sources/issn:${encodeURIComponent(ids.issn)}`;
  if (!path) return null;
  return get<OaSourceFull>(deps, path, {}, true);
}

/** Journal name search (metered; respects the budget). */
export async function searchOpenAlexSources(
  deps: ProviderDeps,
  name: string,
  perPage = 5,
): Promise<OaSourceFull[]> {
  await assertBudget(deps);
  const body = await get<OaList<OaSourceFull>>(
    deps,
    "/sources",
    { search: name, "per-page": perPage },
    false,
  );
  return body?.results ?? [];
}

export { stripOpenAlexUrl, stripOrcid };
