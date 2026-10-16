import f0 from "../fixtures/biorxiv/details-2020.03.22.002386.json";
import f1 from "../fixtures/crossref/work-nature12373.json";
import f2 from "../fixtures/crossref/work-wakefield-retracted.json";
import f3 from "../fixtures/europepmc/search-crispr-malaria.json";
import f4 from "../fixtures/europepmc/search-doi-nature12373.json";
import f5 from "../fixtures/europepmc/search-pmid-33301246.json";
import f6 from "../fixtures/ncbi/esearch-malaria-mh.json";
import f7 from "../fixtures/ncbi/esummary-2.json";
import f8 from "../fixtures/ncbi/idconv-33301246.json";
import f9 from "../fixtures/openalex/authors-search-lukin.json";
import f10 from "../fixtures/openalex/search-crispr-malaria.json";
import f11 from "../fixtures/openalex/source-nature.json";
import f12 from "../fixtures/openalex/work-nature12373.json";
import f13 from "../fixtures/semanticscholar/bulk-crispr-malaria.json";
import f14 from "../fixtures/semanticscholar/match-nature12373.json";
import f15 from "../fixtures/semanticscholar/match-not-found.json";
import f16 from "../fixtures/semanticscholar/paper-nature12373.json";
import f17 from "../fixtures/semanticscholar/search-crispr-malaria.json";
import f18 from "../fixtures/unpaywall/nature12373.json";

import type { Env } from "../../src/env.ts";
import type { ProviderDeps } from "../../src/providers/types.ts";

/**
 * Committed fixtures (trimmed real upstream responses), imported as JSON so
 * the tests need no Node APIs (tsconfig carries Worker types only).
 */
const FIXTURES: Record<string, unknown> = {
  "biorxiv/details-2020.03.22.002386.json": f0,
  "crossref/work-nature12373.json": f1,
  "crossref/work-wakefield-retracted.json": f2,
  "europepmc/search-crispr-malaria.json": f3,
  "europepmc/search-doi-nature12373.json": f4,
  "europepmc/search-pmid-33301246.json": f5,
  "ncbi/esearch-malaria-mh.json": f6,
  "ncbi/esummary-2.json": f7,
  "ncbi/idconv-33301246.json": f8,
  "openalex/authors-search-lukin.json": f9,
  "openalex/search-crispr-malaria.json": f10,
  "openalex/source-nature.json": f11,
  "openalex/work-nature12373.json": f12,
  "semanticscholar/bulk-crispr-malaria.json": f13,
  "semanticscholar/match-nature12373.json": f14,
  "semanticscholar/match-not-found.json": f15,
  "semanticscholar/paper-nature12373.json": f16,
  "semanticscholar/search-crispr-malaria.json": f17,
  "unpaywall/nature12373.json": f18,
};

/** A deep copy of a committed fixture, so tests cannot leak mutations. */
export function fixture<T = unknown>(rel: string): T {
  const data = FIXTURES[rel];
  if (data === undefined) throw new Error(`unknown fixture: ${rel}`);
  return structuredClone(data) as T;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type Route = [RegExp, Reply | ((url: string, init?: RequestInit) => Reply)];

export interface FakeFetch {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init?: RequestInit }[];
}

/**
 * A fetch that answers from a route table (first matching regex wins) and
 * records every call. Unmatched URLs fail loudly so a test never silently
 * depends on the network.
 */
export function fakeFetch(routes: Route[]): FakeFetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    for (const [re, reply] of routes) {
      if (re.test(url)) {
        const r = typeof reply === "function" ? reply(url, init) : reply;
        const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
        return new Response(body, { status: r.status ?? 200, headers: r.headers });
      }
    }
    throw new Error(`unrouted fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const NOW = new Date("2026-10-16T12:00:00Z");

export function makeDeps(
  fetch: typeof globalThis.fetch,
  env: Partial<Env> = {},
): ProviderDeps & { origin: string } {
  return {
    env: env as Env,
    fetch,
    now: () => NOW,
    sleep: async () => {},
    origin: "https://doily.test",
  };
}

/** Minimal in-memory KV namespace for code paths that persist state. */
export function memoryKv(opts: { failPuts?: boolean } = {}) {
  const store = new Map<string, string>();
  const puts: { key: string; value: string; options?: unknown }[] = [];
  const kv = {
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string, options?: unknown) {
      puts.push({ key, value, options });
      if (opts.failPuts) throw new Error("KV PUT failed: 429 Too Many Requests");
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, puts };
}
