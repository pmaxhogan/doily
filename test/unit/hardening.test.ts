import { beforeEach, describe, expect, it } from "vitest";

import { encodeDoiPath, fetchJson, fetchText } from "../../src/lib/http.ts";
import { resetRateLimits } from "../../src/lib/ratelimit.ts";
import { lookupSjr } from "../../src/lib/snapshots.ts";
import { getPreprintDetails } from "../../src/providers/biorxiv.ts";
import {
  addSpend,
  getOpenAlexWork,
  resetOpenAlexSpend,
  utcDay,
} from "../../src/providers/openalex.ts";
import { ToolError } from "../../src/tools/types.ts";
import { fakeFetch, makeDeps, memoryKv, NOW } from "./helpers.ts";

beforeEach(() => {
  resetRateLimits();
  resetOpenAlexSpend();
});

/** A SICI DOI: contains `#`, `;`, `<`, `>` and `:`. */
const SICI_DOI = "10.1002/(sici)1097-4636(199709)36:3<350::aid-jbm10>3.0.co;2-#";

/** A fetch whose headers never arrive; it only settles when aborted. */
function hangingFetch(): typeof globalThis.fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof globalThis.fetch;
}

/** A fetch whose headers arrive but whose body never ends until aborted. */
function stallingBodyFetch(): typeof globalThis.fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
}

describe("http timeouts", () => {
  it("fails a request whose headers never arrive with a timeout ToolError", async () => {
    const err = await fetchJson(makeDeps(hangingFetch()), {
      source: "europepmc",
      url: "https://example.org/slow",
      bucket: "europepmc",
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).toJSON()).toMatchObject({
      error: "europepmc request timed out after 20 ms",
      source: "europepmc",
      status: 0,
      timeout: true,
    });
  });

  it("also bounds the body read", async () => {
    const err = await fetchText(makeDeps(stallingBodyFetch()), {
      source: "ncbi",
      url: "https://example.org/stall",
      bucket: "europepmc",
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).toJSON()).toMatchObject({ timeout: true, source: "ncbi" });
  });

  it("passes an abort signal on every request", async () => {
    const f = fakeFetch([[/example/, { json: { ok: true } }]]);
    await fetchJson(makeDeps(f.fetch), {
      source: "x",
      url: "https://example.org/a",
      bucket: "europepmc",
    });
    expect(f.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("DOIs in URL paths", () => {
  it("encodeDoiPath keeps slashes and encodes what would end or corrupt the path", () => {
    expect(encodeDoiPath("10.1038/nature12373")).toBe("10.1038/nature12373");
    expect(encodeDoiPath("10.1000/a?b#c%d")).toBe("10.1000/a%3Fb%23c%25d");
    const url = new URL(`https://example.org/${encodeDoiPath(SICI_DOI)}`);
    expect(url.hash).toBe("");
    expect(url.search).toBe("");
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(SICI_DOI);
  });

  it("OpenAlex looks up a SICI DOI without losing the `#` to a fragment", async () => {
    const f = fakeFetch([[/api\.openalex\.org\/works\//, { json: { id: "W1" } }]]);
    await getOpenAlexWork(makeDeps(f.fetch), { doi: SICI_DOI });
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.hash).toBe("");
    expect(url.pathname).toBe(`/works/https://doi.org/${encodeDoiPath(SICI_DOI)}`);
    expect(url.pathname.endsWith("co%3B2-%23")).toBe(true);
  });

  it("bioRxiv encodes the DOI in the details path", async () => {
    const f = fakeFetch([[/api\.biorxiv\.org/, { json: { collection: [] } }]]);
    await getPreprintDetails(makeDeps(f.fetch), "10.1101/a#b?c", "biorxiv");
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.hash).toBe("");
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/details/biorxiv/10.1101/a%23b%3Fc");
  });
});

describe("OpenAlex spend persistence", () => {
  it("persists a raise that comes only from X-RateLimit-Remaining-USD", async () => {
    const mem = memoryKv();
    const deps = makeDeps(fakeFetch([]).fetch, { DOILY_KV: mem.kv });
    await addSpend(deps, 0, 0.04);
    expect(Number(mem.store.get(`openalex:spend:${utcDay(NOW)}`))).toBeCloseTo(0.06, 6);
  });

  it("does not write when nothing changed", async () => {
    const mem = memoryKv();
    const deps = makeDeps(fakeFetch([]).fetch, { DOILY_KV: mem.kv });
    await addSpend(deps, 0);
    expect(mem.puts).toHaveLength(0);
  });
});

describe("lookupSjr with the real snapshot's key shape", () => {
  // data/sjr.json keys every ISSN as 8 characters, no hyphen (^\d{7}[\dX]$).
  const sjr = {
    generated: "2026-10-16",
    year: 2025,
    entries: {
      "00280836": { title: "Nature", sjr: 18.5, quartile: "Q1" },
      "0036807X": { title: "Science", sjr: 11.9, quartile: "Q1" },
    },
  };

  it("finds an 8-char key from a hyphenated query (the production path)", () => {
    expect(lookupSjr(["0028-0836"], sjr)).toMatchObject({
      title: "Nature",
      issn: "0028-0836",
      year: 2025,
      snapshot: "2026-10-16",
    });
  });

  it("finds an 8-char key from an unhyphenated query and an X check digit", () => {
    expect(lookupSjr(["00280836"], sjr)).toMatchObject({ title: "Nature" });
    expect(lookupSjr(["0036-807x"], sjr)).toMatchObject({ title: "Science" });
  });

  it("skips ISSNs without an entry and returns null when none match", () => {
    expect(lookupSjr([undefined, "1476-4687", "0028-0836"], sjr)).toMatchObject({
      title: "Nature",
    });
    expect(lookupSjr(["1234-5678"], sjr)).toBeNull();
  });
});
