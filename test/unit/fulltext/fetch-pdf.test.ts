import { describe, expect, it } from "vitest";

import { fetchPdf } from "../../../src/fulltext/fetch-pdf.ts";
import { fakeFetch, makeDeps } from "../helpers.ts";

const PDF_TEXT = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n";

function deps(fetch: typeof globalThis.fetch) {
  return makeDeps(fetch, { CONTACT_EMAIL: "me@example.test" });
}

describe("fetchPdf", () => {
  it("returns the bytes of a PDF with polite headers and manual redirects", async () => {
    const f = fakeFetch([
      [/a\.example/, { text: PDF_TEXT, headers: { "content-type": "application/pdf" } }],
    ]);
    const res = await fetchPdf(deps(f.fetch), "https://a.example/paper.pdf");
    expect(res.kind).toBe("pdf");
    if (res.kind === "pdf") expect(new TextDecoder().decode(res.bytes)).toBe(PDF_TEXT);
    const init = f.calls[0]?.init;
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("mailto:me@example.test");
    expect(headers["Accept"]).toBe("application/pdf,*/*;q=0.8");
    expect(init?.redirect).toBe("manual");
  });

  it("accepts a PDF served as octet-stream with leading whitespace", async () => {
    const f = fakeFetch([
      [/./, { text: `\r\n${PDF_TEXT}`, headers: { "content-type": "application/octet-stream" } }],
    ]);
    expect((await fetchPdf(deps(f.fetch), "https://a.example/x")).kind).toBe("pdf");
  });

  it("rejects http and non-http schemes without fetching", async () => {
    const f = fakeFetch([]);
    for (const url of [
      "http://a.example/x.pdf",
      "ftp://a.example/x.pdf",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const res = await fetchPdf(deps(f.fetch), url);
      expect(res).toMatchObject({ kind: "error", code: "bad_url" });
    }
    expect(f.calls).toHaveLength(0);
  });

  it("follows https redirects, resolving relative Locations", async () => {
    const f = fakeFetch([
      [/a\.example\/start/, { status: 302, headers: { location: "https://b.example/next" } }],
      [/b\.example\/next/, { status: 301, headers: { location: "/final.pdf" } }],
      [/b\.example\/final\.pdf/, { text: PDF_TEXT }],
    ]);
    const res = await fetchPdf(deps(f.fetch), "https://a.example/start");
    expect(res.kind).toBe("pdf");
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://a.example/start",
      "https://b.example/next",
      "https://b.example/final.pdf",
    ]);
  });

  it("refuses a redirect to http", async () => {
    const f = fakeFetch([[/./, { status: 302, headers: { location: "http://a.example/x.pdf" } }]]);
    expect(await fetchPdf(deps(f.fetch), "https://a.example/x")).toMatchObject({
      kind: "error",
      code: "bad_url",
    });
    expect(f.calls).toHaveLength(1);
  });

  it("gives up after too many redirects", async () => {
    const f = fakeFetch([[/./, { status: 302, headers: { location: "https://a.example/loop" } }]]);
    expect(await fetchPdf(deps(f.fetch), "https://a.example/loop")).toMatchObject({
      kind: "error",
      code: "http",
      reason: "too many redirects",
    });
  });

  it("classifies an HTML landing page as html without reading it", async () => {
    const f = fakeFetch([
      [
        /./,
        { text: "<html>landing</html>", headers: { "content-type": "text/html; charset=utf-8" } },
      ],
    ]);
    expect(await fetchPdf(deps(f.fetch), "https://a.example/x")).toEqual({
      kind: "html",
      status: 200,
    });
  });

  it("classifies a non-PDF body as html", async () => {
    const f = fakeFetch([
      [/./, { text: "Just a moment...", headers: { "content-type": "application/pdf" } }],
    ]);
    expect((await fetchPdf(deps(f.fetch), "https://a.example/x")).kind).toBe("html");
  });

  it("reports HTTP errors without the URL", async () => {
    const f = fakeFetch([[/./, { status: 403, text: "forbidden" }]]);
    const res = await fetchPdf(deps(f.fetch), "https://a.example/x?key=secret");
    expect(res).toEqual({ kind: "error", code: "http", reason: "HTTP 403" });
  });

  it("reports network failures", async () => {
    const fetch = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchPdf(deps(fetch), "https://a.example/x")).toMatchObject({
      kind: "error",
      code: "network",
    });
  });

  it("refuses a body over the cap by Content-Length", async () => {
    const f = fakeFetch([[/./, { text: PDF_TEXT, headers: { "content-length": "999999" } }]]);
    expect(await fetchPdf(deps(f.fetch), "https://a.example/x", { maxBytes: 10 })).toMatchObject({
      kind: "error",
      code: "over_cap",
    });
  });

  it("stops streaming a body that passes the cap", async () => {
    let pulled = 0;
    const fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new TextEncoder().encode("%PDF".padEnd(1000, "x")));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await fetchPdf(deps(fetch), "https://a.example/x", { maxBytes: 5000 });
    expect(res).toMatchObject({ kind: "error", code: "over_cap" });
    expect(pulled).toBeLessThan(10);
  });

  it("times out a server that never answers", async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch;
    expect(await fetchPdf(deps(fetch), "https://a.example/x", { timeoutMs: 20 })).toMatchObject({
      kind: "error",
      code: "timeout",
    });
  });
});
