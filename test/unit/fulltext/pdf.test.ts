import { describe, expect, it, vi } from "vitest";
import { cleanupPages, MAX_PDF_BYTES, PdfError, pdfToText } from "../../../src/fulltext/pdf.ts";
import { makePdf } from "./make-pdf.ts";

type ToMarkdownResult = Awaited<ReturnType<Ai["toMarkdown"]>>;

function fakeAi(result: { data: string } | { error: string } | Error): {
  ai: Ai;
  calls: { name: string; blob: Blob }[];
} {
  const calls: { name: string; blob: Blob }[] = [];
  const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => {
    calls.push(doc);
    if (result instanceof Error) throw result;
    const base = { id: "1", name: doc.name, mimeType: "application/pdf" };
    return ("error" in result
      ? { ...base, format: "error", error: result.error }
      : {
          ...base,
          format: "markdown",
          tokens: 10,
          data: result.data,
        }) as unknown as ToMarkdownResult;
  });
  return { ai: { toMarkdown } as unknown as Ai, calls };
}

const sentence = (i: number): string =>
  `This is sentence number ${i} of the body text on this page.`;

describe("pdfToText with unpdf", () => {
  it("extracts text from a real (generated) PDF", async () => {
    const bytes = makePdf([[sentence(1), sentence(2), "", sentence(3), sentence(4)]]);
    const before = bytes.slice();
    const r = await pdfToText(bytes, {});
    expect(r.method).toBe("unpdf");
    expect(r.pages).toBe(1);
    // The empty line leaves a vertical gap, which becomes a paragraph break.
    expect(r.text).toBe(`${sentence(1)} ${sentence(2)}\n\n${sentence(3)} ${sentence(4)}`);
    // The caller's buffer is left intact for caching.
    expect(bytes).toEqual(before);
  });

  it("drops running headers and footers that repeat on most pages", async () => {
    const pages = [1, 2, 3, 4].map((p) => [
      "Journal of Examples 2026; 12: 1-10",
      sentence(p * 10),
      sentence(p * 10 + 1),
      sentence(p * 10 + 2),
      sentence(p * 10 + 3),
      `Page ${p}`,
    ]);
    const r = await pdfToText(makePdf(pages), {});
    expect(r.method).toBe("unpdf");
    expect(r.pages).toBe(4);
    expect(r.text).not.toContain("Journal of Examples");
    expect(r.text).not.toMatch(/Page \d/);
    expect(r.text).toContain(sentence(10));
    expect(r.text).toContain(sentence(43));
    // Pages stay separate paragraphs.
    expect(r.text.split("\n\n")).toHaveLength(4);
  });

  it("re-joins words hyphenated across a line break", async () => {
    const r = await pdfToText(makePdf([["The experi-", "ment worked. A well-known result."]]), {});
    expect(r.text).toBe("The experiment worked. A well-known result.");
  });

  it("leaves the caller's bytes intact for caching (PDF.js detaches what it is given)", async () => {
    const bytes = makePdf([["Some text to extract."]]);
    const before = bytes.byteLength;
    await pdfToText(bytes, {});
    expect(bytes.byteLength).toBe(before);
    expect(bytes[0]).toBe(0x25);
  });

  it("caps work: rejects PDFs over 50 MB before parsing", async () => {
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    await expect(pdfToText(big, {})).rejects.toThrow(PdfError);
    await expect(pdfToText(big, {})).rejects.toThrow(/50 MB/);
  });
});

describe("pdfToText AI fallback", () => {
  it("falls back when unpdf throws on a non-PDF", async () => {
    const { ai, calls } = fakeAi({ data: "# Scanned\n\n\n\nText" });
    const bytes = new TextEncoder().encode("not a pdf at all");
    const r = await pdfToText(bytes, { ai });
    expect(r).toEqual({ text: "# Scanned\n\nText", method: "ai" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("doc.pdf");
    expect(calls[0]?.blob.type).toBe("application/pdf");
    expect(new Uint8Array(await (calls[0]?.blob ?? new Blob()).arrayBuffer())).toEqual(bytes);
  });

  it("falls back when the PDF has no text layer", async () => {
    const { ai } = fakeAi({ data: "OCR text" });
    const r = await pdfToText(makePdf([[], []]), { ai });
    expect(r).toEqual({ text: "OCR text", pages: 2, method: "ai" });
  });

  it("falls back when there are under 200 chars across more than 2 pages", async () => {
    const { ai, calls } = fakeAi({ data: "Full OCR text" });
    const r = await pdfToText(makePdf([["Cover page"], [], []]), { ai });
    expect(r).toEqual({ text: "Full OCR text", pages: 3, method: "ai" });
    expect(calls).toHaveLength(1);
  });

  it("does not fall back for short text on 2 pages or fewer", async () => {
    const { ai, calls } = fakeAi({ data: "unused" });
    const r = await pdfToText(makePdf([["Short note."], ["Two."]]), { ai });
    expect(r.method).toBe("unpdf");
    expect(calls).toHaveLength(0);
  });

  it("keeps sparse unpdf text when the AI fails or is absent", async () => {
    const bytes = makePdf([["Cover page"], [], []]);
    const failing = fakeAi(new Error("AI down"));
    expect(await pdfToText(bytes, { ai: failing.ai })).toEqual({
      text: "Cover page",
      pages: 3,
      method: "unpdf",
    });
    const errored = fakeAi({ error: "unsupported" });
    expect((await pdfToText(bytes, { ai: errored.ai })).method).toBe("unpdf");
    expect((await pdfToText(bytes, {})).method).toBe("unpdf");
  });

  it("throws a PdfError when neither path yields text", async () => {
    const bytes = new TextEncoder().encode("garbage");
    await expect(pdfToText(bytes, {})).rejects.toThrow(/unpdf failed.*no AI binding/);
    const errored = fakeAi({ error: "unsupported format" });
    await expect(pdfToText(bytes, { ai: errored.ai })).rejects.toThrow(
      /AI fallback failed: unsupported format/,
    );
    const empty = fakeAi({ data: "   " });
    await expect(pdfToText(bytes, { ai: empty.ai })).rejects.toThrow(PdfError);
  });

  it("treats an unpdf timeout as a failure and falls back", async () => {
    const { ai } = fakeAi({ data: "from ai" });
    const r = await pdfToText(makePdf([[sentence(1)]]), { ai, timeoutMs: 0 });
    expect(r.method).toBe("ai");
  });
});

describe("cleanupPages", () => {
  it("keeps paragraph breaks, reflows lines and collapses whitespace", () => {
    expect(cleanupPages(["a  line\nwraps here\n\n\n\nnew   para\t end"])).toBe(
      "a line wraps here\n\nnew para end",
    );
  });

  it("matches headers whose digits differ and leaves body lines that merely repeat once", () => {
    const pages = [1, 2, 3].map(
      (p) => `Running Head ${p}\nUnique body ${"x".repeat(p)}\nBody line\nMore\nText\nEnd\n${p}`,
    );
    const out = cleanupPages(pages);
    expect(out).not.toContain("Running Head");
    expect(out).not.toMatch(/(^|\s)\d$/m);
    expect(out).toContain("Unique body x");
  });

  it("does not strip headers on documents shorter than 3 pages", () => {
    expect(cleanupPages(["Head\nbody one", "Head\nbody two"])).toBe(
      "Head body one\n\nHead body two",
    );
  });
});
