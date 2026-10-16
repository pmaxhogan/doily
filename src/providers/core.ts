import { fetchJsonRequired, qs } from "../lib/http.ts";

import type { ProviderDeps } from "./types.ts";

/**
 * CORE v3 (aggregated repository copies). Needs CORE_API_KEY; with no key
 * every function returns null without making a request.
 */

const BASE = "https://api.core.ac.uk/v3";

export interface CoreOutput {
  id?: string;
  title?: string;
  doi?: string;
  download_url?: string;
  full_text?: string;
}

interface RawCoreOutput {
  id?: number | string;
  title?: string;
  doi?: string | null;
  downloadUrl?: string | null;
  fullText?: string | null;
}

export function parseCoreSearch(body: { results?: RawCoreOutput[] }): CoreOutput[] {
  return (body.results ?? []).map((r) => ({
    id: r.id === undefined ? undefined : String(r.id),
    title: r.title,
    doi: r.doi?.toLowerCase() ?? undefined,
    download_url: r.downloadUrl || undefined,
    full_text: r.fullText || undefined,
  }));
}

/** First CORE output for a DOI that has a download URL or full text, or null. */
export async function searchCoreByDoi(deps: ProviderDeps, doi: string): Promise<CoreOutput | null> {
  const key = deps.env.CORE_API_KEY;
  if (!key) return null;
  const { data } = await fetchJsonRequired<{ results?: RawCoreOutput[] }>(deps, {
    source: "core",
    url: `${BASE}/search/outputs?${qs({ q: `doi:"${doi}"`, limit: 5 })}`,
    bucket: "core",
    headers: { Authorization: `Bearer ${key}` },
    secrets: [key],
  });
  const outputs = parseCoreSearch(data);
  return outputs.find((o) => o.download_url || o.full_text) ?? outputs[0] ?? null;
}
