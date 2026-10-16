import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { clearMirrorMemoryCache } from "../../../src/scihub/mirrors.ts";
import { resolveScihub } from "../../../src/scihub/resolve.ts";

import type { ToolDeps } from "../../../src/tools/types.ts";

const fixtures = join(process.cwd(), "test", "fixtures", "scihub");
const fixture = (name: string): string => readFileSync(join(fixtures, name), "utf8");

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const DOI = "10.1038/nature12373";

type Route = { status?: number; body?: string | Uint8Array; type?: string };

function depsFor(
  routes: Record<string, Route>,
  mirrors: string,
): Pick<ToolDeps, "env" | "fetch" | "now"> {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    // Longest prefix wins, so "/storage/" beats the mirror's front page "/".
    const match = Object.entries(routes)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([prefix]) => url.startsWith(prefix));
    if (!match) return new Response("nope", { status: 404 });
    const r = match[1];
    const body = r.body ?? "";
    return new Response(body, {
      status: r.status ?? 200,
      headers: {
        "content-type": r.type ?? (typeof body === "string" ? "text/html" : "application/pdf"),
      },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    env: {
      SCIHUB_MIRRORS: mirrors,
      SCIHUB_MIRROR_LIST_URL: "https://example.invalid/none",
    } as ToolDeps["env"],
    fetch,
    now: () => new Date("2026-10-16T00:00:00Z"),
  };
}

describe("resolveScihub", () => {
  it("serves the PDF from an official mirror via citation_pdf_url", async () => {
    clearMirrorMemoryCache();
    const deps = depsFor(
      {
        "https://sci-hub.ru/10.": { body: fixture("ru-article.html.txt") },
        "https://sci-hub.ru/": { body: fixture("ru-front.html.txt") },
        "https://sci-hub.ru/storage/": { body: PDF_BYTES },
      },
      "sci-hub.ru",
    );
    const result = await resolveScihub(deps, DOI);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mirror).toBe("sci-hub.ru");
    expect(result.via).toBe("citation_pdf_url");
    expect(result.attempts.at(-1)?.outcome).toBe("ok");
  });

  it("skips a challenged mirror and continues to the next", async () => {
    clearMirrorMemoryCache();
    const deps = depsFor(
      {
        "https://sci-hub.st/": { status: 403, body: fixture("synthetic-ddos-guard.html.txt") },
        "https://sci-hub.ee/10.": { body: fixture("ee-article.html.txt") },
        "https://sci-hub.ee/": { body: fixture("ee-article.html.txt") },
        "https://sci.bban.top/pdf/": { body: PDF_BYTES },
      },
      "sci-hub.st,sci-hub.ee",
    );
    const result = await resolveScihub(deps, DOI);
    expect(result.ok).toBe(true);
    const outcomes = result.attempts.map((a) => `${a.mirror}:${a.outcome}`);
    expect(outcomes.at(-1)).toBe("sci-hub.ee:ok");
    expect(outcomes.some((o) => o.startsWith("sci-hub.ee"))).toBe(true);
  });

  it("reports not_found, no_pdf_markup and bad_pdf outcomes", async () => {
    clearMirrorMemoryCache();
    const deps = depsFor(
      {
        "https://sci-hub.al/10.": { body: fixture("al-not-found.html.txt") },
        "https://sci-hub.al/": { body: fixture("al-article.html.txt") },
        // Official mirror (no bban fallback) with a page that declares no PDF.
        "https://sci-hub.su/10.": { body: fixture("synthetic-no-markup.html.txt") },
        "https://sci-hub.su/": { body: fixture("ru-front.html.txt") },
        "https://sci-hub.ru/10.": { body: fixture("ru-article.html.txt") },
        "https://sci-hub.ru/": { body: fixture("ru-front.html.txt") },
        "https://sci-hub.ru/storage/": { body: "<html>not a pdf</html>", type: "text/html" },
      },
      "sci-hub.al,sci-hub.su,sci-hub.ru",
    );
    const result = await resolveScihub(deps, DOI);
    expect(result.ok).toBe(false);
    const byMirror = Object.fromEntries(result.attempts.map((a) => [a.mirror, a.outcome]));
    expect(byMirror["sci-hub.al"]).toBe("not_found");
    expect(byMirror["sci-hub.su"]).toBe("no_pdf_markup");
    expect(byMirror["sci-hub.ru"]).toBe("bad_pdf");
  });
});
