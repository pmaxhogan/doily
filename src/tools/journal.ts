import { z } from "zod";

import { normalizeDoi } from "../ids.ts";
import {
  loadSjr,
  lookupPredatory,
  lookupSjr,
  sjrGenerated,
  type ListedOn,
} from "../lib/snapshots.ts";
import { normalizeIssn, uniq } from "../lib/text.ts";
import { getCrossrefWork } from "../providers/crossref.ts";
import {
  getOpenAlexSource,
  getOpenAlexWork,
  searchOpenAlexSources,
  stripOpenAlexUrl,
  workSourceId,
  type OaSourceFull,
} from "../providers/openalex.ts";
import { ToolError, type ToolDef } from "./types.ts";

import type { ProviderDeps } from "../providers/types.ts";

/**
 * get_journal: OpenAlex source stats plus the SJR and predatory-list
 * snapshots. The same block is embedded in get_paper as `journal`.
 */

export interface JournalBlock {
  name?: string;
  openalex_id?: string;
  issn_l?: string;
  issns: string[];
  publisher?: string;
  type?: string;
  homepage_url?: string;
  country?: string;
  impact: {
    /** OpenAlex's impact-factor proxy (mean citations of the last 2 years' works). */
    two_year_mean_citedness?: number;
    h_index?: number;
    i10_index?: number;
    works_count?: number;
    cited_by_count?: number;
  };
  open_access: { is_oa?: boolean; is_in_doaj?: boolean; apc_usd?: number | null };
  is_core?: boolean;
  listed_in?: string[];
  sjr: {
    sjr?: number;
    quartile?: string | null;
    h_index?: number;
    year?: number;
    issn: string;
  } | null;
  predatory: { listed_on: ListedOn[]; note: string };
  sources: { stats: string | null; sjr: string; predatory: string };
}

const PREDATORY_NOTE =
  "Evidence only: presence on a watch list (matched by ISSN or exact name) is not a verdict; absence proves nothing.";

/** Builds the journal block from whatever is known; OpenAlex fills in the rest. */
export async function buildJournalBlock(
  deps: ProviderDeps,
  hint: { openalexId?: string; issns?: (string | undefined)[]; name?: string; publisher?: string },
  preloaded?: OaSourceFull | null,
): Promise<JournalBlock> {
  let source: OaSourceFull | null = preloaded ?? null;
  const issnHints = uniq((hint.issns ?? []).map(normalizeIssn));
  if (!source && hint.openalexId)
    source = await getOpenAlexSource(deps, { openalex: hint.openalexId });
  if (!source) {
    for (const issn of issnHints) {
      source = await getOpenAlexSource(deps, { issn });
      if (source) break;
    }
  }
  const issns = uniq([
    normalizeIssn(source?.issn_l),
    ...(source?.issn ?? []).map(normalizeIssn),
    ...issnHints,
  ]);
  const name = source?.display_name ?? hint.name;
  const publisher = source?.host_organization_name ?? hint.publisher;
  const snapshot = await loadSjr(deps.env.PDFS);
  const sjr = lookupSjr(issns, snapshot);
  const generated = sjrGenerated(snapshot);
  return {
    name,
    openalex_id: stripOpenAlexUrl(source?.id),
    issn_l: normalizeIssn(source?.issn_l),
    issns,
    publisher,
    type: source?.type,
    homepage_url: source?.homepage_url,
    country: source?.country_code,
    impact: {
      two_year_mean_citedness: source?.summary_stats?.["2yr_mean_citedness"],
      h_index: source?.summary_stats?.h_index,
      i10_index: source?.summary_stats?.i10_index,
      works_count: source?.works_count,
      cited_by_count: source?.cited_by_count,
    },
    open_access: { is_oa: source?.is_oa, is_in_doaj: source?.is_in_doaj, apc_usd: source?.apc_usd },
    is_core: source?.is_core,
    listed_in: source?.listed_in,
    sjr: sjr
      ? {
          sjr: sjr.sjr,
          quartile: sjr.quartile,
          h_index: sjr.h_index,
          year: sjr.year,
          issn: sjr.issn,
        }
      : null,
    predatory: { listed_on: lookupPredatory({ issns, name, publisher }), note: PREDATORY_NOTE },
    sources: {
      stats: source ? "openalex" : null,
      sjr: generated ? `data/sjr.json (generated ${generated})` : "data/sjr.json (empty snapshot)",
      predatory: "data/predatory.json",
    },
  };
}

const ISSN_RE = /^\s*\d{4}-?\d{3}[\dXx]\s*$/;

export interface GetJournalArgs {
  issn_or_name_or_doi: string;
}

export async function getJournal(deps: ProviderDeps, args: GetJournalArgs): Promise<unknown> {
  const input = args.issn_or_name_or_doi.trim();
  if (!input) throw new ToolError("issn_or_name_or_doi is empty", { source: "get_journal" });

  if (ISSN_RE.test(input)) {
    const issn = normalizeIssn(input) as string;
    return buildJournalBlock(deps, { issns: [issn] });
  }

  const sid = /^(?:https?:\/\/openalex\.org\/)?(S\d+)$/i.exec(input);
  if (sid?.[1]) return buildJournalBlock(deps, { openalexId: sid[1].toUpperCase() });

  const doi = /10\.\d{4,9}\//.test(input) ? normalizeDoi(input) : undefined;
  if (doi) {
    const [work, crossref] = await Promise.allSettled([
      getOpenAlexWork(deps, { doi }),
      getCrossrefWork(deps, doi),
    ]);
    const w = work.status === "fulfilled" ? work.value : null;
    const c = crossref.status === "fulfilled" ? crossref.value : null;
    if (!w && !c) {
      throw new ToolError("no journal found for that DOI", { source: "get_journal", doi });
    }
    return buildJournalBlock(deps, {
      openalexId: w ? workSourceId(w) : undefined,
      issns: c?.record.issn ?? [],
      name: c?.container_title,
      publisher: c?.record.publisher,
    });
  }

  const hits = await searchOpenAlexSources(deps, input, 5);
  const [best, ...rest] = hits;
  if (!best) {
    // Still report snapshot evidence by exact name.
    const block = await buildJournalBlock(deps, { name: input });
    return { ...block, note: "OpenAlex found no source by that name" };
  }
  const block = await buildJournalBlock(deps, {}, best);
  return {
    ...block,
    other_matches: rest.map((s) => ({
      name: s.display_name,
      openalex_id: stripOpenAlexUrl(s.id),
      issn_l: s.issn_l,
      works_count: s.works_count,
    })),
  };
}

export const getJournalTool: ToolDef<GetJournalArgs> = {
  name: "get_journal",
  title: "Journal signals",
  description:
    "Journal quality signals: OpenAlex source stats (2yr_mean_citedness as the impact proxy, h-index, " +
    "DOAJ, is_core, listed_in, OA status, APC in USD), the SJR snapshot (sjr, quartile, year) and " +
    "predatory watch-list evidence as `listed_on` (never a verdict). Accepts an ISSN, an OpenAlex " +
    'source id (S...), a DOI of any paper in the journal, or a journal name. Example: {"issn_or_name_or_doi": "0028-0836"}',
  inputSchema: {
    issn_or_name_or_doi: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'ISSN ("0028-0836"), OpenAlex source id ("S137773608"), a paper DOI, or a journal name ("Nature")',
      ),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: (deps, args) => getJournal(deps, args),
};
