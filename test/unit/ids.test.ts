import { beforeEach, describe, expect, it } from "vitest";

import { arxivDoi, normalizeDoi, parseId, resolveIds } from "../../src/ids.ts";
import { resetRateLimits } from "../../src/lib/ratelimit.ts";
import { resetOpenAlexSpend } from "../../src/providers/openalex.ts";
import { ToolError } from "../../src/tools/types.ts";
import { fakeFetch, fixture, makeDeps } from "./helpers.ts";

beforeEach(() => {
  resetRateLimits();
  resetOpenAlexSpend();
});

describe("normalizeDoi", () => {
  it.each([
    ["10.1038/nature12373", "10.1038/nature12373"],
    ["doi:10.1038/NATURE12373", "10.1038/nature12373"],
    ["https://doi.org/10.1038/nature12373", "10.1038/nature12373"],
    ["10.1038/nature12373.", "10.1038/nature12373"],
    ["(see 10.1038/nature12373)", "10.1038/nature12373"],
    ["10.1016/S0140-6736(97)11096-0", "10.1016/s0140-6736(97)11096-0"],
    ["10.1016%2FS0140-6736(97)11096-0", "10.1016/s0140-6736(97)11096-0"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected);
  });

  it("returns undefined without a DOI", () => {
    expect(normalizeDoi("nature12373")).toBeUndefined();
    expect(normalizeDoi(undefined)).toBeUndefined();
  });
});

describe("parseId", () => {
  it.each([
    ["10.1038/nature12373", "doi", "10.1038/nature12373"],
    ["doi: 10.1038/nature12373", "doi", "10.1038/nature12373"],
    ["https://doi.org/10.1038/NATURE12373", "doi", "10.1038/nature12373"],
    ["dx.doi.org/10.1038/nature12373", "doi", "10.1038/nature12373"],
    ["23903748", "pmid", "23903748"],
    ["PMID: 23903748", "pmid", "23903748"],
    ["pmc4221854", "pmcid", "PMC4221854"],
    ["PMCID:PMC4221854", "pmcid", "PMC4221854"],
    ["2301.12345", "arxiv", "2301.12345"],
    ["arXiv:1304.1068v2", "arxiv", "1304.1068"],
    ["hep-th/9901001", "arxiv", "hep-th/9901001"],
    ["math.GT/0309136", "arxiv", "math.gt/0309136"],
    ["W2159974629", "openalex", "W2159974629"],
    ["https://pubmed.ncbi.nlm.nih.gov/23903748/", "pmid", "23903748"],
    ["https://www.ncbi.nlm.nih.gov/pubmed/23903748", "pmid", "23903748"],
    ["https://pmc.ncbi.nlm.nih.gov/articles/PMC4221854/", "pmcid", "PMC4221854"],
    ["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4221854", "pmcid", "PMC4221854"],
    ["https://europepmc.org/article/MED/23903748", "pmid", "23903748"],
    ["https://europepmc.org/article/PMC/PMC4221854", "pmcid", "PMC4221854"],
    ["https://arxiv.org/abs/1304.1068v1", "arxiv", "1304.1068"],
    ["https://arxiv.org/pdf/2301.12345.pdf", "arxiv", "2301.12345"],
    ["https://openalex.org/W2159974629", "openalex", "W2159974629"],
    [
      "https://onlinelibrary.wiley.com/doi/10.1002/anie.202000001/full",
      "doi",
      "10.1002/anie.202000001",
    ],
    ["https://www.science.org/doi/full/10.1126/science.abc1234", "doi", "10.1126/science.abc1234"],
    [
      "https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3.full",
      "doi",
      "10.1101/2020.03.22.002386",
    ],
    [
      "https://link.springer.com/content/pdf/10.1007/s00125-020-05123-4.pdf",
      "doi",
      "10.1007/s00125-020-05123-4",
    ],
    ["https://example.org/view?doi=10.1038%2Fnature12373", "doi", "10.1038/nature12373"],
    [
      "Nanometre-scale thermometry in a living cell",
      "title",
      "Nanometre-scale thermometry in a living cell",
    ],
  ])("%s", (input, kind, value) => {
    expect(parseId(input)).toEqual({ kind, value });
  });

  it("rejects empty input and URLs without an id", () => {
    expect(() => parseId("  ")).toThrow(ToolError);
    expect(() => parseId("https://www.nature.com/articles/nature12373")).toThrow(/no DOI/);
  });
});

describe("resolveIds", () => {
  it("fills DOI and PMCID for a PMID via the NCBI converter", async () => {
    const f = fakeFetch([[/idconv/, { json: fixture("ncbi/idconv-33301246.json") }]]);
    const ids = await resolveIds(makeDeps(f.fetch), "33301246");
    expect(ids).toMatchObject({
      pmid: "33301246",
      doi: "10.1056/nejmoa2034577",
      pmcid: "PMC7745181",
      resolved_via: ["ncbi_idconv"],
    });
    expect(f.calls[0]?.url).toContain("ids=33301246");
    expect(f.calls[0]?.url).not.toContain("api_key");
  });

  it("falls back to OpenAlex when the converter fails", async () => {
    const f = fakeFetch([
      [/idconv/, { status: 500, text: "oops" }],
      [
        /api\.openalex\.org\/works\/pmid:23903748/,
        { json: fixture("openalex/work-nature12373.json") },
      ],
    ]);
    const ids = await resolveIds(makeDeps(f.fetch), "PMID:23903748");
    expect(ids.doi).toBe("10.1038/nature12373");
    expect(ids.resolved_via).toEqual(["openalex"]);
  });

  it("maps arXiv ids to their DataCite DOI without calling NCBI", async () => {
    const f = fakeFetch([]);
    const ids = await resolveIds(makeDeps(f.fetch), "arXiv:1304.1068");
    expect(ids.doi).toBe(arxivDoi("1304.1068"));
    expect(ids.arxiv).toBe("1304.1068");
    expect(f.calls).toHaveLength(0);
  });

  it("resolves a title through Semantic Scholar match", async () => {
    const f = fakeFetch([
      [/search\/match/, { json: fixture("semanticscholar/match-nature12373.json") }],
      [/idconv/, { json: { records: [] } }],
    ]);
    const ids = await resolveIds(makeDeps(f.fetch), "Nanometer scale thermometry in a living cell");
    expect(ids).toMatchObject({
      doi: "10.1038/nature12373",
      pmid: "23903748",
      pmcid: "PMC4221854",
    });
    expect(ids.resolved_via[0]).toBe("semanticscholar");
  });

  it("falls back to Europe PMC title search when S2 has no match", async () => {
    const f = fakeFetch([
      [/search\/match/, { status: 404, json: fixture("semanticscholar/match-not-found.json") }],
      [/europepmc.*TITLE/, { json: fixture("europepmc/search-doi-nature12373.json") }],
      [/idconv/, { json: { records: [] } }],
    ]);
    const ids = await resolveIds(makeDeps(f.fetch), "Nanometre-scale thermometry in a living cell");
    expect(ids.doi).toBe("10.1038/nature12373");
    expect(ids.resolved_via).toContain("europepmc");
  });

  it("returns an unresolved title when nothing matches", async () => {
    const f = fakeFetch([
      [/search\/match/, { status: 404, json: fixture("semanticscholar/match-not-found.json") }],
      [/europepmc/, { json: { hitCount: 0, resultList: { result: [] } } }],
    ]);
    const ids = await resolveIds(makeDeps(f.fetch), "zzqx flibbertigibbet marmalade");
    expect(ids.doi).toBeUndefined();
    expect(ids.input.kind).toBe("title");
  });

  it("resolves an OpenAlex work id", async () => {
    const f = fakeFetch([
      [/works\/W2159974629/, { json: fixture("openalex/work-nature12373.json") }],
      [
        /idconv/,
        { json: { records: [{ "requested-id": "x", pmcid: "PMC4221854", pmid: 23903748 }] } },
      ],
    ]);
    const ids = await resolveIds(makeDeps(f.fetch), "W2159974629");
    expect(ids).toMatchObject({
      doi: "10.1038/nature12373",
      pmid: "23903748",
      pmcid: "PMC4221854",
    });
  });
});
