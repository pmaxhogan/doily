import { contactEmail, fetchJson, qs } from "../lib/http.ts";

import type { ProviderDeps } from "./types.ts";

/** Unpaywall: the best open-access copy for a DOI. `email=` is required. */

const BASE = "https://api.unpaywall.org/v2";

export interface OaLocationInfo {
  url?: string;
  url_for_pdf?: string;
  url_for_landing_page?: string;
  license?: string;
  version?: string;
  host_type?: string;
}

export interface UnpaywallRecord {
  doi: string;
  is_oa: boolean;
  oa_status?: string;
  best_oa_location?: OaLocationInfo;
  oa_locations: OaLocationInfo[];
  journal_is_in_doaj?: boolean;
  journal_is_oa?: boolean;
  genre?: string;
}

interface RawLocation {
  url?: string | null;
  url_for_pdf?: string | null;
  url_for_landing_page?: string | null;
  license?: string | null;
  version?: string | null;
  host_type?: string | null;
}

interface RawUnpaywall {
  doi?: string;
  is_oa?: boolean;
  oa_status?: string | null;
  best_oa_location?: RawLocation | null;
  oa_locations?: RawLocation[];
  journal_is_in_doaj?: boolean;
  journal_is_oa?: boolean;
  genre?: string;
}

function loc(l: RawLocation): OaLocationInfo {
  return {
    url: l.url ?? undefined,
    url_for_pdf: l.url_for_pdf ?? undefined,
    url_for_landing_page: l.url_for_landing_page ?? undefined,
    license: l.license ?? undefined,
    version: l.version ?? undefined,
    host_type: l.host_type ?? undefined,
  };
}

export function parseUnpaywall(body: RawUnpaywall): UnpaywallRecord {
  return {
    doi: (body.doi ?? "").toLowerCase(),
    is_oa: Boolean(body.is_oa),
    oa_status: body.oa_status ?? undefined,
    best_oa_location: body.best_oa_location ? loc(body.best_oa_location) : undefined,
    oa_locations: (body.oa_locations ?? []).map(loc),
    journal_is_in_doaj: body.journal_is_in_doaj,
    journal_is_oa: body.journal_is_oa,
    genre: body.genre,
  };
}

/** Unpaywall record for a DOI, or null when Unpaywall does not know it. */
export async function getUnpaywall(
  deps: ProviderDeps,
  doi: string,
): Promise<UnpaywallRecord | null> {
  const result = await fetchJson<RawUnpaywall>(deps, {
    source: "unpaywall",
    url: `${BASE}/${encodeURIComponent(doi).replace(/%2F/gi, "/")}?${qs({ email: contactEmail(deps.env) })}`,
    bucket: "unpaywall",
    allowNotFound: true,
  });
  return result ? parseUnpaywall(result.data) : null;
}
