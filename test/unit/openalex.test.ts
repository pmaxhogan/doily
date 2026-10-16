import { beforeEach, describe, expect, it } from "vitest";

import { resetRateLimits } from "../../src/lib/ratelimit.ts";
import {
  addSpend,
  canSearch,
  dailyBudgetUsd,
  getOpenAlexAuthor,
  getOpenAlexSource,
  getOpenAlexWork,
  getSpend,
  parseOpenAlexAuthor,
  parseOpenAlexSearch,
  parseOpenAlexWork,
  resetOpenAlexSpend,
  searchOpenAlex,
  searchOpenAlexAuthors,
  utcDay,
  workSourceId,
  type OaWork,
} from "../../src/providers/openalex.ts";
import { ToolError } from "../../src/tools/types.ts";
import { fakeFetch, fixture, makeDeps, memoryKv, NOW } from "./helpers.ts";

beforeEach(() => {
  resetRateLimits();
  resetOpenAlexSpend();
});

describe("OpenAlex parsing", () => {
  it("parses a work (nature12373)", () => {
    const w = fixture<OaWork>("openalex/work-nature12373.json");
    const r = parseOpenAlexWork(w);
    expect(r).toMatchObject({
      source: "openalex",
      openalex_id: "W2159974629",
      doi: "10.1038/nature12373",
      pmid: "23903748",
      title: "Nanometre-scale thermometry in a living cell",
      journal: "Nature",
      publisher: "Nature Portfolio",
      year: 2013,
      publication_date: "2013-07-30",
      volume: "500",
      issue: "7460",
      pages: "54-58",
      oa_status: "bronze",
      pdf_url: "https://www.nature.com/articles/nature12373.pdf",
      is_retracted: false,
    });
    expect(r.issn).toEqual(["0028-0836", "1476-4687"]);
    expect(r.authors?.[0]).toMatchObject({ name: "Georg Kucsko", orcid: "0000-0002-4189-3154" });
    expect(r.authors?.[0]?.affiliations?.[0]).toContain("Harvard University");
    // The raw fixture lists "Cell Survival" twice; it must appear once.
    expect(r.mesh?.filter((m) => m === "Cell Survival")).toHaveLength(1);
    // abstract_inverted_index is null for this work upstream.
    expect(r.abstract).toBeUndefined();
    expect(workSourceId(w)).toBe("S137773608");
  });

  it("parses a search page and rebuilds abstracts", () => {
    const { total, records } = parseOpenAlexSearch(fixture("openalex/search-crispr-malaria.json"));
    expect(total).toBe(11760);
    expect(records).toHaveLength(5);
    expect(records.some((r) => (r.abstract?.length ?? 0) > 50)).toBe(true);
  });

  it("parses an author", () => {
    const body = fixture<{ results: object[] }>("openalex/authors-search-lukin.json");
    const a = parseOpenAlexAuthor(body.results[0] as object);
    expect(a).toMatchObject({
      openalex_id: "A5066245772",
      name: "Mikhail D. Lukin",
      orcid: "0000-0002-8658-1007",
      works_count: 890,
      h_index: 160,
      i10_index: 395,
    });
    expect(a.top_topics.length).toBeGreaterThan(0);
  });
});

describe("OpenAlex requests", () => {
  it("looks up works by DOI, PMID, PMCID and id without spending", async () => {
    const f = fakeFetch([
      [
        /api\.openalex\.org\/works\//,
        {
          json: fixture("openalex/work-nature12373.json"),
          headers: { "X-RateLimit-Cost-USD": "0" },
        },
      ],
    ]);
    const deps = makeDeps(f.fetch);
    await getOpenAlexWork(deps, { doi: "10.1038/nature12373" });
    await getOpenAlexWork(deps, { pmid: "23903748" });
    await getOpenAlexWork(deps, { pmcid: "PMC4221854" });
    await getOpenAlexWork(deps, { openalex: "W2159974629" });
    expect(await getOpenAlexWork(deps, {})).toBeNull();
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/works/https://doi.org/10.1038/nature12373",
      "/works/pmid:23903748",
      "/works/pmcid:PMC4221854",
      "/works/W2159974629",
    ]);
    expect(await getSpend(deps)).toBe(0);
  });

  it("adds api_key when set and keeps it out of errors", async () => {
    const f = fakeFetch([[/openalex/, { status: 403, text: "bad api_key=OAKEY999" }]]);
    const err = (await getOpenAlexSource(makeDeps(f.fetch, { OPENALEX_API_KEY: "OAKEY999" }), {
      issn: "0028-0836",
    }).catch((e: unknown) => e)) as ToolError;
    expect(f.calls[0]?.url).toContain("api_key=OAKEY999");
    expect(JSON.stringify(err.toJSON())).not.toContain("OAKEY999");
  });

  it("accumulates search cost from the header, falling back to meta.cost_usd", async () => {
    const f = fakeFetch([
      [
        /abstract=one/,
        {
          json: fixture("openalex/search-crispr-malaria.json"),
          headers: { "X-RateLimit-Cost-USD": "0.002" },
        },
      ],
      [/abstract=two/, { json: fixture("openalex/search-crispr-malaria.json") }],
    ]);
    const deps = makeDeps(f.fetch);
    await searchOpenAlex(deps, { query: "one", perPage: 5 });
    await searchOpenAlex(deps, {
      query: "two",
      perPage: 5,
      sort: "citations",
      fromYear: 2020,
      toYear: 2022,
    });
    expect(await getSpend(deps)).toBeCloseTo(0.003, 6);
    const second = new URL(f.calls[1]?.url as string).searchParams;
    expect(second.get("search.title_and_abstract")).toBe("two");
    expect(second.get("sort")).toBe("cited_by_count:desc");
    expect(second.get("filter")).toBe("publication_year:2020-2022");
    expect(second.get("select")).toContain("abstract_inverted_index");
  });

  it("stops keyword searches at 90% of the daily budget but keeps lookups", async () => {
    const f = fakeFetch([
      [/works\?/, { json: fixture("openalex/search-crispr-malaria.json") }],
      [/sources\//, { json: fixture("openalex/source-nature.json") }],
    ]);
    const deps = makeDeps(f.fetch);
    expect(dailyBudgetUsd({})).toBe(0.1);
    expect(dailyBudgetUsd({ OPENALEX_API_KEY: "k" })).toBe(1);
    await addSpend(deps, 0.09);
    expect(await canSearch(deps)).toBe(false);
    await expect(searchOpenAlex(deps, { query: "x", perPage: 1 })).rejects.toThrow(/budget/);
    await expect(searchOpenAlexAuthors(deps, "x")).rejects.toThrow(/budget/);
    expect((await getOpenAlexSource(deps, { issn: "0028-0836" }))?.display_name).toBe("Nature");
  });

  it("treats X-RateLimit-Remaining-USD as a floor on spend", async () => {
    const f = fakeFetch([
      [
        /works\?/,
        {
          json: fixture("openalex/search-crispr-malaria.json"),
          headers: { "X-RateLimit-Cost-USD": "0.001", "X-RateLimit-Remaining-USD": "0.005" },
        },
      ],
    ]);
    const deps = makeDeps(f.fetch);
    await searchOpenAlex(deps, { query: "x", perPage: 1 });
    expect(await getSpend(deps)).toBeCloseTo(0.095, 6);
    expect(await canSearch(deps)).toBe(false);
  });

  it("persists spend in KV per UTC day", async () => {
    const mem = memoryKv();
    const deps = makeDeps(fakeFetch([]).fetch, { DOILY_KV: mem.kv });
    await addSpend(deps, 0.004);
    expect(mem.store.get(`openalex:spend:${utcDay(NOW)}`)).toBe("0.004");
    expect(utcDay(NOW)).toBe("2026-10-16");
    resetOpenAlexSpend();
    expect(await getSpend(deps)).toBeCloseTo(0.004, 6);
  });

  it("looks up authors by id or ORCID", async () => {
    const author = fixture<{ results: object[] }>("openalex/authors-search-lukin.json").results[0];
    const f = fakeFetch([[/authors\//, { json: author }]]);
    const deps = makeDeps(f.fetch);
    await getOpenAlexAuthor(deps, { orcid: "0000-0002-8658-1007" });
    await getOpenAlexAuthor(deps, { openalex: "A5066245772" });
    expect(await getOpenAlexAuthor(deps, {})).toBeNull();
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/authors/orcid:0000-0002-8658-1007",
      "/authors/A5066245772",
    ]);
  });
});
