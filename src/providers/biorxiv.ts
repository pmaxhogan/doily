import { fetchJsonRequired } from "../lib/http.ts";

import type { ProviderDeps } from "./types.ts";

/**
 * bioRxiv / medRxiv details API: versions, the JATS XML path and the DOI of
 * the published journal version. Both servers share CSHL's DOI prefixes
 * (10.1101 historically, 10.64898 for newer posts), so a lookup tries bioRxiv
 * first and medRxiv second unless the server is given.
 */

const BASE = "https://api.biorxiv.org/details";

export type PreprintServer = "biorxiv" | "medrxiv";

export interface PreprintVersion {
  version: string;
  date?: string;
  jatsxml?: string;
  license?: string;
  category?: string;
  type?: string;
}

export interface PreprintDetails {
  server: PreprintServer;
  doi: string;
  title?: string;
  versions: PreprintVersion[];
  latest: PreprintVersion;
  published_doi?: string;
  /** Direct PDF of the latest version (biorxiv.org/content/<doi>v<n>.full.pdf). */
  pdf_url: string;
}

interface RawItem {
  doi?: string;
  title?: string;
  version?: string;
  date?: string;
  jatsxml?: string;
  license?: string;
  category?: string;
  type?: string;
  published?: string;
  server?: string;
}

/** True for DOIs under the CSHL preprint prefixes. */
export function isPreprintDoi(doi: string): boolean {
  return /^10\.(1101|64898)\//i.test(doi);
}

export function parseBiorxivDetails(
  body: { collection?: RawItem[] },
  server: PreprintServer,
): PreprintDetails | null {
  const items = body.collection ?? [];
  if (items.length === 0) return null;
  const versions: PreprintVersion[] = items
    .map((i) => ({
      version: String(i.version ?? "1"),
      date: i.date,
      jatsxml: i.jatsxml || undefined,
      license: i.license,
      category: i.category,
      type: i.type,
    }))
    .sort((a, b) => Number(a.version) - Number(b.version));
  const latest = versions[versions.length - 1] as PreprintVersion;
  const last = items[items.length - 1] as RawItem;
  const published = items.map((i) => i.published).find((p) => p && p !== "NA");
  const doi = (last.doi ?? "").toLowerCase();
  const host = server === "medrxiv" ? "www.medrxiv.org" : "www.biorxiv.org";
  return {
    server,
    doi,
    title: last.title,
    versions,
    latest,
    published_doi: published?.toLowerCase(),
    pdf_url: `https://${host}/content/${doi}v${latest.version}.full.pdf`,
  };
}

/** Details for a preprint DOI, or null when neither server knows it. */
export async function getPreprintDetails(
  deps: ProviderDeps,
  doi: string,
  server?: PreprintServer,
): Promise<PreprintDetails | null> {
  const servers: PreprintServer[] = server ? [server] : ["biorxiv", "medrxiv"];
  for (const s of servers) {
    const { data } = await fetchJsonRequired<{ collection?: RawItem[] }>(deps, {
      source: "biorxiv",
      url: `${BASE}/${s}/${doi}`,
      bucket: "biorxiv",
    });
    const parsed = parseBiorxivDetails(data, s);
    if (parsed) return parsed;
  }
  return null;
}
