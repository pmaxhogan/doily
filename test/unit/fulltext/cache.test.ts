import { describe, expect, it } from "vitest";
import {
  downloadPath,
  getCachedPdf,
  getCachedText,
  makeDownloadToken,
  pdfKey,
  presignPdfUrl,
  putPdf,
  putText,
  textKey,
  verifyDownloadToken,
} from "../../../src/fulltext/cache.ts";

interface Stored {
  body: Uint8Array;
  options: R2PutOptions | undefined;
}

/** In-memory stand-in for the slice of R2Bucket the cache uses. */
function fakeBucket(): { bucket: R2Bucket; store: Map<string, Stored> } {
  const store = new Map<string, Stored>();
  const bucket = {
    async put(key: string, value: string | Uint8Array, options?: R2PutOptions) {
      const body =
        typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, { body, options });
      return null;
    },
    async get(key: string) {
      const s = store.get(key);
      if (!s) return null;
      return {
        size: s.body.byteLength,
        customMetadata: s.options?.customMetadata,
        arrayBuffer: async () => s.body.slice().buffer,
        text: async () => new TextDecoder().decode(s.body),
      };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

const NOW = new Date("2026-10-16T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const SECRET = "test-secret";

describe("R2 cache helpers", () => {
  it("lowercases the DOI and keeps its slash in keys", () => {
    expect(pdfKey("10.1038/Nature12373")).toBe("pdf/10.1038/nature12373.pdf");
    expect(textKey(" 10.1038/NATURE12373 ")).toBe("text/10.1038/nature12373.md");
  });

  it("round-trips a PDF with source and fetched_at metadata", async () => {
    const { bucket, store } = fakeBucket();
    expect(await getCachedPdf(bucket, "10.1/x")).toBeNull();
    await putPdf(bucket, "10.1/X", new Uint8Array([37, 80, 68, 70]), { source: "unpaywall" }, NOW);
    const stored = store.get("pdf/10.1/x.pdf");
    expect(stored?.options?.httpMetadata).toEqual({ contentType: "application/pdf" });
    expect(stored?.options?.customMetadata).toEqual({
      source: "unpaywall",
      fetched_at: "2026-10-16T12:00:00.000Z",
    });
    const got = await getCachedPdf(bucket, "10.1/x");
    expect(got).toEqual({
      bytes: new Uint8Array([37, 80, 68, 70]),
      size: 4,
      source: "unpaywall",
      fetched_at: "2026-10-16T12:00:00.000Z",
    });
  });

  it("round-trips extracted text", async () => {
    const { bucket } = fakeBucket();
    expect(await getCachedText(bucket, "10.1/x")).toBeNull();
    await putText(bucket, "10.1/x", "# Title\n\nbody", { source: "europepmc" }, NOW);
    expect(await getCachedText(bucket, "10.1/X")).toEqual({
      text: "# Title\n\nbody",
      source: "europepmc",
      fetched_at: "2026-10-16T12:00:00.000Z",
    });
  });
});

describe("download tokens", () => {
  it("round-trips and is case-insensitive on the DOI", async () => {
    const exp = NOW_S + 3600;
    const token = await makeDownloadToken(SECRET, "10.1038/Nature12373", exp);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyDownloadToken(SECRET, "10.1038/nature12373", exp, token, NOW)).toBe(true);
    expect(await verifyDownloadToken(SECRET, "10.1038/nature12373", String(exp), token, NOW)).toBe(
      true,
    );
  });

  it("rejects expired links", async () => {
    const exp = NOW_S + 10;
    const token = await makeDownloadToken(SECRET, "10.1/x", exp);
    expect(
      await verifyDownloadToken(SECRET, "10.1/x", exp, token, new Date((exp - 1) * 1000)),
    ).toBe(true);
    expect(await verifyDownloadToken(SECRET, "10.1/x", exp, token, new Date(exp * 1000))).toBe(
      false,
    );
  });

  it("rejects a changed DOI, expiry, secret or signature", async () => {
    const exp = NOW_S + 3600;
    const token = await makeDownloadToken(SECRET, "10.1/x", exp);
    expect(await verifyDownloadToken(SECRET, "10.1/y", exp, token, NOW)).toBe(false);
    expect(await verifyDownloadToken(SECRET, "10.1/x", exp + 1, token, NOW)).toBe(false);
    expect(await verifyDownloadToken("other", "10.1/x", exp, token, NOW)).toBe(false);
    const flipped = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(await verifyDownloadToken(SECRET, "10.1/x", exp, flipped, NOW)).toBe(false);
  });

  it("returns false instead of throwing on malformed input", async () => {
    const exp = NOW_S + 3600;
    expect(await verifyDownloadToken(undefined, "10.1/x", exp, "abc", NOW)).toBe(false);
    expect(await verifyDownloadToken(SECRET, "10.1/x", exp, "", NOW)).toBe(false);
    expect(await verifyDownloadToken(SECRET, "10.1/x", exp, "not base64!", NOW)).toBe(false);
    expect(await verifyDownloadToken(SECRET, "10.1/x", exp, "abc", NOW)).toBe(false);
    expect(await verifyDownloadToken(SECRET, "10.1/x", "12abc", "abc", NOW)).toBe(false);
    expect(await verifyDownloadToken(SECRET, "10.1/x", "", "abc", NOW)).toBe(false);
  });

  it("refuses to sign without a secret", async () => {
    await expect(makeDownloadToken("", "10.1/x", NOW_S)).rejects.toThrow(/REQUEST_TOKEN_SECRET/);
  });

  it("builds a signed /download URL that verifies", async () => {
    const url = await presignPdfUrl(
      { env: { REQUEST_TOKEN_SECRET: SECRET }, origin: "https://doily.example/", now: () => NOW },
      "10.1002/(SICI)1097-4636<23::AID>3.0.CO;2-#",
    );
    const u = new URL(url);
    expect(u.origin).toBe("https://doily.example");
    expect(u.pathname).toBe(downloadPath("10.1002/(SICI)1097-4636<23::AID>3.0.CO;2-#"));
    expect(u.pathname).toBe("/download/10.1002/(sici)1097-4636%3C23%3A%3Aaid%3E3.0.co%3B2-%23");
    expect(u.hash).toBe("");
    const doi = decodeURIComponent(u.pathname.slice("/download/".length));
    const exp = u.searchParams.get("exp") ?? "";
    expect(Number(exp)).toBe(NOW_S + 3600);
    expect(await verifyDownloadToken(SECRET, doi, exp, u.searchParams.get("sig") ?? "", NOW)).toBe(
      true,
    );
  });

  it("throws when the secret is unset", async () => {
    await expect(
      presignPdfUrl({ env: {}, origin: "https://x", now: () => NOW }, "10.1/x"),
    ).rejects.toThrow(/REQUEST_TOKEN_SECRET/);
  });
});
