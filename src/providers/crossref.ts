import { contactEmail, fetchJson, qs } from "../lib/http.ts";
import { cleanText, dateFromParts, normalizeIssn, uniq } from "../lib/text.ts";

import type { PaperAuthor, PaperRecord, ProviderDeps } from "./types.ts";

/**
 * Crossref works: the metadata of record (title, container, ISSN, license,
 * TDM links) and editorial updates.
 *
 * Retractions show up two ways. The retracted article itself carries
 * `updated-by: [{type: "retraction", DOI: <notice>, source: "retraction-watch"
 * | "publisher"}]`; the notice carries `update-to: [{type, DOI: <article>}]`.
 * Both are parsed; `retraction.status` describes the article, and
 * `is_notice` is set when the looked-up DOI is itself the notice.
 */

const BASE = "https://api.crossref.org";

interface CrossrefUpdate {
  DOI?: string;
  type?: string;
  label?: string;
  source?: string;
  updated?: { "date-parts"?: number[][]; "date-time"?: string };
  "record-id"?: string;
}

export interface CrossrefMessage {
  DOI?: string;
  title?: string[];
  subtitle?: string[];
  "container-title"?: string[];
  "short-container-title"?: string[];
  ISSN?: string[];
  "issn-type"?: { value?: string; type?: string }[];
  publisher?: string;
  type?: string;
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
  author?: {
    given?: string;
    family?: string;
    name?: string;
    ORCID?: string;
    affiliation?: { name?: string }[];
  }[];
  license?: { URL?: string; "content-version"?: string; start?: { "date-time"?: string } }[];
  link?: {
    URL?: string;
    "content-type"?: string;
    "content-version"?: string;
    "intended-application"?: string;
  }[];
  "is-referenced-by-count"?: number;
  abstract?: string;
  "update-to"?: CrossrefUpdate[];
  "updated-by"?: CrossrefUpdate[];
  volume?: string;
  issue?: string;
  page?: string;
  URL?: string;
}

export interface UpdateNotice {
  type: string;
  label?: string;
  doi?: string;
  date?: string;
  source?: string;
}

export interface RetractionInfo {
  /** The worst update found on the article: retracted > expression_of_concern > corrected > none. */
  status: "retracted" | "expression_of_concern" | "corrected" | "withdrawn" | "none";
  /** True when the looked-up DOI is itself a retraction/correction notice. */
  is_notice: boolean;
  notices: UpdateNotice[];
}

export interface CrossrefWork {
  record: PaperRecord;
  container_title?: string;
  issn_print?: string;
  issn_electronic?: string;
  licenses: { url: string; content_version?: string; start?: string }[];
  tdm_links: { url: string; content_type?: string; content_version?: string }[];
  retraction: RetractionInfo;
}

function notice(u: CrossrefUpdate): UpdateNotice {
  return {
    type: (u.type ?? "unknown").toLowerCase(),
    label: u.label,
    doi: u.DOI?.toLowerCase(),
    date: u.updated?.["date-time"]?.slice(0, 10) ?? dateFromParts(u.updated?.["date-parts"]),
    source: u.source,
  };
}

const SEVERITY: Record<RetractionInfo["status"], number> = {
  none: 0,
  corrected: 1,
  expression_of_concern: 2,
  withdrawn: 3,
  retracted: 4,
};

function statusOf(type: string): RetractionInfo["status"] {
  if (type.includes("retraction") || type === "retracted") return "retracted";
  if (type.includes("withdraw") || type.includes("removal")) return "withdrawn";
  if (type.includes("concern")) return "expression_of_concern";
  if (type.includes("correct") || type.includes("erratum") || type.includes("corrigendum"))
    return "corrected";
  return "none";
}

export function parseRetraction(m: CrossrefMessage): RetractionInfo {
  const updatedBy = (m["updated-by"] ?? []).map(notice);
  const updateTo = (m["update-to"] ?? []).map(notice);
  let status: RetractionInfo["status"] = "none";
  for (const n of updatedBy) {
    const s = statusOf(n.type);
    if (SEVERITY[s] > SEVERITY[status]) status = s;
  }
  // A notice that points at itself (some publishers do this) also marks it.
  const self = m.DOI?.toLowerCase();
  const isNotice = updateTo.some((n) => n.doi && n.doi !== self);
  for (const n of updateTo) {
    if (n.doi === self) {
      const s = statusOf(n.type);
      if (SEVERITY[s] > SEVERITY[status]) status = s;
    }
  }
  return { status, is_notice: isNotice, notices: isNotice ? updateTo : updatedBy };
}

export function parseCrossrefWork(m: CrossrefMessage): CrossrefWork {
  const authors: PaperAuthor[] = (m.author ?? [])
    .map((a): PaperAuthor | undefined => {
      const name = a.name ?? [a.given, a.family].filter(Boolean).join(" ");
      if (!name) return undefined;
      const affiliations = uniq((a.affiliation ?? []).map((x) => cleanText(x.name)));
      return {
        name,
        orcid: a.ORCID?.replace(/^https?:\/\/orcid\.org\//i, ""),
        affiliations: affiliations.length ? affiliations : undefined,
      };
    })
    .filter((a): a is PaperAuthor => Boolean(a));
  const issnType = m["issn-type"] ?? [];
  const issnPrint = normalizeIssn(issnType.find((i) => i.type === "print")?.value);
  const issnElectronic = normalizeIssn(issnType.find((i) => i.type === "electronic")?.value);
  const date =
    dateFromParts(m.published?.["date-parts"]) ??
    dateFromParts(m["published-print"]?.["date-parts"]) ??
    dateFromParts(m["published-online"]?.["date-parts"]) ??
    dateFromParts(m.issued?.["date-parts"]);
  const retraction = parseRetraction(m);
  const title = cleanText([m.title?.[0], m.subtitle?.[0]].filter(Boolean).join(": "));
  const containerTitle = cleanText(m["container-title"]?.[0]);
  const tdm = (m.link ?? [])
    .filter((l) => l.URL)
    .map((l) => ({
      url: l.URL as string,
      content_type: l["content-type"],
      content_version: l["content-version"],
    }));
  const licenses = (m.license ?? [])
    .filter((l) => l.URL)
    .map((l) => ({
      url: l.URL as string,
      content_version: l["content-version"],
      start: l.start?.["date-time"]?.slice(0, 10),
    }));
  return {
    record: {
      source: "crossref",
      doi: m.DOI?.toLowerCase(),
      title,
      abstract: cleanText(m.abstract)?.replace(/^Abstract\s+/i, ""),
      authors,
      author_count: authors.length || undefined,
      journal: containerTitle,
      issn: uniq([issnPrint, issnElectronic, ...(m.ISSN ?? []).map(normalizeIssn)]),
      publisher: m.publisher,
      volume: m.volume,
      issue: m.issue,
      pages: m.page,
      year: date ? Number(date.slice(0, 4)) : undefined,
      publication_date: date,
      type: m.type,
      citation_count: m["is-referenced-by-count"],
      license: licenses.find((l) => l.content_version === "vor")?.url ?? licenses[0]?.url,
      is_retracted: retraction.status === "retracted" ? true : undefined,
    },
    container_title: containerTitle,
    issn_print: issnPrint,
    issn_electronic: issnElectronic,
    licenses,
    tdm_links: tdm,
    retraction,
  };
}

/** The work of record for a DOI, or null when Crossref does not know it. */
export async function getCrossrefWork(
  deps: ProviderDeps,
  doi: string,
): Promise<CrossrefWork | null> {
  const result = await fetchJson<{ message?: CrossrefMessage }>(deps, {
    source: "crossref",
    url: `${BASE}/works/${encodeURIComponent(doi).replace(/%2F/gi, "/")}?${qs({ mailto: contactEmail(deps.env) })}`,
    bucket: "crossref_single",
    allowNotFound: true,
  });
  if (!result?.data.message) return null;
  return parseCrossrefWork(result.data.message);
}
