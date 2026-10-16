// GET /download/<doi>: the signed PDF link get_pdf hands out, served through
// the real Worker entry point (OAuth provider -> defaultHandler) from R2.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { downloadPath, makeDownloadToken, putPdf } from "../../src/fulltext/cache.ts";

import { fetchWorker, mcpCall } from "./helpers.ts";

const AUTH = { authorization: `Bearer ${env.DOILY_BEARER}` };

const DOI = "10.5555/Download.Test";
const PDF = new TextEncoder().encode("%PDF-1.4\n% integration test\n%%EOF\n");

async function signedPath(doi: string, exp: number): Promise<string> {
  const sig = await makeDownloadToken(env.REQUEST_TOKEN_SECRET, doi, exp);
  return `${downloadPath(doi)}?exp=${exp}&sig=${sig}`;
}

function inAnHour(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

describe("/download", () => {
  it("streams a cached PDF with download headers for a valid signature", async () => {
    await putPdf(env.PDFS, DOI, PDF, { source: "integration" });
    const response = await fetchWorker(await signedPath(DOI, inAnHour()));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="10.5555_download.test.pdf"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
  });

  it("is a 403 for a bad signature", async () => {
    await putPdf(env.PDFS, DOI, PDF, { source: "integration" });
    const exp = inAnHour();
    const sig = await makeDownloadToken(env.REQUEST_TOKEN_SECRET, DOI, exp);
    // Flip the first character so the tampered token always differs.
    const bad = `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`;
    const response = await fetchWorker(`${downloadPath(DOI)}?exp=${exp}&sig=${bad}`);

    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it("is a 403 for an expired link", async () => {
    await putPdf(env.PDFS, DOI, PDF, { source: "integration" });
    const response = await fetchWorker(await signedPath(DOI, Math.floor(Date.now() / 1000) - 1));

    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it("is a 403 for a signature minted for another DOI", async () => {
    const sig = await makeDownloadToken(env.REQUEST_TOKEN_SECRET, "10.5555/other", inAnHour());
    const response = await fetchWorker(`${downloadPath(DOI)}?exp=${inAnHour()}&sig=${sig}`);

    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it("is a 404 for a validly signed DOI that is not cached", async () => {
    const response = await fetchWorker(await signedPath("10.5555/not-cached", inAnHour()));

    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});

describe("tools/list", () => {
  it("includes get_full_text and get_pdf", async () => {
    const reply = await mcpCall("tools/list", {}, AUTH);
    const names = ((reply.result?.["tools"] ?? []) as { name: string }[]).map((t) => t.name);

    expect(names).toContain("get_full_text");
    expect(names).toContain("get_pdf");
  });
});
