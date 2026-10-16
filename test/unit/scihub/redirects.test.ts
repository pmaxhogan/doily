import { describe, expect, it } from "vitest";

import { MAX_REDIRECTS, ScihubFetchError, scihubFetch } from "../../../src/scihub/fetch.ts";
import { clearMirrorMemoryCache } from "../../../src/scihub/mirrors.ts";
import { resolveScihub } from "../../../src/scihub/resolve.ts";

import type { ToolDeps } from "../../../src/tools/types.ts";

const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

type Answer = (url: string, init?: RequestInit) => Response;

function deps(answer: Answer): {
  deps: Pick<ToolDeps, "env" | "fetch" | "now">;
  calls: { url: string; redirect?: RequestInit["redirect"] }[];
} {
  const calls: { url: string; redirect?: RequestInit["redirect"] }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return {
    deps: {
      env: {
        SCIHUB_MIRRORS: "sci-hub.ru",
        SCIHUB_MIRROR_LIST_URL: "https://example.invalid/none",
      } as ToolDeps["env"],
      fetch,
      now: () => new Date("2026-10-16T00:00:00Z"),
    },
    calls,
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

const OPTS = { timeoutMs: 5_000, maxBytes: 1024 * 1024 };

describe("scihubFetch redirects (direct mode)", () => {
  it("follows a redirect to an allowed host by hand", async () => {
    const d = deps((url) =>
      url.startsWith("https://sci-hub.ru/")
        ? redirect("https://sci.bban.top/pdf/x.pdf")
        : new Response(PDF, { status: 200 }),
    );
    const res = await scihubFetch(d.deps, "https://sci-hub.ru/storage/x.pdf", OPTS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(PDF);
    expect(d.calls.map((c) => c.url)).toEqual([
      "https://sci-hub.ru/storage/x.pdf",
      "https://sci.bban.top/pdf/x.pdf",
    ]);
    expect(d.calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("refuses a redirect off the allowlist (no request is made to it)", async () => {
    const d = deps((url) =>
      url.includes("sci-hub.ru")
        ? redirect("http://192.168.1.192/api/v2.0/system/info")
        : new Response("internal"),
    );
    const err = await scihubFetch(d.deps, "https://sci-hub.ru/10.1/x", OPTS).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ScihubFetchError);
    expect((err as ScihubFetchError).kind).toBe("error");
    expect(d.calls).toHaveLength(1);
  });

  it("refuses non-http schemes", async () => {
    const d = deps(() => redirect("file:///etc/passwd"));
    await expect(scihubFetch(d.deps, "https://sci-hub.ru/x", OPTS)).rejects.toBeInstanceOf(
      ScihubFetchError,
    );
  });

  it("vets hops against redirectOrigin when given", async () => {
    const d = deps((url) =>
      url.startsWith("https://sci.bban.top/")
        ? redirect("https://sci-hub.ee/x.pdf")
        : new Response(PDF),
    );
    // From bban, sci-hub.ee is only allowed when the mirror being resolved is sci-hub.ee.
    await expect(
      scihubFetch(d.deps, "https://sci.bban.top/pdf/x.pdf", OPTS),
    ).rejects.toBeInstanceOf(ScihubFetchError);
    const ok = await scihubFetch(d.deps, "https://sci.bban.top/pdf/x.pdf", {
      ...OPTS,
      redirectOrigin: "https://sci-hub.ee",
    });
    expect(ok.status).toBe(200);
  });

  it(`gives up after ${MAX_REDIRECTS} hops`, async () => {
    let n = 0;
    const d = deps(() => redirect(`https://sci-hub.ru/loop/${n++}`));
    await expect(scihubFetch(d.deps, "https://sci-hub.ru/x", OPTS)).rejects.toThrow(
      /too many redirects/,
    );
    expect(d.calls).toHaveLength(MAX_REDIRECTS + 1);
  });
});

describe("resolveScihub with a DOI that has URL metacharacters", () => {
  it("percent-encodes the DOI in the article page path", async () => {
    clearMirrorMemoryCache();
    const doi = "10.1002/(sici)1097-4636(199709)36:3<350::aid-jbm10>3.0.co;2-#";
    const d = deps((url) =>
      new URL(url).pathname === "/"
        ? new Response("<html>front page</html>", { status: 200 })
        : new Response("<html>no pdf here</html>", { status: 404 }),
    );
    await resolveScihub(d.deps, doi);
    const page = d.calls.map((c) => new URL(c.url)).find((u) => u.pathname.startsWith("/10."));
    expect(page).toBeDefined();
    expect(page?.hash).toBe("");
    expect(decodeURIComponent(page?.pathname.slice(1) ?? "")).toBe(doi);
  });
});
