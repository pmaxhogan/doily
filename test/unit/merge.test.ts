import { beforeEach, describe, expect, it } from "vitest";

import { resetRateLimits } from "../../src/lib/ratelimit.ts";
import { addSpend, resetOpenAlexSpend } from "../../src/providers/openalex.ts";
import { dedupMerge, searchPapers, sortMerged } from "../../src/search/merge.ts";
import { fakeFetch, fixture, makeDeps } from "./helpers.ts";

import type { PaperRecord } from "../../src/providers/types.ts";

beforeEach(() => {
  resetRateLimits();
  resetOpenAlexSpend();
});

const rec = (r: Partial<PaperRecord> & Pick<PaperRecord, "source">): PaperRecord => r;

describe("dedupMerge", () => {
  it("merges by DOI, preferring richer values", () => {
    const merged = dedupMerge([
      rec({
        source: "semanticscholar",
        doi: "10.1/a",
        title: "A study",
        citation_count: 30,
        rank: 0,
        abstract: "short",
      }),
      rec({
        source: "europepmc",
        doi: "10.1/A",
        pmid: "1",
        title: "A Study.",
        citation_count: 10,
        rank: 2,
        abstract: "a much longer abstract",
        authors: [{ name: "X" }],
        mesh: ["Humans"],
      }),
      rec({
        source: "openalex",
        doi: "10.1/a",
        authors: [{ name: "X", affiliations: ["Uni"] }],
        oa_status: "gold",
        rank: 1,
      }),
    ]);
    expect(merged).toHaveLength(1);
    const m = merged[0];
    expect(m).toMatchObject({
      doi: "10.1/A",
      pmid: "1",
      title: "A Study.",
      citation_count: 30,
      abstract: "a much longer abstract",
      oa_status: "gold",
      best_rank: 0,
      mesh: ["Humans"],
    });
    expect(m?.authors?.[0]?.affiliations).toEqual(["Uni"]);
    expect(m?.sources).toEqual(["europepmc", "openalex", "semanticscholar"]);
  });

  it("falls back to PMID, then normalized title", () => {
    const merged = dedupMerge([
      rec({ source: "europepmc", pmid: "42", title: "Gene drives in Anopheles" }),
      rec({ source: "pubmed", pmid: "42", doi: "10.2/x" }),
      rec({ source: "openalex", title: "Gene Drives in Anopheles!", year: 2020 }),
      rec({ source: "semanticscholar", title: "Short" }),
      rec({ source: "openalex", title: "Short" }),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ pmid: "42", doi: "10.2/x", year: 2020 });
    expect(merged[0]?.sources).toEqual(["europepmc", "openalex", "pubmed"]);
  });

  it("joins two groups bridged by a later record", () => {
    const merged = dedupMerge([
      rec({ source: "europepmc", doi: "10.3/y", title: "Alpha beta gamma delta" }),
      rec({ source: "openalex", pmid: "7", title: "Completely different title here" }),
      rec({ source: "pubmed", doi: "10.3/y", pmid: "7" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sources.sort()).toEqual(["europepmc", "openalex", "pubmed"]);
  });

  it("sorts by relevance, date and citations", () => {
    const merged = dedupMerge([
      rec({ source: "europepmc", doi: "a", rank: 1, year: 2020, citation_count: 5 }),
      rec({
        source: "openalex",
        doi: "b",
        rank: 0,
        publication_date: "2024-01-02",
        citation_count: 1,
      }),
      rec({ source: "europepmc", doi: "c", rank: 0, year: 2010 }),
      rec({ source: "semanticscholar", doi: "c", rank: 3, citation_count: 50 }),
    ]);
    expect(sortMerged(merged, "relevance").map((m) => m.doi)).toEqual(["c", "b", "a"]);
    expect(sortMerged(merged, "date").map((m) => m.doi)).toEqual(["b", "a", "c"]);
    expect(sortMerged(merged, "citations").map((m) => m.doi)).toEqual(["c", "a", "b"]);
  });
});

function searchRoutes() {
  return fakeFetch([
    [/europepmc/, { json: fixture("europepmc/search-crispr-malaria.json") }],
    [/api\.openalex\.org\/works\?/, { json: fixture("openalex/search-crispr-malaria.json") }],
    [/paper\/search\/bulk/, { json: fixture("semanticscholar/bulk-crispr-malaria.json") }],
    [/paper\/search\?/, { json: fixture("semanticscholar/search-crispr-malaria.json") }],
    [/esearch/, { json: fixture("ncbi/esearch-malaria-mh.json") }],
    [/esummary/, { json: fixture("ncbi/esummary-2.json") }],
  ]);
}

describe("searchPapers", () => {
  it("fans out to three providers for free text and merges", async () => {
    const f = searchRoutes();
    const out = await searchPapers(makeDeps(f.fetch), { query: "CRISPR AND malaria", limit: 8 });
    expect(Object.keys(out.providers).sort()).toEqual(["europepmc", "openalex", "semanticscholar"]);
    for (const p of Object.values(out.providers)) expect(p?.status).toBe("ok");
    expect(out.providers.semanticscholar?.endpoint).toBe("search");
    expect(out.results).toHaveLength(8);
    expect(out.merged_total).toBeLessThanOrEqual(15);
    const s2 = new URL(f.calls.find((c) => c.url.includes("semanticscholar"))?.url as string);
    expect(s2.searchParams.get("query")).toBe("CRISPR malaria");
    const dois = out.results.map((r) => r.doi).filter(Boolean);
    expect(new Set(dois).size).toBe(dois.length);
  });

  it("adds PubMed for PubMed syntax and uses S2 bulk for boolean + citations", async () => {
    const f = searchRoutes();
    const out = await searchPapers(makeDeps(f.fetch), {
      query: "malaria[mh] AND crispr[tiab]",
      sort: "citations",
      fromYear: 2020,
      limit: 5,
    });
    expect(out.providers.pubmed?.status).toBe("ok");
    expect(out.providers.semanticscholar?.endpoint).toBe("bulk");
    const epmc = new URL(f.calls.find((c) => c.url.includes("europepmc"))?.url as string);
    expect(epmc.searchParams.get("query")).toBe("(malaria AND crispr) AND PUB_YEAR:[2020 TO 3000]");
    const counts = out.results.map((r) => r.citation_count ?? -1);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("honors an explicit source list and records failures", async () => {
    const f = fakeFetch([
      [/europepmc/, { status: 503, text: "maintenance" }],
      [/paper\/search\?/, { json: fixture("semanticscholar/search-crispr-malaria.json") }],
    ]);
    const out = await searchPapers(makeDeps(f.fetch), {
      query: "crispr malaria",
      sources: ["europepmc", "semanticscholar"],
    });
    expect(out.providers.europepmc).toMatchObject({ status: "error", http_status: 503 });
    expect(out.providers.semanticscholar?.status).toBe("ok");
    expect(out.providers.openalex).toBeUndefined();
    expect(out.results.length).toBeGreaterThan(0);
  });

  it("skips OpenAlex when the daily budget is nearly spent", async () => {
    const f = searchRoutes();
    const deps = makeDeps(f.fetch);
    await addSpend(deps, 0.095);
    const out = await searchPapers(deps, { query: "crispr malaria" });
    expect(out.providers.openalex).toMatchObject({ status: "skipped" });
    expect(f.calls.some((c) => c.url.includes("openalex"))).toBe(false);
  });

  it("pages through the merged list", async () => {
    const f = searchRoutes();
    const page1 = await searchPapers(makeDeps(f.fetch), { query: "crispr malaria", limit: 3 });
    resetRateLimits();
    const page2 = await searchPapers(makeDeps(searchRoutes().fetch), {
      query: "crispr malaria",
      limit: 3,
      offset: 3,
    });
    expect(page1.results.map((r) => r.title)).not.toEqual(page2.results.map((r) => r.title));
    const want = new URL(
      f.calls.find((c) => c.url.includes("europepmc"))?.url as string,
    ).searchParams.get("pageSize");
    expect(want).toBe("3");
  });
});
