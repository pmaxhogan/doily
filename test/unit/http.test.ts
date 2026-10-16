import { beforeEach, describe, expect, it } from "vitest";

import {
  excerpt,
  fetchJson,
  fetchText,
  qs,
  retryAfterMs,
  scrub,
  userAgent,
} from "../../src/lib/http.ts";
import { acquire, bucketRate, resetRateLimits } from "../../src/lib/ratelimit.ts";
import { ToolError } from "../../src/tools/types.ts";
import { fakeFetch, makeDeps, memoryKv, NOW } from "./helpers.ts";

beforeEach(() => resetRateLimits());

describe("http", () => {
  it("sends the polite User-Agent with the configured contact", async () => {
    const f = fakeFetch([[/example/, { json: { ok: true } }]]);
    await fetchJson(makeDeps(f.fetch, { CONTACT_EMAIL: "me@example.org" }), {
      source: "x",
      url: "https://example.org/a",
      bucket: "europepmc",
    });
    const headers = f.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(
      "doily/0.1.0 (https://github.com/pmaxhogan/doily; mailto:me@example.org)",
    );
    expect(userAgent({})).toContain("mailto:pmaxhogan@gmail.com");
  });

  it("retries once after a 429, honoring Retry-After", async () => {
    let n = 0;
    const slept: number[] = [];
    const f = fakeFetch([
      [
        /example/,
        () => (n++ === 0 ? { status: 429, headers: { "Retry-After": "1" } } : { json: { ok: 1 } }),
      ],
    ]);
    const deps = { ...makeDeps(f.fetch), sleep: async (ms: number) => void slept.push(ms) };
    const res = await fetchJson<{ ok: number }>(deps, {
      source: "x",
      url: "https://example.org",
      bucket: "europepmc",
    });
    expect(res?.data.ok).toBe(1);
    expect(f.calls).toHaveLength(2);
    expect(slept).toContain(1000);
  });

  it("gives up after the second 429 with a structured error", async () => {
    const f = fakeFetch([
      [/example/, { status: 429, text: '{"message": "Too Many Requests", "code": "429"}' }],
    ]);
    const err = await fetchJson(makeDeps(f.fetch), {
      source: "semanticscholar",
      url: "https://example.org",
      bucket: "s2",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).toJSON()).toMatchObject({
      error: "semanticscholar returned HTTP 429",
      source: "semanticscholar",
      status: 429,
      body_excerpt: '{"message": "Too Many Requests", "code": "429"}',
    });
    expect(f.calls).toHaveLength(2);
  });

  it("never leaks keys or URLs in errors", async () => {
    const f = fakeFetch([
      [
        /example/,
        {
          status: 500,
          text: `bad request for api_key=SECRETKEY123 and SECRETKEY123 ${"x".repeat(400)}`,
        },
      ],
    ]);
    const err = (await fetchJson(makeDeps(f.fetch), {
      source: "openalex",
      url: "https://example.org/works?api_key=SECRETKEY123",
      bucket: "openalex",
      secrets: ["SECRETKEY123"],
    }).catch((e: unknown) => e)) as ToolError;
    const json = JSON.stringify(err.toJSON());
    expect(json).not.toContain("SECRETKEY123");
    expect(json).not.toContain("example.org");
    expect((err.details["body_excerpt"] as string).length).toBeLessThanOrEqual(300);
  });

  it("reports network failures with status 0", async () => {
    const fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      fetchJson(makeDeps(fetch), {
        source: "crossref",
        url: "https://x",
        bucket: "crossref_single",
      }),
    ).rejects.toMatchObject({ details: { source: "crossref", status: 0 } });
  });

  it("returns null on 404 when allowed, and rejects invalid JSON", async () => {
    const f = fakeFetch([
      [/missing/, { status: 404, text: "nope" }],
      [/garbled/, { text: "<html>" }],
      [/xml/, { text: "<article/>" }],
    ]);
    const deps = makeDeps(f.fetch);
    expect(
      await fetchJson(deps, {
        source: "x",
        url: "https://e/missing",
        bucket: "doaj",
        allowNotFound: true,
      }),
    ).toBeNull();
    await expect(
      fetchJson(deps, { source: "x", url: "https://e/missing", bucket: "doaj" }),
    ).rejects.toThrow("HTTP 404");
    await expect(
      fetchJson(deps, { source: "x", url: "https://e/garbled", bucket: "doaj" }),
    ).rejects.toThrow("invalid JSON");
    expect(
      (await fetchText(deps, { source: "x", url: "https://e/xml", bucket: "doaj" }))?.data,
    ).toBe("<article/>");
  });

  it("parses Retry-After safely", () => {
    expect(retryAfterMs("1", NOW)).toBe(1000);
    expect(retryAfterMs("120", NOW)).toBe(2000);
    expect(retryAfterMs(null, NOW)).toBe(1000);
    expect(retryAfterMs(new Date(NOW.getTime() + 1500).toUTCString(), NOW)).toBeLessThanOrEqual(
      2000,
    );
    expect(retryAfterMs("garbage", NOW)).toBe(1000);
  });

  it("scrubs and builds query strings", () => {
    expect(scrub("token=abc&x=1")).toBe("token=***&x=1");
    expect(excerpt("  a \n b  ")).toBe("a b");
    expect(qs({ a: "x y", b: undefined, c: 2 })).toBe("a=x%20y&c=2");
  });
});

describe("ratelimit", () => {
  it("uses keyed rates when keys exist", () => {
    expect(bucketRate("ncbi", {})).toBe(3);
    expect(bucketRate("ncbi", { NCBI_API_KEY: "k" })).toBe(10);
    expect(bucketRate("openalex", {})).toBe(10);
    expect(bucketRate("openalex", { OPENALEX_API_KEY: "k" })).toBe(30);
    expect(bucketRate("crossref_list", {})).toBe(3);
    expect(bucketRate("crossref_single", {})).toBe(10);
    expect(bucketRate("europepmc", {})).toBe(5);
    expect(bucketRate("doaj", {})).toBe(2);
    expect(bucketRate("s2", {})).toBe(1);
  });

  it("lets a burst through then makes callers wait", async () => {
    const slept: number[] = [];
    const deps = {
      ...makeDeps(fakeFetch([]).fetch),
      sleep: async (ms: number) => void slept.push(ms),
    };
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) waits.push(await acquire(deps, "doaj"));
    expect(waits).toEqual([0, 0, 500, 1000, 1500]);
    expect(slept).toEqual([500, 1000, 1500]);
  });

  it("refills over time", async () => {
    let t = NOW.getTime();
    const deps = { ...makeDeps(fakeFetch([]).fetch), now: () => new Date(t) };
    await acquire(deps, "s2");
    t += 1000;
    expect(await acquire(deps, "s2")).toBe(0);
  });

  it("seeds from KV and writes back at most once per second", async () => {
    const mem = memoryKv();
    mem.store.set("ratelimit:s2", JSON.stringify({ tokens: -1, ts: NOW.getTime() }));
    const deps = makeDeps(fakeFetch([]).fetch, { DOILY_KV: mem.kv });
    expect(await acquire(deps, "s2")).toBe(2000);
    await acquire(deps, "s2");
    expect(mem.puts).toHaveLength(1);
    expect(mem.puts[0]?.key).toBe("ratelimit:s2");
  });

  it("swallows KV write failures", async () => {
    const mem = memoryKv({ failPuts: true });
    const deps = makeDeps(fakeFetch([]).fetch, { DOILY_KV: mem.kv });
    await expect(acquire(deps, "europepmc")).resolves.toBe(0);
  });
});
