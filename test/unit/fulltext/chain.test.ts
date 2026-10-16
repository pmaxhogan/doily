import { describe, expect, it } from "vitest";
import jatsXml from "../../fixtures/fulltext/PMC3123456.xml?raw";

import {
  builtInHops,
  obtainFullText,
  obtainPdf,
  type Hop,
  type HopContext,
} from "../../../src/fulltext/chain.ts";
import { putJats, putPdf, putText } from "../../../src/fulltext/cache.ts";
import { fakeFetch, makeDeps, NOW, type Reply } from "../helpers.ts";
import { fakeR2 } from "./fake-r2.ts";
import { makePdf } from "./make-pdf.ts";

import type { Env } from "../../../src/env.ts";
import type { ToolDeps } from "../../../src/tools/types.ts";

const DOI = "10.1234/test.5678";
const PMCID = "PMC3123456";
const PDF = makePdf([
  ["A test paper about open access.", "It has enough words to be extracted by unpdf."],
  ["Second page with more text for the extractor to find here."],
]);
const PDF_REPLY: Reply = {
  text: new TextDecoder("latin1").decode(PDF),
  headers: { "content-type": "application/pdf" },
};
const HTML_REPLY: Reply = { text: "<html></html>", headers: { "content-type": "text/html" } };

type Route = [RegExp, Reply | ((url: string) => Reply)];

/** Every upstream misses unless a route earlier in the list answers first. */
const MISSES: Route[] = [
  [/idconv/, { json: { records: [{ "requested-id": DOI, doi: DOI }] } }],
  [/europepmc.*fullTextXML/, { status: 404 }],
  [/efetch/, { text: "<pmc-articleset><error>not available</error></pmc-articleset>" }],
  [/api\.unpaywall\.org/, { status: 404 }],
  [/api\.openalex\.org/, { status: 404 }],
  [/api\.semanticscholar\.org/, { status: 404 }],
  [/api\.biorxiv\.org/, { json: { collection: [] } }],
  [/api\.core\.ac\.uk/, { json: { results: [] } }],
];

function setup(routes: Route[] = [], env: Partial<Env> = {}) {
  const r2 = fakeR2();
  const f = fakeFetch([...routes, ...MISSES]);
  const deps = makeDeps(f.fetch, { PDFS: r2.bucket, ...env }) as unknown as ToolDeps;
  return { r2, f, deps };
}

function ctxFor(deps: ToolDeps, ids: Partial<HopContext["ids"]> = {}): HopContext {
  return {
    deps,
    doi: DOI,
    ids: { input: { kind: "doi", value: DOI }, doi: DOI, resolved_via: [], ...ids },
  };
}

function hop(name: string): Hop {
  const found = builtInHops().find((h) => h.source === name);
  if (!found) throw new Error(name);
  return found;
}

const FAST = { hopTimeoutMs: 1000, fetchPdf: { timeoutMs: 1000 } };

describe("built-in hops", () => {
  it("are in the locked order", () => {
    expect(builtInHops().map((h) => h.source)).toEqual([
      "pmc_jats",
      "unpaywall",
      "openalex_oa",
      "s2_oa",
      "biorxiv",
      "core",
    ]);
  });

  describe("pmc_jats", () => {
    it("is no_pmcid without a PMCID", async () => {
      const { deps } = setup();
      expect(await hop("pmc_jats").run(ctxFor(deps))).toEqual({ outcome: "no_pmcid" });
    });

    it("hits on Europe PMC fullTextXML", async () => {
      const { deps, f } = setup([[/europepmc.*PMC3123456\/fullTextXML/, { text: jatsXml }]]);
      const r = await hop("pmc_jats").run(ctxFor(deps, { pmcid: PMCID }));
      expect(r).toMatchObject({ outcome: "hit", format: "jats", jats: jatsXml });
      expect(f.calls.some((c) => c.url.includes("efetch"))).toBe(false);
    });

    it("falls back to NCBI efetch db=pmc with the numeric id", async () => {
      const { deps, f } = setup([[/efetch/, { text: jatsXml }]]);
      const r = await hop("pmc_jats").run(ctxFor(deps, { pmcid: PMCID }));
      expect(r).toMatchObject({ outcome: "hit", format: "jats" });
      const call = f.calls.find((c) => c.url.includes("efetch"));
      expect(call?.url).toContain("db=pmc");
      expect(call?.url).toContain("id=3123456");
    });

    it("misses when neither has a body", async () => {
      const { deps } = setup();
      const r = await hop("pmc_jats").run(ctxFor(deps, { pmcid: PMCID }));
      expect(r.outcome).toBe("miss");
    });
  });

  describe("unpaywall", () => {
    it("tries best_oa_location first, then other oa_locations", async () => {
      const { deps, f } = setup([
        [
          /api\.unpaywall\.org/,
          {
            json: {
              doi: DOI,
              is_oa: true,
              best_oa_location: { url_for_pdf: "https://pub.example/best.pdf" },
              oa_locations: [
                { url_for_pdf: "https://pub.example/best.pdf" },
                { url_for_pdf: null, url: "https://repo.example/landing" },
                { url_for_pdf: "https://repo.example/copy.pdf" },
              ],
            },
          },
        ],
        [/pub\.example\/best\.pdf/, HTML_REPLY],
        [/repo\.example\/copy\.pdf/, PDF_REPLY],
      ]);
      const r = await hop("unpaywall").run(ctxFor(deps));
      expect(r).toMatchObject({ outcome: "hit", format: "pdf" });
      const pdfCalls = f.calls.filter((c) => /pub\.example|repo\.example/.test(c.url));
      expect(pdfCalls.map((c) => c.url)).toEqual([
        "https://pub.example/best.pdf",
        "https://repo.example/copy.pdf",
      ]);
    });

    it("reports landing_page when every URL is an HTML page", async () => {
      const { deps } = setup([
        [
          /api\.unpaywall\.org/,
          {
            json: {
              doi: DOI,
              best_oa_location: { url_for_pdf: "https://pub.example/x" },
              oa_locations: [],
            },
          },
        ],
        [/pub\.example/, HTML_REPLY],
      ]);
      expect((await hop("unpaywall").run(ctxFor(deps))).outcome).toBe("landing_page");
    });

    it("misses when Unpaywall has no PDF URL", async () => {
      const { deps } = setup([[/api\.unpaywall\.org/, { json: { doi: DOI, oa_locations: [] } }]]);
      expect(await hop("unpaywall").run(ctxFor(deps))).toEqual({
        outcome: "miss",
        detail: "no open-access PDF URL",
      });
    });

    it("reports over_cap for a PDF over the limit", async () => {
      const { deps } = setup([
        [
          /api\.unpaywall\.org/,
          {
            json: {
              doi: DOI,
              best_oa_location: { url_for_pdf: "https://pub.example/x.pdf" },
              oa_locations: [],
            },
          },
        ],
        [/pub\.example/, PDF_REPLY],
      ]);
      const hops = builtInHops({ maxBytes: 10 });
      const r = await (hops[1] as Hop).run(ctxFor(deps));
      expect(r.outcome).toBe("over_cap");
    });
  });

  describe("openalex_oa", () => {
    it("hits on best_oa_location.pdf_url", async () => {
      const { deps } = setup([
        [
          /api\.openalex\.org/,
          {
            json: {
              best_oa_location: { pdf_url: "https://oa.example/a.pdf" },
              open_access: { oa_url: "https://oa.example/landing" },
            },
          },
        ],
        [/oa\.example\/a\.pdf/, PDF_REPLY],
      ]);
      expect((await hop("openalex_oa").run(ctxFor(deps))).outcome).toBe("hit");
    });

    it("misses when OpenAlex does not know the DOI", async () => {
      const { deps } = setup();
      expect((await hop("openalex_oa").run(ctxFor(deps))).outcome).toBe("miss");
    });
  });

  describe("s2_oa", () => {
    it("hits on openAccessPdf.url", async () => {
      const { deps, f } = setup([
        [
          /api\.semanticscholar\.org/,
          { json: { paperId: "x", openAccessPdf: { url: "https://s2.example/p.pdf" } } },
        ],
        [/s2\.example/, PDF_REPLY],
      ]);
      expect((await hop("s2_oa").run(ctxFor(deps))).outcome).toBe("hit");
      expect(f.calls.find((c) => c.url.includes("semanticscholar"))?.url).toContain(`DOI:${DOI}`);
    });

    it("misses without an openAccessPdf", async () => {
      const { deps } = setup([[/api\.semanticscholar\.org/, { json: { paperId: "x" } }]]);
      expect((await hop("s2_oa").run(ctxFor(deps))).outcome).toBe("miss");
    });
  });

  describe("biorxiv", () => {
    const PRE = "10.1101/2020.03.22.002386";
    const details = (jatsxml: string) => ({
      json: { collection: [{ doi: PRE, version: "2", jatsxml }] },
    });

    it("skips DOIs outside the CSHL prefixes without a request", async () => {
      const { deps, f } = setup();
      expect((await hop("biorxiv").run(ctxFor(deps))).outcome).toBe("miss");
      expect(f.calls).toHaveLength(0);
    });

    it("hits on the JATS XML", async () => {
      const { deps } = setup([
        [/api\.biorxiv\.org/, details("https://www.biorxiv.org/content/early/x.source.xml")],
        [/source\.xml/, { text: jatsXml }],
      ]);
      const r = await hop("biorxiv").run({ ...ctxFor(deps), doi: PRE });
      expect(r).toMatchObject({ outcome: "hit", format: "jats" });
    });

    it("falls back to the .full.pdf", async () => {
      const { deps, f } = setup([
        [/api\.biorxiv\.org/, details("")],
        [/v2\.full\.pdf/, PDF_REPLY],
      ]);
      const r = await hop("biorxiv").run({ ...ctxFor(deps), doi: PRE });
      expect(r).toMatchObject({ outcome: "hit", format: "pdf" });
      expect(
        f.calls.some((c) => c.url === `https://www.biorxiv.org/content/${PRE}v2.full.pdf`),
      ).toBe(true);
    });
  });

  describe("core", () => {
    it("is no_key without CORE_API_KEY and makes no request", async () => {
      const { deps, f } = setup();
      expect((await hop("core").run(ctxFor(deps))).outcome).toBe("no_key");
      expect(f.calls).toHaveLength(0);
    });

    it("hits on downloadUrl", async () => {
      const { deps } = setup(
        [
          [
            /api\.core\.ac\.uk/,
            { json: { results: [{ downloadUrl: "https://core.example/d.pdf" }] } },
          ],
          [/core\.example/, PDF_REPLY],
        ],
        { CORE_API_KEY: "test-core" },
      );
      expect(await hop("core").run(ctxFor(deps))).toMatchObject({ outcome: "hit", format: "pdf" });
    });

    it("falls back to fullText when the download is a landing page", async () => {
      const { deps } = setup(
        [
          [
            /api\.core\.ac\.uk/,
            {
              json: {
                results: [{ downloadUrl: "https://core.example/d", fullText: "Body text." }],
              },
            },
          ],
          [/core\.example/, HTML_REPLY],
        ],
        { CORE_API_KEY: "test-core" },
      );
      expect(await hop("core").run(ctxFor(deps))).toEqual({
        outcome: "hit",
        format: "pdf",
        text: "Body text.",
      });
    });
  });
});

describe("obtainFullText", () => {
  it("returns and caches JATS from pmc_jats", async () => {
    const { deps, r2 } = setup([
      [/idconv/, { json: { records: [{ doi: DOI, pmcid: PMCID }] } }],
      [/fullTextXML/, { text: jatsXml }],
    ]);
    const r = await obtainFullText(deps, DOI, FAST);
    expect(r).toMatchObject({ status: "ok", doi: DOI, source: "pmc_jats", format: "jats" });
    if (r.status !== "ok") throw new Error("unreachable");
    expect(r.text.startsWith("# The Structural Biology Knowledgebase")).toBe(true);
    expect(r.text).not.toContain("## References");
    expect(r.attempts).toEqual([{ source: "pmc_jats", outcome: "hit", ms: 0 }]);
    expect(new TextDecoder().decode(r2.store.get(`jats/${DOI}.xml`)?.body)).toBe(jatsXml);
    const text = r2.store.get(`text/${DOI}.md`);
    expect(text?.options?.customMetadata).toEqual({
      source: "pmc_jats",
      fetched_at: NOW.toISOString(),
      format: "jats",
    });
  });

  it("includes references from a fresh JATS hit when asked", async () => {
    const { deps } = setup([
      [/idconv/, { json: { records: [{ doi: DOI, pmcid: PMCID }] } }],
      [/fullTextXML/, { text: jatsXml }],
    ]);
    const r = await obtainFullText(deps, DOI, { ...FAST, includeReferences: true });
    expect(r.status === "ok" && r.text.includes("## References")).toBe(true);
  });

  it("caches a PDF and its extracted text", async () => {
    const { deps, r2 } = setup([
      [
        /api\.unpaywall\.org/,
        {
          json: {
            doi: DOI,
            best_oa_location: { url_for_pdf: "https://pub.example/p.pdf" },
            oa_locations: [],
          },
        },
      ],
      [/pub\.example/, PDF_REPLY],
    ]);
    const r = await obtainFullText(deps, DOI, FAST);
    expect(r).toMatchObject({ status: "ok", source: "unpaywall", format: "pdf" });
    if (r.status !== "ok") throw new Error("unreachable");
    expect(r.text).toContain("A test paper about open access.");
    expect(r.attempts.map((a) => [a.source, a.outcome])).toEqual([
      ["pmc_jats", "no_pmcid"],
      ["unpaywall", "hit"],
    ]);
    expect(r2.store.get(`pdf/${DOI}.pdf`)?.body.byteLength).toBe(PDF.byteLength);
    expect(r2.store.get(`text/${DOI}.md`)?.options?.customMetadata?.["format"]).toBe("pdf");
  });

  it("short-circuits on cached text without any upstream request", async () => {
    const { deps, r2, f } = setup();
    await putText(r2.bucket, DOI, "cached body", { source: "s2_oa", format: "pdf" }, NOW);
    const r = await obtainFullText(deps, DOI, FAST);
    expect(r).toEqual({
      status: "ok",
      doi: DOI,
      source: "s2_oa",
      format: "pdf",
      text: "cached body",
      attempts: [],
      cached: true,
    });
    expect(f.calls.filter((c) => !c.url.includes("idconv"))).toHaveLength(0);
  });

  it("re-renders cached JATS when references are asked for", async () => {
    const { deps, r2 } = setup();
    await putText(r2.bucket, DOI, "no refs", { source: "pmc_jats", format: "jats" }, NOW);
    await putJats(r2.bucket, DOI, jatsXml, { source: "pmc_jats" }, NOW);
    const r = await obtainFullText(deps, DOI, { ...FAST, includeReferences: true });
    expect(r.status === "ok" && r.text.includes("## References")).toBe(true);
  });

  it("flags references_unavailable when no JATS is cached", async () => {
    const { deps, r2 } = setup();
    await putText(r2.bucket, DOI, "pdf text", { source: "unpaywall", format: "pdf" }, NOW);
    const r = await obtainFullText(deps, DOI, { ...FAST, includeReferences: true });
    expect(r).toMatchObject({ status: "ok", text: "pdf text", references_unavailable: true });
  });

  it("extracts text from a PDF cached by get_pdf", async () => {
    const { deps, r2, f } = setup();
    await putPdf(r2.bucket, DOI, PDF, { source: "s2_oa" }, NOW);
    const r = await obtainFullText(deps, DOI, FAST);
    expect(r).toMatchObject({ status: "ok", source: "s2_oa", format: "pdf", cached: true });
    expect(r2.store.has(`text/${DOI}.md`)).toBe(true);
    expect(f.calls.filter((c) => !c.url.includes("idconv"))).toHaveLength(0);
  });

  it("runs extraHops after the built-in hops, in order", async () => {
    const order: string[] = [];
    const extra = (name: string, result: Awaited<ReturnType<Hop["run"]>>): Hop => ({
      source: name,
      async run(ctx) {
        expect(ctx.doi).toBe(DOI);
        order.push(name);
        return result;
      },
    });
    const { deps } = setup();
    const r = await obtainFullText(deps, DOI, {
      ...FAST,
      extraHops: [
        extra("first_extra", { outcome: "miss" }),
        extra("second_extra", { outcome: "hit", format: "pdf", text: "from the extra hop" }),
        extra("never", { outcome: "miss" }),
      ],
    });
    expect(order).toEqual(["first_extra", "second_extra"]);
    expect(r).toMatchObject({ status: "ok", source: "second_extra", text: "from the extra hop" });
    if (r.status !== "ok") throw new Error("unreachable");
    expect(r.attempts.map((a) => a.source)).toEqual([
      "pmc_jats",
      "unpaywall",
      "openalex_oa",
      "s2_oa",
      "biorxiv",
      "core",
      "first_extra",
      "second_extra",
    ]);
  });

  it("is unavailable with every attempt recorded", async () => {
    const { deps } = setup();
    const r = await obtainFullText(deps, DOI, FAST);
    expect(r.status).toBe("unavailable");
    expect(r.doi).toBe(DOI);
    expect(r.attempts.map((a) => [a.source, a.outcome])).toEqual([
      ["pmc_jats", "no_pmcid"],
      ["unpaywall", "miss"],
      ["openalex_oa", "miss"],
      ["s2_oa", "miss"],
      ["biorxiv", "miss"],
      ["core", "no_key"],
    ]);
  });

  it("records a throwing hop as error and a stuck hop as timeout", async () => {
    const { deps } = setup();
    const r = await obtainFullText(deps, DOI, {
      hops: [
        { source: "boom", run: async () => Promise.reject(new Error("kaput")) },
        { source: "stuck", run: () => new Promise(() => undefined) },
      ],
      hopTimeoutMs: 20,
    });
    expect(r.attempts).toEqual([
      { source: "boom", outcome: "error", ms: 0, detail: "kaput" },
      { source: "stuck", outcome: "timeout", ms: 0, detail: "no answer within 20 ms" },
    ]);
  });

  it("records bad_pdf and moves on when a PDF has no extractable text", async () => {
    const { deps } = setup();
    const r = await obtainFullText(deps, DOI, {
      ...FAST,
      hops: [
        {
          source: "garbage",
          run: async () => ({
            outcome: "hit",
            format: "pdf",
            pdf: new TextEncoder().encode("%PDF-junk"),
          }),
        },
        { source: "good", run: async () => ({ outcome: "hit", format: "pdf", text: "fine" }) },
      ],
    });
    expect(r).toMatchObject({ status: "ok", source: "good" });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["bad_pdf", "hit"]);
  });

  it("resolves a PMCID to its DOI before running", async () => {
    const { deps } = setup([
      [/idconv/, { json: { records: [{ doi: DOI, pmcid: PMCID }] } }],
      [/fullTextXML/, { text: jatsXml }],
    ]);
    expect(await obtainFullText(deps, PMCID, FAST)).toMatchObject({ status: "ok", doi: DOI });
  });

  it("throws a ToolError when no DOI can be found", async () => {
    const { deps } = setup([
      [/idconv/, { json: { records: [{ pmcid: PMCID }] } }],
      [/api\.openalex\.org/, { status: 404 }],
    ]);
    await expect(obtainFullText(deps, PMCID, FAST)).rejects.toThrow("could not resolve");
  });
});

describe("obtainPdf", () => {
  it("returns a PDF hit and caches it without extracting text", async () => {
    const { deps, r2 } = setup([
      [
        /api\.semanticscholar\.org/,
        { json: { paperId: "x", openAccessPdf: { url: "https://s2.example/p.pdf" } } },
      ],
      [/s2\.example/, PDF_REPLY],
    ]);
    const r = await obtainPdf(deps, DOI, FAST);
    expect(r).toMatchObject({
      status: "ok",
      doi: DOI,
      source: "s2_oa",
      size_bytes: PDF.byteLength,
    });
    expect(r2.store.has(`pdf/${DOI}.pdf`)).toBe(true);
    expect(r2.store.has(`text/${DOI}.md`)).toBe(false);
  });

  it("short-circuits on a cached PDF", async () => {
    const { deps, r2, f } = setup();
    await putPdf(r2.bucket, DOI, PDF, { source: "unpaywall" }, NOW);
    expect(await obtainPdf(deps, DOI, FAST)).toEqual({
      status: "ok",
      doi: DOI,
      source: "unpaywall",
      size_bytes: PDF.byteLength,
      attempts: [],
      cached: true,
    });
    expect(f.calls.filter((c) => !c.url.includes("idconv"))).toHaveLength(0);
  });

  it("caches a JATS hit as text, keeps looking, and reports text_available", async () => {
    const { deps, r2 } = setup([
      [/idconv/, { json: { records: [{ doi: DOI, pmcid: PMCID }] } }],
      [/fullTextXML/, { text: jatsXml }],
    ]);
    const r = await obtainPdf(deps, DOI, FAST);
    expect(r).toMatchObject({ status: "no_pdf", doi: DOI, text_available: true });
    expect(r.attempts[0]).toMatchObject({ source: "pmc_jats", outcome: "text_only" });
    expect(r.attempts).toHaveLength(6);
    expect(r2.store.has(`text/${DOI}.md`)).toBe(true);
    expect(r2.store.has(`jats/${DOI}.xml`)).toBe(true);
  });

  it("is no_pdf without text when nothing works", async () => {
    const { deps } = setup();
    expect(await obtainPdf(deps, DOI, FAST)).toMatchObject({
      status: "no_pdf",
      text_available: false,
    });
  });
});
