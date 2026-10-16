import { normalizeTitle } from "./lib/text.ts";
import { searchEuropePmc } from "./providers/europepmc.ts";
import { getOpenAlexWork, parseOpenAlexWork } from "./providers/openalex.ts";
import { convertIds } from "./providers/pubmed.ts";
import { matchS2Title } from "./providers/semanticscholar.ts";
import { ToolError } from "./tools/types.ts";

import type { ProviderDeps } from "./providers/types.ts";

/**
 * Paper identifiers: parse whatever the agent pastes (DOI in any dress, PMID,
 * PMCID, arXiv id, OpenAlex work id, or a URL containing one of those) and
 * resolve it to the doi/pmid/pmcid triple the providers need.
 */

export type IdKind = "doi" | "pmid" | "pmcid" | "arxiv" | "openalex" | "title";

export interface ParsedId {
  kind: IdKind;
  value: string;
}

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;

/** Drops trailing punctuation, keeping a closing paren only when balanced. */
function trimDoiTail(doi: string): string {
  let out = doi.replace(/[.,;:'"\]}>]+$/, "");
  while (out.endsWith(")")) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    out = out.slice(0, -1).replace(/[.,;:]+$/, "");
  }
  return out;
}

/**
 * Normalizes a DOI: strips `doi:` / `https://doi.org/` prefixes and trailing
 * punctuation, lowercases. Returns undefined when no DOI is present.
 */
export function normalizeDoi(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  let text = input.trim();
  try {
    if (/%2F/i.test(text)) text = decodeURIComponent(text);
  } catch {
    // Not percent-encoded after all; use as is.
  }
  const match = DOI_RE.exec(text);
  if (!match) return undefined;
  return trimDoiTail(match[0]).toLowerCase();
}

/** Cleans a DOI found in a URL path: drops viewer suffixes and preprint versions. */
function doiFromPath(path: string): string | undefined {
  const doi = normalizeDoi(path);
  if (!doi) return undefined;
  let out = doi
    .replace(/\.(pdf|full|abstract|html|xml)$/i, "")
    .replace(/\/(full|abstract|pdf|epdf|html|fulltext|meta|references|suppl)(\/.*)?$/i, "")
    .replace(/\.(full|abstract)$/i, "");
  // bioRxiv/medRxiv content URLs append the version: 10.1101/2020.03.22.002386v3
  if (/^10\.(1101|64898)\//.test(out)) out = out.replace(/v\d+$/, "");
  return out;
}

const ARXIV_NEW = /^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i;
const ARXIV_OLD = /^(?:arxiv:)?([a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;

function parseUrl(url: URL): ParsedId | undefined {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }

  if (host === "doi.org" || host === "dx.doi.org") {
    const doi = normalizeDoi(path);
    return doi ? { kind: "doi", value: doi } : undefined;
  }
  if (
    host === "pubmed.ncbi.nlm.nih.gov" ||
    (host === "ncbi.nlm.nih.gov" && path.startsWith("/pubmed"))
  ) {
    const m = /\/(\d{1,9})\/?$/.exec(path);
    if (m?.[1]) return { kind: "pmid", value: m[1] };
  }
  if (
    host.endsWith("ncbi.nlm.nih.gov") ||
    host === "europepmc.org" ||
    host.endsWith(".europepmc.org")
  ) {
    const pmc = /PMC\d+/i.exec(path);
    if (pmc) return { kind: "pmcid", value: pmc[0].toUpperCase() };
    const med = /\/(?:abstract|article)\/MED\/(\d{1,9})/i.exec(path);
    if (med?.[1]) return { kind: "pmid", value: med[1] };
  }
  if (host === "arxiv.org" || host === "export.arxiv.org") {
    const m = /\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/i.exec(path);
    if (m?.[1]) {
      const id = m[1].replace(/v\d+$/, "");
      if (ARXIV_NEW.test(id) || ARXIV_OLD.test(id)) return { kind: "arxiv", value: id };
    }
  }
  if (host === "openalex.org" || host === "api.openalex.org") {
    const m = /\/(W\d+)/i.exec(path);
    if (m?.[1]) return { kind: "openalex", value: m[1].toUpperCase() };
  }
  const doi = doiFromPath(path) ?? normalizeDoi(url.search);
  if (doi) return { kind: "doi", value: doi };
  return undefined;
}

/**
 * Classifies an identifier. Anything that is not recognizably an id (and is
 * not a URL) is treated as a title. Throws ToolError for an empty string or a
 * URL with no identifier in it.
 */
export function parseId(input: string): ParsedId {
  const text = input.trim();
  if (!text) throw new ToolError("empty identifier", { source: "ids" });

  if (/^https?:\/\//i.test(text) || /^(www\.)?(dx\.)?doi\.org\//i.test(text)) {
    let url: URL | undefined;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      url = undefined;
    }
    const parsed = url ? parseUrl(url) : undefined;
    if (parsed) return parsed;
    throw new ToolError("no DOI, PMID, PMCID or arXiv id found in the URL", { source: "ids" });
  }

  const pmid = /^(?:pmid:?\s*)?(\d{1,9})$/i.exec(text);
  if (pmid?.[1]) return { kind: "pmid", value: pmid[1] };

  const pmcid = /^(?:pmcid:?\s*)?(PMC\d+)$/i.exec(text);
  if (pmcid?.[1]) return { kind: "pmcid", value: pmcid[1].toUpperCase() };

  const arxivNew = ARXIV_NEW.exec(text);
  if (arxivNew?.[1]) return { kind: "arxiv", value: arxivNew[1] };
  const arxivOld = ARXIV_OLD.exec(text);
  if (arxivOld?.[1]) return { kind: "arxiv", value: arxivOld[1].toLowerCase() };

  const openalex = /^(W\d{4,})$/i.exec(text);
  if (openalex?.[1]) return { kind: "openalex", value: openalex[1].toUpperCase() };

  if (/^(doi:\s*)?10\.\d{4,9}\//i.test(text)) {
    const doi = normalizeDoi(text);
    if (doi) return { kind: "doi", value: doi };
  }

  return { kind: "title", value: text };
}

export interface ResolvedIds {
  input: ParsedId;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxiv?: string;
  openalex?: string;
  /** Which services filled in the ids, in order. */
  resolved_via: string[];
}

/** The DataCite DOI arXiv mints for every paper. */
export function arxivDoi(id: string): string {
  return `10.48550/arxiv.${id.toLowerCase()}`;
}

/**
 * Fills in doi/pmid/pmcid for any identifier. PMIDs and PMCIDs go through the
 * NCBI converter (falling back to OpenAlex), DOIs pick up PMID/PMCID from the
 * converter when NCBI knows them, arXiv ids map to their DataCite DOI, and
 * bare titles go to Semantic Scholar title match. Upstream failures are
 * swallowed: whatever was parsed is still returned.
 */
export async function resolveIds(deps: ProviderDeps, id: string | ParsedId): Promise<ResolvedIds> {
  const input = typeof id === "string" ? parseId(id) : id;
  const out: ResolvedIds = { input, resolved_via: [] };
  switch (input.kind) {
    case "doi":
      out.doi = input.value;
      break;
    case "pmid":
      out.pmid = input.value;
      break;
    case "pmcid":
      out.pmcid = input.value;
      break;
    case "arxiv":
      out.arxiv = input.value;
      out.doi = arxivDoi(input.value);
      break;
    case "openalex":
      out.openalex = input.value;
      break;
    case "title":
      break;
  }

  if (input.kind === "title") {
    try {
      const hit = await matchS2Title(deps, input.value);
      if (hit) {
        out.doi = hit.doi;
        out.pmid = hit.pmid;
        out.pmcid = hit.pmcid;
        out.arxiv = hit.arxiv;
        out.resolved_via.push("semanticscholar");
      }
    } catch {
      // Try Europe PMC below.
    }
    if (!out.doi && !out.pmid) {
      // S2 match is spelling-strict ("Nanometre-scale" misses "Nanometer
      // scale"); Europe PMC title search is free and catches many of those.
      try {
        const want = normalizeTitle(input.value);
        const phrase = input.value.replace(/"/g, " ").trim();
        const { records } = await searchEuropePmc(deps, {
          query: `TITLE:"${phrase}"`,
          pageSize: 3,
        });
        const hit = records.find((r) => want && normalizeTitle(r.title) === want);
        if (hit) {
          out.doi = hit.doi;
          out.pmid = hit.pmid;
          out.pmcid = hit.pmcid;
          out.resolved_via.push("europepmc");
        }
      } catch {
        // Unresolved titles are reported by the caller.
      }
    }
    if (!out.doi && !out.pmid) return out;
  }

  if (input.kind === "openalex") {
    try {
      const work = await getOpenAlexWork(deps, { openalex: input.value });
      if (work) {
        const rec = parseOpenAlexWork(work);
        out.doi = rec.doi;
        out.pmid = rec.pmid;
        out.pmcid = rec.pmcid;
        out.resolved_via.push("openalex");
      }
    } catch {
      // Keep what we have.
    }
  }

  const key = out.pmcid ?? out.pmid ?? (input.kind !== "arxiv" ? out.doi : undefined);
  if (key && (!out.doi || !out.pmid || !out.pmcid)) {
    try {
      const [rec] = await convertIds(deps, [key]);
      if (rec && (rec.doi || rec.pmid || rec.pmcid)) {
        out.doi ??= rec.doi;
        out.pmid ??= rec.pmid;
        out.pmcid ??= rec.pmcid;
        out.resolved_via.push("ncbi_idconv");
      }
    } catch {
      // Fall through to OpenAlex below.
    }
  }

  if (!out.doi && (out.pmid || out.pmcid)) {
    try {
      const work = await getOpenAlexWork(deps, {
        pmid: out.pmid,
        pmcid: out.pmid ? undefined : out.pmcid,
      });
      if (work) {
        const rec = parseOpenAlexWork(work);
        out.doi ??= rec.doi;
        out.pmid ??= rec.pmid;
        out.pmcid ??= rec.pmcid;
        out.resolved_via.push("openalex");
      }
    } catch {
      // Keep what we have.
    }
  }
  return out;
}
