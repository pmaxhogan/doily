import { describe, expect, it } from "vitest";

import { extractPdfUrl, isAllowedPdfHost, normalizeCandidate } from "../../../src/scihub/parse.ts";

describe("isAllowedPdfHost", () => {
  const mirror = "https://sci-hub.ee";
  it("allows the mirror itself, its subdomains, official mirrors and the PDF host", () => {
    expect(isAllowedPdfHost("sci-hub.ee", mirror)).toBe(true);
    expect(isAllowedPdfHost("cdn.sci-hub.ee", mirror)).toBe(true);
    expect(isAllowedPdfHost("sci-hub.ru", mirror)).toBe(true);
    expect(isAllowedPdfHost("sci.bban.top", mirror)).toBe(true);
  });
  it("rejects everything else, including internal and look-alike hosts", () => {
    expect(isAllowedPdfHost("169.254.169.254", mirror)).toBe(false);
    expect(isAllowedPdfHost("localhost", mirror)).toBe(false);
    expect(isAllowedPdfHost("sci-hub.ee.evil.example", mirror)).toBe(false);
    expect(isAllowedPdfHost("evil.example", mirror)).toBe(false);
  });
});

describe("normalizeCandidate host allowlist", () => {
  it("drops a candidate that points off the mirror", () => {
    expect(normalizeCandidate("https://evil.example/x.pdf", "https://sci-hub.ru")).toBeNull();
    expect(normalizeCandidate("http://10.0.0.1/x.pdf", "https://sci-hub.ru")).toBeNull();
  });
  it("keeps relative and same-host candidates", () => {
    expect(normalizeCandidate("/storage/a.pdf#x", "https://sci-hub.ru")).toBe(
      "https://sci-hub.ru/storage/a.pdf",
    );
  });
  it("never yields an off-list URL from page markup", () => {
    const html = `<meta name="citation_pdf_url" content="https://evil.example/p.pdf">
      <embed src="https://sci.bban.top/pdf/10.1/x.pdf#view=FitH">`;
    const urls = extractPdfUrl(html, "https://sci-hub.ren", { doi: "10.1/x" }).map((c) => c.url);
    expect(urls.every((u) => new URL(u).hostname === "sci.bban.top")).toBe(true);
  });
});
