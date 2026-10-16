import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { lookupPredatory, lookupSjr } from "../../src/lib/snapshots.ts";
import { resetRateLimits } from "../../src/lib/ratelimit.ts";
import { resetOpenAlexSpend } from "../../src/providers/openalex.ts";
import { getAuthor } from "../../src/tools/author.ts";
import { tools } from "../../src/tools/index.ts";
import { getJournal } from "../../src/tools/journal.ts";
import { getPaper } from "../../src/tools/paper.ts";
import { searchPapersTool } from "../../src/tools/search.ts";
import { ToolError } from "../../src/tools/types.ts";
import { fakeFetch, fixture, makeDeps } from "./helpers.ts";

beforeEach(() => {
  resetRateLimits();
  resetOpenAlexSpend();
});

const NOT_FOUND = { status: 404, text: '{"error": "not found"}' };

/** NCBI converter answer for nature12373 (ids as shown in the Europe PMC fixture). */
const IDCONV_NATURE = {
  status: "ok",
  records: [
    {
      "requested-id": "10.1038/nature12373",
      doi: "10.1038/nature12373",
      pmid: 23903748,
      pmcid: "PMC4221854",
    },
  ],
};

function natureRoutes() {
  return fakeFetch([
    [/idconv/, { json: IDCONV_NATURE }],
    [
      /api\.crossref\.org\/works\/10\.1038\/nature12373/,
      { json: fixture("crossref/work-nature12373.json") },
    ],
    [/europepmc/, { json: fixture("europepmc/search-doi-nature12373.json") }],
    [/api\.openalex\.org\/works\//, { json: fixture("openalex/work-nature12373.json") }],
    [/api\.openalex\.org\/sources\/S137773608/, { json: fixture("openalex/source-nature.json") }],
    [
      /semanticscholar\.org\/graph\/v1\/paper\/DOI:/,
      { json: fixture("semanticscholar/paper-nature12373.json") },
    ],
    [/api\.unpaywall\.org/, { json: fixture("unpaywall/nature12373.json") }],
  ]);
}

describe("get_paper", () => {
  it("merges every provider for 10.1038/nature12373", async () => {
    const f = natureRoutes();
    const p = await getPaper(makeDeps(f.fetch), { id: "https://doi.org/10.1038/nature12373" });
    expect(p.ids).toEqual({
      doi: "10.1038/nature12373",
      pmid: "23903748",
      pmcid: "PMC4221854",
      arxiv: "1304.1068",
      openalex: "W2159974629",
      s2: "a5de30adc5c22bc86e8cfabe7fbd07c052d196a8",
    });
    expect(p.title).toBe("Nanometre-scale thermometry in a living cell");
    expect(p.abstract).toMatch(/^Sensitive probing/);
    expect(p.authors).toHaveLength(8);
    expect(p.authors?.[0]?.affiliations?.length).toBeGreaterThan(0);
    expect(p.venue).toMatchObject({
      name: "Nature",
      volume: "500",
      issue: "7460",
      publisher: expect.any(String),
    });
    expect(p.publication_date).toBe("2013-07-31");
    expect(p.type).toBe("journal-article");
    expect(p.open_access).toMatchObject({
      is_oa: true,
      oa_status: "bronze",
      pdf_url: "https://www.nature.com/articles/nature12373.pdf",
      in_pmc: true,
    });
    expect(p.citation_counts).toMatchObject({ openalex: 1950, semanticscholar: 1829 });
    expect(p.citation_count).toBe(Math.max(...Object.values(p.citation_counts)));
    expect(p.mesh).toContain("Fibroblasts");
    expect(p.retraction.status).toBe("none");
    expect(p.journal).toMatchObject({
      name: "Nature",
      openalex_id: "S137773608",
      issn_l: "0028-0836",
      impact: { h_index: 1838 },
      open_access: { is_in_doaj: false, apc_usd: 12690 },
      is_core: true,
      sjr: null,
      predatory: { listed_on: [] },
    });
    expect(p.field_sources).toMatchObject({
      title: "crossref",
      abstract: "europepmc",
      authors: "openalex",
      open_access: "unpaywall",
      mesh: "europepmc",
      retraction: "crossref",
      journal: "openalex",
    });
    expect(p.upstream).toEqual({
      crossref: "ok",
      europepmc: "ok",
      openalex: "ok",
      semanticscholar: "ok",
      unpaywall: "ok",
    });
    // Europe PMC is queried by PMID once the converter has supplied it.
    const epmc = f.calls.find((c) => c.url.includes("europepmc"));
    expect(new URL(epmc?.url as string).searchParams.get("query")).toBe(
      "EXT_ID:23903748 AND SRC:MED",
    );
  });

  it("reports the Wakefield retraction", async () => {
    const f = fakeFetch([
      [/idconv/, { json: { records: [] } }],
      [/api\.crossref\.org/, { json: fixture("crossref/work-wakefield-retracted.json") }],
      [/europepmc/, { json: { hitCount: 0, resultList: { result: [] } } }],
      [/./, NOT_FOUND],
    ]);
    const p = await getPaper(makeDeps(f.fetch), { id: "doi:10.1016/S0140-6736(97)11096-0" });
    expect(p.title).toMatch(/^RETRACTED: Ileal-lymphoid-nodular hyperplasia/);
    expect(p.retraction.status).toBe("retracted");
    expect(p.retraction.notices.map((n) => n.type)).toEqual(["correction", "retraction"]);
    expect(p.upstream).toMatchObject({
      crossref: "ok",
      openalex: "not_found",
      unpaywall: "not_found",
    });
    expect(p.journal?.name).toBe("The Lancet");
  });

  it("adds preprint versions for a bioRxiv DOI", async () => {
    const f = fakeFetch([
      [/idconv/, { json: { records: [] } }],
      [
        /api\.biorxiv\.org\/details\/biorxiv/,
        { json: fixture("biorxiv/details-2020.03.22.002386.json") },
      ],
      [/europepmc/, { json: { hitCount: 0, resultList: { result: [] } } }],
      [
        /api\.unpaywall\.org/,
        {
          json: {
            doi: "10.1101/2020.03.22.002386",
            is_oa: true,
            oa_status: "green",
            oa_locations: [],
          },
        },
      ],
      [/./, NOT_FOUND],
    ]);
    const p = await getPaper(makeDeps(f.fetch), {
      id: "https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3",
    });
    expect(p.preprint).toMatchObject({
      server: "biorxiv",
      latest_version: "3",
      published_doi: "10.1038/s41586-020-2286-9",
    });
    expect(p.open_access.pdf_url).toBe(
      "https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3.full.pdf",
    );
    expect(p.upstream["biorxiv"]).toBe("ok");
  });

  it("errors clearly when nothing knows the paper", async () => {
    const f = fakeFetch([
      [/idconv/, { json: { records: [] } }],
      [/europepmc/, { json: { hitCount: 0, resultList: { result: [] } } }],
      [/./, NOT_FOUND],
    ]);
    await expect(getPaper(makeDeps(f.fetch), { id: "10.9999/nothing" })).rejects.toThrow(
      "no provider knows this paper",
    );
    const g = fakeFetch([
      [/match/, { status: 404, json: fixture("semanticscholar/match-not-found.json") }],
      [/europepmc/, { json: { hitCount: 0, resultList: { result: [] } } }],
    ]);
    await expect(getPaper(makeDeps(g.fetch), { id: "an unknowable title" })).rejects.toThrow(
      /no paper matched/,
    );
  });
});

describe("get_journal", () => {
  it("looks up by ISSN", async () => {
    const f = fakeFetch([
      [/sources\/issn:0028-0836/, { json: fixture("openalex/source-nature.json") }],
    ]);
    const j = (await getJournal(makeDeps(f.fetch), { issn_or_name_or_doi: "00280836" })) as Record<
      string,
      unknown
    >;
    expect(j).toMatchObject({
      name: "Nature",
      issns: ["0028-0836", "1476-4687"],
      impact: { two_year_mean_citedness: expect.closeTo(19.33, 1), h_index: 1838 },
      listed_in: expect.arrayContaining(["medline"]),
      sources: { stats: "openalex", sjr: "data/sjr.json (empty snapshot)" },
    });
  });

  it("looks up by DOI via the paper's venue", async () => {
    const f = natureRoutes();
    const j = (await getJournal(makeDeps(f.fetch), {
      issn_or_name_or_doi: "10.1038/nature12373",
    })) as Record<string, unknown>;
    expect(j["openalex_id"]).toBe("S137773608");
  });

  it("searches by name and lists other matches", async () => {
    const source = fixture("openalex/source-nature.json");
    const f = fakeFetch([
      [
        /sources\?/,
        {
          json: {
            meta: { count: 2 },
            results: [
              source,
              {
                ...(source as object),
                id: "https://openalex.org/S1",
                display_name: "Nature Medicine",
              },
            ],
          },
        },
      ],
    ]);
    const j = (await getJournal(makeDeps(f.fetch), { issn_or_name_or_doi: "Nature" })) as Record<
      string,
      unknown
    >;
    expect(j["name"]).toBe("Nature");
    expect(j["other_matches"]).toEqual([
      expect.objectContaining({ name: "Nature Medicine", openalex_id: "S1" }),
    ]);
  });

  it("matches snapshot entries", () => {
    const sjr = {
      generated: "2026-10-16",
      year: 2025,
      entries: { "0028-0836": { title: "Nature", sjr: 18.5, quartile: "Q1" } },
    };
    expect(lookupSjr(["1476-4687", "00280836"], sjr)).toMatchObject({
      sjr: 18.5,
      quartile: "Q1",
      year: 2025,
      issn: "0028-0836",
    });
    expect(lookupSjr(["1234-5678"], sjr)).toBeNull();
    const pred = {
      generated: "2026-10-16",
      journals: [
        { name: "Journal of Dubious Results", issn: "1111-2222", source: "beallslist.net" },
        { name: "Another Questionable Journal", source: "predatoryjournals.org" },
      ],
      publishers: [{ name: "Shady Press Ltd", source: "beallslist.net" }],
    };
    expect(
      lookupPredatory({ issns: ["11112222"], name: "x", publisher: "Shady Press Ltd." }, pred),
    ).toEqual([
      expect.objectContaining({ list: "journals", matched_on: "issn", source: "beallslist.net" }),
      expect.objectContaining({ list: "publishers", matched_on: "publisher" }),
    ]);
    expect(lookupPredatory({ name: "another questionable journal" }, pred)[0]?.matched_on).toBe(
      "name",
    );
    expect(lookupPredatory({ name: "Nature" }, pred)).toEqual([]);
  });
});

describe("get_author", () => {
  const authors = fixture<{ results: object[] }>("openalex/authors-search-lukin.json");

  it("searches by name and offers other matches", async () => {
    const f = fakeFetch([[/authors\?/, { json: authors }]]);
    const a = (await getAuthor(makeDeps(f.fetch), { id_or_name: "Mikhail Lukin" })) as Record<
      string,
      unknown
    >;
    expect(a).toMatchObject({ name: "Mikhail D. Lukin", h_index: 160, source: "openalex" });
    expect((a["other_matches"] as unknown[]).length).toBe(2);
  });

  it("looks up an ORCID URL directly", async () => {
    const f = fakeFetch([[/authors\/orcid:0000-0002-8658-1007/, { json: authors.results[0] }]]);
    const a = (await getAuthor(makeDeps(f.fetch), {
      id_or_name: "https://orcid.org/0000-0002-8658-1007",
    })) as Record<string, unknown>;
    expect(a["openalex_id"]).toBe("A5066245772");
  });

  it("404s cleanly", async () => {
    const f = fakeFetch([[/./, NOT_FOUND]]);
    await expect(getAuthor(makeDeps(f.fetch), { id_or_name: "A123" })).rejects.toBeInstanceOf(
      ToolError,
    );
  });
});

describe("search_papers tool", () => {
  it("returns compact hits", async () => {
    const f = fakeFetch([
      [/europepmc/, { json: fixture("europepmc/search-crispr-malaria.json") }],
      [/api\.openalex\.org\/works\?/, { json: fixture("openalex/search-crispr-malaria.json") }],
      [/paper\/search\?/, { json: fixture("semanticscholar/search-crispr-malaria.json") }],
    ]);
    const out = (await searchPapersTool(makeDeps(f.fetch), {
      query: "CRISPR malaria",
      limit: 5,
    })) as {
      results: { authors: string[]; abstract?: string; sources: string[] }[];
      count: number;
    };
    expect(out.count).toBe(5);
    for (const hit of out.results) {
      expect(hit.authors.length).toBeLessThanOrEqual(3);
      expect((hit.abstract ?? "").length).toBeLessThanOrEqual(303);
      expect(hit.sources.length).toBeGreaterThan(0);
    }
  });

  it("fails when every provider fails, and validates year order", async () => {
    const f = fakeFetch([[/./, { status: 500, text: "down" }]]);
    await expect(searchPapersTool(makeDeps(f.fetch), { query: "x" })).rejects.toThrow(
      "every search provider failed",
    );
    await expect(
      searchPapersTool(makeDeps(f.fetch), { query: "x", from_year: 2020, to_year: 2010 }),
    ).rejects.toThrow("from_year is after to_year");
  });
});

describe("tool definitions", () => {
  const mine = ["search_papers", "get_paper", "get_author", "get_journal"];

  it("are registered with read-only annotations, examples and described fields", () => {
    for (const name of mine) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      expect(def?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
      expect(def?.description).toMatch(/Example: \{/);
      for (const [field, schema] of Object.entries(def?.inputSchema ?? {})) {
        expect((schema as z.ZodType).description, `${name}.${field}`).toBeTruthy();
      }
    }
  });

  it("validate search_papers limits", () => {
    const schema = z.object(tools.find((t) => t.name === "search_papers")?.inputSchema ?? {});
    expect(schema.safeParse({ query: "x", limit: 100 }).success).toBe(true);
    expect(schema.safeParse({ query: "x", limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", offset: 199 }).success).toBe(true);
    expect(schema.safeParse({ query: "x", offset: 200 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", sources: ["scholar"] }).success).toBe(false);
    expect(schema.safeParse({ query: "" }).success).toBe(false);
  });
});
