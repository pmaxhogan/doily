import { describe, expect, it } from "vitest";

import { resolveIds } from "../../src/ids.ts";
import { getPreprintDetails } from "../../src/providers/biorxiv.ts";
import { getCrossrefWork } from "../../src/providers/crossref.ts";
import { searchEuropePmc } from "../../src/providers/europepmc.ts";
import { getOpenAlexSource, getOpenAlexWork } from "../../src/providers/openalex.ts";
import { esearchPubMed } from "../../src/providers/pubmed.ts";
import { getS2Paper } from "../../src/providers/semanticscholar.ts";
import { getUnpaywall } from "../../src/providers/unpaywall.ts";
import { getPaper } from "../../src/tools/paper.ts";
import { searchPapersTool } from "../../src/tools/search.ts";
import { ToolError } from "../../src/tools/types.ts";

import type { Env } from "../../src/env.ts";
import type { ProviderDeps } from "../../src/providers/types.ts";

/**
 * LIVE=1 only (see vitest.config.ts): one real request per provider. Keys
 * are read from the environment when present; everything works unkeyed.
 * Apart from the single search_papers call (one metered OpenAlex search,
 * about $0.001), only free OpenAlex singleton lookups are used.
 */

// No Node types in tsconfig (Worker types only), so reach process.env untyped.
const penv =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const env = {
  CONTACT_EMAIL: penv["CONTACT_EMAIL"],
  NCBI_API_KEY: penv["NCBI_API_KEY"],
  OPENALEX_API_KEY: penv["OPENALEX_API_KEY"],
  S2_API_KEY: penv["S2_API_KEY"],
} as Env;

const deps: ProviderDeps = { env, fetch: globalThis.fetch.bind(globalThis), now: () => new Date() };
const DOI = "10.1038/nature12373";

describe("live upstreams", { timeout: 30000 }, () => {
  it("Europe PMC search", async () => {
    const res = await searchEuropePmc(deps, { query: `DOI:"${DOI}"`, pageSize: 1 });
    expect(res.records[0]?.pmid).toBe("23903748");
  });

  it("OpenAlex work and source lookups", async () => {
    const work = await getOpenAlexWork(deps, { doi: DOI });
    expect(work?.id).toContain("W2159974629");
    const source = await getOpenAlexSource(deps, { issn: "0028-0836" });
    expect(source?.display_name).toBe("Nature");
  });

  it("Semantic Scholar paper lookup", async (ctx) => {
    try {
      const paper = await getS2Paper(deps, `DOI:${DOI}`);
      expect(paper?.pmid).toBe("23903748");
    } catch (err) {
      // The unkeyed pool is shared worldwide and 429s often.
      if (err instanceof ToolError && err.details["status"] === 429) ctx.skip();
      throw err;
    }
  });

  it("PubMed esearch", async () => {
    const res = await esearchPubMed(deps, { term: "malaria[mh] AND crispr[tiab]", retmax: 3 });
    expect(res.count).toBeGreaterThan(10);
    expect(res.ids).toHaveLength(3);
  });

  it("NCBI ID converter via resolveIds", async () => {
    const ids = await resolveIds(deps, "33301246");
    expect(ids).toMatchObject({ doi: "10.1056/nejmoa2034577", pmcid: "PMC7745181" });
  });

  it("Crossref retraction (Wakefield)", async () => {
    const work = await getCrossrefWork(deps, "10.1016/S0140-6736(97)11096-0");
    expect(work?.retraction.status).toBe("retracted");
  });

  it("Unpaywall", async () => {
    const u = await getUnpaywall(deps, DOI);
    expect(u?.is_oa).toBe(true);
  });

  it("bioRxiv details", async () => {
    const d = await getPreprintDetails(deps, "10.1101/2020.03.22.002386");
    expect(d?.published_doi).toBe("10.1038/s41586-020-2286-9");
  });

  it("get_paper end to end", async () => {
    const p = await getPaper(deps, { id: DOI });
    expect(p.ids.pmcid).toBe("PMC4221854");
    expect(p.journal?.name).toBe("Nature");
  });

  it("search_papers end to end", async () => {
    const out = (await searchPapersTool(deps, { query: "CRISPR AND malaria", limit: 10 })) as {
      results: { title?: string; sources: string[] }[];
      providers: Record<string, { status: string }>;
    };
    expect(out.results.length).toBe(10);
    expect(out.providers["europepmc"]?.status).toBe("ok");
  });
});
