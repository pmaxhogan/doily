import { describe, expect, it } from "vitest";
import { z } from "zod";

import { putPdf, putText, verifyDownloadToken } from "../../../src/fulltext/cache.ts";
import { doiFromDownloadPath, downloadFilename } from "../../../src/fulltext/download.ts";
import { tools } from "../../../src/tools/index.ts";
import {
  getFullText,
  getPdf,
  setChainOptions,
  unavailableBody,
} from "../../../src/tools/fulltext.ts";
import { fakeFetch, makeDeps, NOW } from "../helpers.ts";
import { fakeR2 } from "./fake-r2.ts";
import { makePdf } from "./make-pdf.ts";

import type { Env } from "../../../src/env.ts";
import type { ToolDeps } from "../../../src/tools/types.ts";

const DOI = "10.1234/tool.test";
const SECRET = "test-secret-for-tools";

function setup(env: Partial<Env> = {}) {
  const r2 = fakeR2();
  const f = fakeFetch([
    [/idconv/, { json: { records: [{ doi: DOI }] } }],
    [/api\.unpaywall\.org|api\.openalex\.org|api\.semanticscholar\.org/, { status: 404 }],
  ]);
  const deps = makeDeps(f.fetch, { PDFS: r2.bucket, ...env }) as unknown as ToolDeps;
  return { r2, f, deps };
}

describe("get_full_text", () => {
  it("pages long cached text at 60000 chars", async () => {
    const { deps, r2 } = setup();
    const para = "word ".repeat(999) + "end.\n\n";
    const text = para.repeat(30);
    await putText(r2.bucket, DOI, text, { source: "unpaywall", format: "pdf" }, NOW);

    const first = (await getFullText(deps, { id: DOI })) as Record<string, unknown>;
    expect(first).toMatchObject({
      status: "ok",
      doi: DOI,
      source: "unpaywall",
      format: "pdf",
      total_chars: text.length,
      offset: 0,
      attempts: [],
    });
    const next = first["next_offset"] as number;
    expect(next).toBeGreaterThan(30_000);
    expect(next).toBeLessThanOrEqual(60_000);
    expect((first["text"] as string).length).toBe(next);

    const second = (await getFullText(deps, { id: DOI, offset: next })) as Record<string, unknown>;
    expect(second["offset"]).toBe(next);
  });

  it("returns the unavailable body as a normal result", async () => {
    const { deps } = setup();
    setChainOptions({ hops: [{ source: "only", run: async () => ({ outcome: "miss" }) }] });
    try {
      const body = await getFullText(deps, { id: DOI });
      expect(body).toEqual({
        status: "unavailable",
        doi: DOI,
        attempts: [{ source: "only", outcome: "miss", ms: 0 }],
      });
    } finally {
      setChainOptions({});
    }
  });

  it("builds the unavailable body in one extensible function", async () => {
    const { deps } = setup();
    expect(await unavailableBody(deps, DOI, [])).toEqual({
      status: "unavailable",
      doi: DOI,
      attempts: [],
    });
  });
});

describe("get_pdf", () => {
  it("returns a signed link that verifies, plus the resource URI", async () => {
    const { deps, r2 } = setup({ REQUEST_TOKEN_SECRET: SECRET });
    const pdf = makePdf([["hello"]]);
    await putPdf(r2.bucket, DOI, pdf, { source: "unpaywall" }, NOW);
    const body = (await getPdf(deps, { id: DOI })) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      doi: DOI,
      source: "unpaywall",
      resource_uri: `doily://pdf/${DOI}`,
      size_bytes: pdf.byteLength,
      expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
    });
    const url = new URL(body["url"] as string);
    expect(url.origin).toBe("https://doily.test");
    expect(url.pathname).toBe("/download/10.1234/tool.test");
    expect(
      await verifyDownloadToken(
        SECRET,
        DOI,
        url.searchParams.get("exp") ?? "",
        url.searchParams.get("sig") ?? "",
        NOW,
      ),
    ).toBe(true);
  });

  it("still answers without a signing key", async () => {
    const { deps, r2 } = setup();
    await putPdf(r2.bucket, DOI, makePdf([["x"]]), { source: "unpaywall" }, NOW);
    const body = (await getPdf(deps, { id: DOI })) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["url"]).toBeUndefined();
    expect(body["url_unavailable"]).toContain("REQUEST_TOKEN_SECRET");
  });

  it("returns the no_pdf body when nothing yields a PDF", async () => {
    const { deps } = setup();
    setChainOptions({ hops: [] });
    try {
      expect(await getPdf(deps, { id: DOI })).toEqual({
        status: "no_pdf",
        doi: DOI,
        text_available: false,
        attempts: [],
      });
    } finally {
      setChainOptions({});
    }
  });
});

describe("tool registration", () => {
  it("lists get_full_text and get_pdf after get_journal, read-only, with examples", () => {
    const names = tools.map((t) => t.name);
    const at = names.indexOf("get_journal");
    expect(names.slice(at + 1, at + 3)).toEqual(["get_full_text", "get_pdf"]);
    for (const name of ["get_full_text", "get_pdf"]) {
      const def = tools.find((t) => t.name === name);
      expect(def?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
      expect(def?.description).toMatch(/Example: \{/);
      for (const [field, schema] of Object.entries(def?.inputSchema ?? {})) {
        expect((schema as z.ZodType).description, `${name}.${field}`).toBeTruthy();
      }
    }
  });

  it("rejects a negative offset", () => {
    const def = tools.find((t) => t.name === "get_full_text");
    const schema = z.object(def?.inputSchema ?? {});
    expect(schema.safeParse({ id: DOI, offset: -1 }).success).toBe(false);
    expect(schema.safeParse({ id: DOI, offset: 10, include_references: true }).success).toBe(true);
  });
});

describe("download path helpers", () => {
  it("percent-decodes and lowercases the DOI", () => {
    expect(doiFromDownloadPath("/download/10.1038/Nature12373")).toBe("10.1038/nature12373");
    expect(doiFromDownloadPath("/download/10.1002/%3CSICI%3E1%3B2-x")).toBe("10.1002/<sici>1;2-x");
  });

  it("rejects non-DOIs, traversal and bad escapes", () => {
    expect(doiFromDownloadPath("/download/")).toBeNull();
    expect(doiFromDownloadPath("/download/not-a-doi")).toBeNull();
    expect(doiFromDownloadPath("/download/10.1038/../../text/x")).toBeNull();
    expect(doiFromDownloadPath("/download/10.1038/%E0%A4%A")).toBeNull();
  });

  it("makes a quote-safe filename", () => {
    expect(downloadFilename("10.1038/nature12373")).toBe("10.1038_nature12373.pdf");
    expect(downloadFilename('10.1/a"b')).toBe("10.1_a_b.pdf");
  });
});
