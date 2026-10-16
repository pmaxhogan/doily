import { describe, expect, it } from "vitest";

import {
  MAX_PDF_BYTES,
  SESSION_KEY,
  SciNetClient,
  kvSessionStore,
} from "../../../src/scinet/client.ts";
import { DOI_SCAN_WINDOW, bytesContainDoi } from "../../../src/scinet/hooks.ts";
import { configuredBounty } from "../../../src/scinet/spend.ts";
import { makeRequestToken, verifyRequestToken } from "../../../src/scinet/token.ts";
import { FakeKV, PDF_DOI, machineRig, pdfBytes } from "./fakes.ts";

import type { Env } from "../../../src/env.ts";

interface Seen {
  method: string;
  url: string;
  cookie: string | null;
}

type Handler = (req: Seen, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handlers: Handler[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      cookie: new Headers(init?.headers).get("cookie"),
    };
    seen.push(req);
    const h = handlers[i++];
    if (h === undefined) throw new Error(`unexpected request ${req.method} ${req.url}`);
    return h(req, init);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function redirect(location: string, setCookies: string[] = []): Response {
  return new Response(null, {
    status: 302,
    headers: [
      ["location", location],
      ...setCookies.map((c): [string, string] => ["set-cookie", c]),
    ],
  });
}

function client(
  handlers: Handler[],
  opts: { session?: string; pageTimeoutMs?: number; pdfTimeoutMs?: number } = {},
) {
  const kv = new FakeKV();
  if (opts.session !== undefined) kv.data.set(SESSION_KEY, opts.session);
  const f = fakeFetch(handlers);
  const c = new SciNetClient({
    fetch: f.fetch,
    user: "alice",
    pass: "pw",
    session: kvSessionStore(kv),
    ...(opts.pageTimeoutMs === undefined ? {} : { pageTimeoutMs: opts.pageTimeoutMs }),
    ...(opts.pdfTimeoutMs === undefined ? {} : { pdfTimeoutMs: opts.pdfTimeoutMs }),
  });
  return { c, seen: f.seen };
}

/** Never answers until aborted. */
const hang: Handler = (_req, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("SciNetClient deadlines", () => {
  it("times out a page request", async () => {
    const { c } = client([hang], { session: "sid=ok", pageTimeoutMs: 20 });
    await expect(c.getRequestStatus("a1")).rejects.toThrow(/timed out after 20 ms/);
  });

  it("times out a PDF download, body included", async () => {
    const stalled: Handler = (_req, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("%PDF-1.7\n"));
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
      );
    const { c } = client([stalled], { session: "sid=ok", pdfTimeoutMs: 20 });
    await expect(c.downloadPdf("/storage/2026/1/ab/x.pdf")).rejects.toThrow(
      /timed out after 20 ms/,
    );
  });
});

describe("SciNetClient downloadPdf streaming cap", () => {
  it("refuses a chunked body as soon as it passes 50 MB, without Content-Length", async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let pulled = 0;
    const endless: Handler = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
    const { c } = client([endless], { session: "sid=ok" });
    await expect(c.downloadPdf("/storage/2026/1/ab/huge.pdf")).rejects.toThrow(/over 50 MB/);
    // Stopped right after the cap, not at the end of an endless stream.
    expect(pulled).toBeLessThanOrEqual(MAX_PDF_BYTES + 3 * chunk.byteLength);
  });

  it("returns exactly the streamed bytes", async () => {
    const bytes = pdfBytes();
    const { c } = client([() => new Response(bytes)], { session: "sid=ok" });
    expect(await c.downloadPdf("/storage/2026/1/ab/x.pdf")).toEqual(bytes);
  });
});

describe("SciNetClient never sends the session cookie off-site", () => {
  it("login confirms on the home page when the login redirects off-site", async () => {
    const { c, seen } = client([
      () => redirect("https://tracker.example.com/hello", ["sid=abc; Path=/"]),
      () => html("<p>Logged in. Logout</p>"),
    ]);
    await c.login();
    expect(seen[1]?.url).toBe("https://sci-net.xyz/");
    expect(seen.some((s) => s.url.includes("tracker.example.com"))).toBe(false);
  });

  it("postRequest probes / rather than an off-site Location", async () => {
    const { c, seen } = client(
      [
        // POST answered with an off-site redirect.
        () => redirect("https://evil.example.com/login"),
        () => html("<p>Logged in. Logout</p>"),
      ],
      { session: "sid=ok" },
    );
    await c.postRequest(PDF_DOI, 2).catch(() => undefined);
    for (const s of seen) {
      if (s.cookie !== null) expect(new URL(s.url).host).toBe("sci-net.xyz");
    }
    expect(seen.some((s) => s.url.includes("evil.example.com"))).toBe(false);
  });

  it("downloadPdf drops the cookie on a cross-host hop", async () => {
    const bytes = pdfBytes();
    const { c, seen } = client(
      [() => redirect("https://cdn.example.org/x.pdf"), () => new Response(bytes)],
      { session: "sid=ok" },
    );
    await c.downloadPdf("/storage/2026/1/ab/x.pdf");
    expect(seen[0]?.cookie).toBe("sid=ok");
    expect(seen[1]?.cookie).toBeNull();
  });
});

describe("bytesContainDoi", () => {
  const enc = new TextEncoder();

  it("finds the DOI case-insensitively, also when wrapped across lines", () => {
    expect(bytesContainDoi(enc.encode("x DOI:10.1234/EXAMPLE.5678 y"), PDF_DOI)).toBe(true);
    expect(bytesContainDoi(enc.encode("10.1234/exam\r\nple.5678"), PDF_DOI)).toBe(true);
    expect(bytesContainDoi(enc.encode("10.1234/example.567"), PDF_DOI)).toBe(false);
    expect(bytesContainDoi(enc.encode("anything"), "")).toBe(false);
  });

  it("scans only the first and last window of a large file", () => {
    const doi = enc.encode(PDF_DOI);
    const big = new Uint8Array(DOI_SCAN_WINDOW * 3);
    big.set(doi, 10);
    expect(bytesContainDoi(big, PDF_DOI)).toBe(true);
    big.fill(0);
    big.set(doi, big.length - doi.length - 10);
    expect(bytesContainDoi(big, PDF_DOI)).toBe(true);
    big.fill(0);
    big.set(doi, DOI_SCAN_WINDOW + 100);
    expect(bytesContainDoi(big, PDF_DOI)).toBe(false);
  });
});

describe("small Sci-Net fixes", () => {
  it("never posts a bounty below 1", () => {
    expect(configuredBounty({ env: { SCINET_BOUNTY: "0" } as Env })).toBe(1);
    expect(configuredBounty({ env: {} as Env })).toBe(2);
  });

  it("request tokens round-trip and are domain separated from download tokens", async () => {
    const token = await makeRequestToken("secret", PDF_DOI);
    expect(await verifyRequestToken("secret", token)).toBe(PDF_DOI);
    // A MAC over the bare DOI (the old format) no longer verifies.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bare = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(PDF_DOI)),
    );
    const b64 = (b: Uint8Array): string =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const forged = `${b64(new TextEncoder().encode(PDF_DOI))}.${b64(bare)}`;
    expect(await verifyRequestToken("secret", forged)).toBeNull();
  });

  it("never accepts or verifies a joined solved request (someone else.s)", async () => {
    const r = machineRig();
    r.client.existing = "theirs";
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = {
      status: "solved",
      pdfUrl: "https://sci-net.xyz/storage/2026/1/ab/Example.pdf",
    };
    r.clock.advance(5 * 60 * 1000);
    await r.machine.alarm();
    const s = await r.machine.status();
    expect(s?.status).toBe("ready");
    expect(r.client.calls.accept).toBe(0);
    const alarmsBefore = r.storage.alarmsSet;
    await r.machine.alarm();
    expect(r.client.calls.accept).toBe(0);
    expect(r.storage.alarmsSet).toBe(alarmsBefore);
  });

  it("accepts a fulfilment whose %PDF- header follows a few leading bytes", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    const body = pdfBytes();
    const withBom = new Uint8Array(body.length + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(body, 3);
    r.client.pdf = withBom;
    r.client.remote = {
      status: "solved",
      pdfUrl: "https://sci-net.xyz/storage/2026/1/ab/Example.pdf",
    };
    r.clock.advance(5 * 60 * 1000);
    await r.machine.alarm();
    expect((await r.machine.status())?.status).toBe("ready");
  });
});
