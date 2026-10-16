import { beforeEach, describe, expect, it } from "vitest";

import { resetRateLimits } from "../../src/lib/ratelimit.ts";
import {
  getPreprintDetails,
  isPreprintDoi,
  parseBiorxivDetails,
} from "../../src/providers/biorxiv.ts";
import { parseCoreSearch, searchCoreByDoi } from "../../src/providers/core.ts";
import {
  getCrossrefWork,
  parseCrossrefWork,
  parseRetraction,
} from "../../src/providers/crossref.ts";
import {
  fetchEuropePmcFullTextXml,
  getEuropePmcRecord,
  parseEuropePmcSearch,
  searchEuropePmc,
  withYearRange,
} from "../../src/providers/europepmc.ts";
import {
  convertIds,
  efetch,
  parseEsearch,
  parseEsummary,
  parseIdconv,
  searchPubMed,
} from "../../src/providers/pubmed.ts";
import {
  getS2Paper,
  matchS2Title,
  parseS2List,
  parseS2Paper,
  s2LookupId,
  searchS2,
  searchS2Bulk,
} from "../../src/providers/semanticscholar.ts";
import { getUnpaywall, parseUnpaywall } from "../../src/providers/unpaywall.ts";
import { fakeFetch, fixture, makeDeps } from "./helpers.ts";

beforeEach(() => resetRateLimits());

describe("Europe PMC", () => {
  it("parses a core record (nature12373)", () => {
    const { total, records } = parseEuropePmcSearch(
      fixture("europepmc/search-doi-nature12373.json"),
    );
    expect(total).toBe(1);
    const r = records[0];
    expect(r).toMatchObject({
      source: "europepmc",
      doi: "10.1038/nature12373",
      pmid: "23903748",
      pmcid: "PMC4221854",
      title: "Nanometre-scale thermometry in a living cell",
      journal: "Nature",
      issn: ["0028-0836", "1476-4687"],
      year: 2013,
      volume: "500",
      issue: "7460",
      pages: "54-58",
      rank: 0,
      is_oa: true,
    });
    expect(r?.authors?.[0]).toMatchObject({ name: "Kucsko G", orcid: "0000-0002-4189-3154" });
    expect(r?.authors?.[0]?.affiliations?.[0]).toContain("Harvard University");
    expect(r?.mesh).toContain("Fibroblasts");
    expect(r?.abstract).toMatch(/^Sensitive probing/);
    expect(r?.citation_count).toBeGreaterThan(0);
  });

  it("parses a search page with ranks and strips inline markup", () => {
    const { total, records } = parseEuropePmcSearch(
      fixture("europepmc/search-crispr-malaria.json"),
    );
    expect(total).toBeGreaterThan(100);
    expect(records).toHaveLength(5);
    expect(records.map((r) => r.rank)).toEqual([0, 1, 2, 3, 4]);
    for (const r of records) expect(r.title).not.toMatch(/<[a-z]/i);
  });

  it("builds search URLs with sort, year range and page size", async () => {
    const f = fakeFetch([[/europepmc/, { json: fixture("europepmc/search-crispr-malaria.json") }]]);
    await searchEuropePmc(makeDeps(f.fetch), {
      query: "CRISPR AND malaria",
      pageSize: 5,
      sort: "citations",
      fromYear: 2019,
      toYear: 2023,
    });
    const url = new URL(f.calls[0]?.url as string);
    expect(url.searchParams.get("query")).toBe("(CRISPR AND malaria) AND PUB_YEAR:[2019 TO 2023]");
    expect(url.searchParams.get("sort")).toBe("CITED desc");
    expect(url.searchParams.get("resultType")).toBe("core");
    expect(url.searchParams.get("cursorMark")).toBe("*");
    expect(withYearRange("x")).toBe("x");
    expect(withYearRange("x", 2020)).toBe("(x) AND PUB_YEAR:[2020 TO 3000]");
  });

  it("looks up one record by PMID first", async () => {
    const f = fakeFetch([[/europepmc/, { json: fixture("europepmc/search-pmid-33301246.json") }]]);
    const r = await getEuropePmcRecord(makeDeps(f.fetch), {
      pmid: "33301246",
      doi: "10.1056/nejmoa2034577",
    });
    expect(new URL(f.calls[0]?.url as string).searchParams.get("query")).toBe(
      "EXT_ID:33301246 AND SRC:MED",
    );
    expect(r).toMatchObject({
      pmid: "33301246",
      pmcid: "PMC7745181",
      doi: "10.1056/nejmoa2034577",
    });
    expect(await getEuropePmcRecord(makeDeps(f.fetch), {})).toBeNull();
  });

  it("fetches full-text XML and maps 404 to null", async () => {
    const f = fakeFetch([
      [/PMC4221854\/fullTextXML/, { text: "<article><body/></article>" }],
      [/fullTextXML/, { status: 404, text: "" }],
    ]);
    const deps = makeDeps(f.fetch);
    expect(await fetchEuropePmcFullTextXml(deps, "pmc4221854")).toBe("<article><body/></article>");
    expect(await fetchEuropePmcFullTextXml(deps, "PMC1")).toBeNull();
    expect(await fetchEuropePmcFullTextXml(deps, "not-an-id")).toBeNull();
  });
});

describe("Semantic Scholar", () => {
  it("parses a paper with external ids", () => {
    const r = parseS2Paper(fixture("semanticscholar/paper-nature12373.json"));
    expect(r).toMatchObject({
      source: "semanticscholar",
      doi: "10.1038/nature12373",
      pmid: "23903748",
      pmcid: "PMC4221854",
      arxiv: "1304.1068",
      journal: "Nature",
      pages: "54-58",
      oa_status: "bronze",
      pdf_url: "https://www.nature.com/articles/nature12373.pdf",
      author_count: 8,
    });
  });

  it("parses relevance and bulk search envelopes", () => {
    const search = parseS2List(fixture("semanticscholar/search-crispr-malaria.json"));
    expect(search.records.length).toBeGreaterThan(0);
    expect(search.records[0]?.rank).toBe(0);
    const bulk = parseS2List(fixture("semanticscholar/bulk-crispr-malaria.json"), 3);
    expect(bulk.records).toHaveLength(3);
    expect(bulk.total).toBe(551);
  });

  it("sends x-api-key only when configured and slices bulk results", async () => {
    const f = fakeFetch([
      [/search\/bulk/, { json: fixture("semanticscholar/bulk-crispr-malaria.json") }],
      [/paper\/search/, { json: fixture("semanticscholar/search-crispr-malaria.json") }],
    ]);
    await searchS2(makeDeps(f.fetch), { query: "crispr malaria", limit: 5, fromYear: 2020 });
    expect((f.calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
    expect(new URL(f.calls[0]?.url as string).searchParams.get("year")).toBe("2020-");
    const bulk = await searchS2Bulk(makeDeps(f.fetch, { S2_API_KEY: "k123" }), {
      query: "crispr + malaria",
      limit: 2,
      offset: 1,
      sort: "citations",
    });
    expect((f.calls[1]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("k123");
    expect(new URL(f.calls[1]?.url as string).searchParams.get("sort")).toBe("citationCount:desc");
    expect(bulk.records).toHaveLength(2);
  });

  it("title match returns the hit, or null on 404", async () => {
    const hit = fakeFetch([[/match/, { json: fixture("semanticscholar/match-nature12373.json") }]]);
    expect((await matchS2Title(makeDeps(hit.fetch), "x"))?.doi).toBe("10.1038/nature12373");
    const miss = fakeFetch([
      [/match/, { status: 404, json: fixture("semanticscholar/match-not-found.json") }],
    ]);
    expect(await matchS2Title(makeDeps(miss.fetch), "x")).toBeNull();
  });

  it("looks up by prefixed external id", async () => {
    const f = fakeFetch([
      [
        /paper\/DOI:10\.1038\/nature12373\?/,
        { json: fixture("semanticscholar/paper-nature12373.json") },
      ],
    ]);
    expect((await getS2Paper(makeDeps(f.fetch), "DOI:10.1038/nature12373"))?.s2_id).toBeDefined();
    expect(s2LookupId({ pmcid: "PMC4221854" })).toBe("PMCID:4221854");
    expect(s2LookupId({ arxiv: "1304.1068" })).toBe("ARXIV:1304.1068");
    expect(s2LookupId({})).toBeUndefined();
  });
});

describe("PubMed and the ID converter", () => {
  it("parses esearch and esummary", () => {
    expect(parseEsearch(fixture("ncbi/esearch-malaria-mh.json"))).toEqual({
      count: 222,
      ids: ["42714387", "42625514", "42504823", "42457405", "42406963"],
    });
    const [first] = parseEsummary(fixture("ncbi/esummary-2.json"));
    expect(first).toMatchObject({
      source: "pubmed",
      pmid: "42714387",
      doi: "10.1128/aac.00495-26",
      journal: "Antimicrobial agents and chemotherapy",
      issn: ["0066-4804", "1098-6596"],
      year: 2026,
      publication_date: "2026-10-07",
    });
    expect(first?.authors?.at(-1)?.name).toBe("MAREE Consortium");
  });

  it("chains esearch and esummary with dates and the api key", async () => {
    const f = fakeFetch([
      [/esearch/, { json: fixture("ncbi/esearch-malaria-mh.json") }],
      [/esummary/, { json: fixture("ncbi/esummary-2.json") }],
    ]);
    const res = await searchPubMed(makeDeps(f.fetch, { NCBI_API_KEY: "nk" }), {
      term: "malaria[mh] AND crispr[tiab]",
      retmax: 5,
      mindate: 2020,
    });
    const search = new URL(f.calls[0]?.url as string).searchParams;
    expect(search.get("term")).toBe("malaria[mh] AND crispr[tiab]");
    expect(search.get("datetype")).toBe("pdat");
    expect(search.get("mindate")).toBe("2020");
    expect(search.get("api_key")).toBe("nk");
    expect(search.get("tool")).toBe("doily");
    expect(res.total).toBe(222);
    expect(res.records.map((r) => r.pmid)).toEqual(["42714387", "42625514"]);
  });

  it("parses the converter, normalizing numeric PMIDs to strings", async () => {
    expect(parseIdconv(fixture("ncbi/idconv-33301246.json"))).toEqual([
      {
        requested: "33301246",
        doi: "10.1056/nejmoa2034577",
        pmid: "33301246",
        pmcid: "PMC7745181",
      },
    ]);
    const f = fakeFetch([[/idconv/, { json: fixture("ncbi/idconv-33301246.json") }]]);
    expect(await convertIds(makeDeps(f.fetch), [])).toEqual([]);
    expect((await convertIds(makeDeps(f.fetch), ["33301246"]))[0]?.pmcid).toBe("PMC7745181");
  });

  it("efetch returns raw text", async () => {
    const f = fakeFetch([[/efetch/, { text: "<pmc-articleset/>" }]]);
    expect(await efetch(makeDeps(f.fetch), ["PMC7745181"], { db: "pmc" })).toBe(
      "<pmc-articleset/>",
    );
    expect(f.calls[0]?.url).toContain("db=pmc");
  });
});

describe("Crossref", () => {
  it("parses the work of record (nature12373)", () => {
    const w = parseCrossrefWork(
      fixture<{ message: object }>("crossref/work-nature12373.json").message,
    );
    expect(w.record).toMatchObject({
      source: "crossref",
      doi: "10.1038/nature12373",
      title: "Nanometre-scale thermometry in a living cell",
      journal: "Nature",
      issn: ["0028-0836", "1476-4687"],
      publication_date: "2013-07-31",
      year: 2013,
      type: "journal-article",
    });
    expect(w.issn_print).toBe("0028-0836");
    expect(w.tdm_links[0]?.url).toBe("http://www.nature.com/articles/nature12373.pdf");
    expect(w.licenses[0]?.url).toBe("http://www.springer.com/tdm");
    expect(w.retraction).toEqual({ status: "none", is_notice: false, notices: [] });
  });

  it("detects a retraction from updated-by (Wakefield 1998)", () => {
    const w = parseCrossrefWork(
      fixture<{ message: object }>("crossref/work-wakefield-retracted.json").message,
    );
    expect(w.record.is_retracted).toBe(true);
    expect(w.retraction.status).toBe("retracted");
    expect(w.retraction.is_notice).toBe(false);
    expect(w.retraction.notices).toEqual([
      expect.objectContaining({
        type: "correction",
        source: "retraction-watch",
        date: "2004-03-06",
      }),
      expect.objectContaining({
        type: "retraction",
        doi: "10.1016/s0140-6736(10)60175-4",
        source: "retraction-watch",
        date: "2010-02-06",
      }),
    ]);
  });

  it("recognizes a retraction notice via update-to", () => {
    const r = parseRetraction({
      DOI: "10.1016/S0140-6736(10)60175-4",
      "update-to": [
        { DOI: "10.1016/S0140-6736(97)11096-0", type: "retraction", label: "Retraction" },
      ],
    });
    expect(r.is_notice).toBe(true);
    expect(r.status).toBe("none");
    expect(r.notices[0]?.doi).toBe("10.1016/s0140-6736(97)11096-0");
    expect(parseRetraction({ "updated-by": [{ type: "expression_of_concern" }] }).status).toBe(
      "expression_of_concern",
    );
  });

  it("sends mailto and maps 404 to null", async () => {
    const f = fakeFetch([
      [/nature12373/, { json: fixture("crossref/work-nature12373.json") }],
      [/crossref/, { status: 404, text: "Resource not found." }],
    ]);
    const deps = makeDeps(f.fetch);
    expect((await getCrossrefWork(deps, "10.1038/nature12373"))?.record.doi).toBe(
      "10.1038/nature12373",
    );
    expect(f.calls[0]?.url).toBe(
      "https://api.crossref.org/works/10.1038/nature12373?mailto=pmaxhogan%40gmail.com",
    );
    expect(await getCrossrefWork(deps, "10.9999/none")).toBeNull();
  });
});

describe("Unpaywall", () => {
  it("parses OA status and locations", async () => {
    const u = parseUnpaywall(fixture("unpaywall/nature12373.json"));
    expect(u).toMatchObject({ doi: "10.1038/nature12373", is_oa: true, oa_status: "bronze" });
    expect(u.best_oa_location).toMatchObject({
      url_for_pdf: "https://www.nature.com/articles/nature12373.pdf",
      host_type: "publisher",
    });
    expect(u.oa_locations.length).toBeGreaterThan(1);
    const f = fakeFetch([[/unpaywall/, { json: fixture("unpaywall/nature12373.json") }]]);
    await getUnpaywall(makeDeps(f.fetch, { CONTACT_EMAIL: "a@b.c" }), "10.1038/nature12373");
    expect(f.calls[0]?.url).toBe("https://api.unpaywall.org/v2/10.1038/nature12373?email=a%40b.c");
  });
});

describe("CORE", () => {
  it("is skipped entirely without a key", async () => {
    const f = fakeFetch([]);
    expect(await searchCoreByDoi(makeDeps(f.fetch), "10.1/x")).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("uses a bearer token and prefers outputs with a download", async () => {
    // Synthetic body in the documented v3 shape (no key available to record one).
    const body = {
      totalHits: 2,
      results: [
        { id: 1, title: "t", doi: "10.1/X", downloadUrl: "", fullText: null },
        { id: 2, title: "t", doi: "10.1/X", downloadUrl: "https://core.ac.uk/download/2.pdf" },
      ],
    };
    const f = fakeFetch([[/core\.ac\.uk/, { json: body }]]);
    const out = await searchCoreByDoi(makeDeps(f.fetch, { CORE_API_KEY: "ck" }), "10.1/x");
    expect(out).toMatchObject({
      id: "2",
      download_url: "https://core.ac.uk/download/2.pdf",
      doi: "10.1/x",
    });
    expect((f.calls[0]?.init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer ck",
    );
    expect(new URL(f.calls[0]?.url as string).searchParams.get("q")).toBe('doi:"10.1/x"');
    expect(parseCoreSearch({})).toEqual([]);
  });
});

describe("bioRxiv", () => {
  it("parses versions, JATS path and the published DOI", () => {
    const d = parseBiorxivDetails(fixture("biorxiv/details-2020.03.22.002386.json"), "biorxiv");
    expect(d).toMatchObject({
      server: "biorxiv",
      doi: "10.1101/2020.03.22.002386",
      published_doi: "10.1038/s41586-020-2286-9",
      pdf_url: "https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3.full.pdf",
    });
    expect(d?.versions.map((v) => v.version)).toEqual(["1", "2", "3"]);
    expect(d?.latest.jatsxml).toMatch(/\.source\.xml$/);
    expect(parseBiorxivDetails({ collection: [] }, "biorxiv")).toBeNull();
  });

  it("falls back to medRxiv when bioRxiv has no record", async () => {
    const f = fakeFetch([
      [/details\/biorxiv/, { json: { messages: [{ status: "no posts found" }], collection: [] } }],
      [/details\/medrxiv/, { json: fixture("biorxiv/details-2020.03.22.002386.json") }],
    ]);
    const d = await getPreprintDetails(makeDeps(f.fetch), "10.1101/2020.03.22.002386");
    expect(d?.server).toBe("medrxiv");
    expect(d?.pdf_url).toContain("www.medrxiv.org");
    expect(isPreprintDoi("10.1101/2020.03.22.002386")).toBe(true);
    expect(isPreprintDoi("10.64898/2026.03.17.712112")).toBe(true);
    expect(isPreprintDoi("10.1038/nature12373")).toBe(false);
  });
});
