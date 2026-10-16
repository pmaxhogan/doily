import { describe, expect, it } from "vitest";

import {
  SESSION_KEY,
  SciNetClient,
  SciNetError,
  kvSessionStore,
  mergeCookies,
} from "../../../src/scinet/client.ts";
import { FakeKV, fixture, pdfBytes } from "./fakes.ts";

interface Seen {
  method: string;
  url: string;
  cookie: string | null;
  ua: string | null;
  body: string;
}

type Handler = (req: Seen) => Response | Promise<Response>;

/** Fake fetch over an ordered list of handlers; records every request. */
function fakeFetch(handlers: Handler[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const req: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      cookie: headers.get("cookie"),
      ua: headers.get("user-agent"),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(req);
    const h = handlers[i++];
    if (h === undefined) throw new Error(`unexpected request ${req.method} ${req.url}`);
    return h(req);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function html(body: string, status = 200, headers: [string, string][] = []): Response {
  return new Response(body, { status, headers: [["content-type", "text/html"], ...headers] });
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

const LOGIN_OK = [
  () => redirect("/", ["sid=abc; Path=/; HttpOnly", "lang=en; Path=/"]),
  () => html(fixture("synthetic-home-logged-in.html")),
];

function client(handlers: Handler[], kv = new FakeKV()) {
  const f = fakeFetch(handlers);
  const c = new SciNetClient({
    fetch: f.fetch,
    user: "alice",
    pass: "s3cret&pw",
    session: kvSessionStore(kv),
  });
  return { c, kv, seen: f.seen };
}

describe("mergeCookies", () => {
  it("keeps name=value pairs, overrides by name and drops expired cookies", () => {
    const jar = mergeCookies("a=1; b=2", ["b=3; Path=/", "c=4; HttpOnly", "a=; Max-Age=0"]);
    expect(jar).toBe("b=3; c=4");
  });
});

describe("SciNetClient.login", () => {
  it("posts the form, keeps the cookies and stores the jar in KV with a TTL", async () => {
    const { c, kv, seen } = client([...LOGIN_OK]);
    await c.login();
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://sci-net.xyz/");
    expect(new URLSearchParams(seen[0]?.body)).toEqual(
      new URLSearchParams({ user: "alice", pass: "s3cret&pw", action: "login" }),
    );
    expect(seen[0]?.ua).toMatch(/Mozilla\/5\.0/);
    expect(seen[1]?.cookie).toBe("sid=abc; lang=en");
    expect(kv.data.get(SESSION_KEY)).toBe("sid=abc; lang=en");
    expect(kv.ttls.get(SESSION_KEY)).toBeGreaterThanOrEqual(60);
  });

  it("rejects bad credentials without echoing the page", async () => {
    const { c, kv } = client([
      () => redirect("/", ["sid=anon"]),
      () => html(fixture("synthetic-login-page.html")),
    ]);
    const err = await c.login().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SciNetError);
    expect((err as SciNetError).toJSON()).toMatchObject({ source: "scinet", excerpt: "" });
    expect(kv.data.has(SESSION_KEY)).toBe(false);
  });

  it("fails when no session cookie is set", async () => {
    const { c } = client([() => html("<p>hello</p>")]);
    await expect(c.login()).rejects.toThrow(/no session cookie/);
  });
});

describe("SciNetClient session reuse and re-login", () => {
  it("reuses a stored session without logging in", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=stored");
    const { c, seen } = client([() => html(fixture("synthetic-request-open.html"))], kv);
    expect(await c.getRequestStatus("a1B2c3")).toEqual({ status: "open" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cookie).toBe("sid=stored");
    expect(seen[0]?.url).toBe("https://sci-net.xyz/request/a1B2c3");
  });

  it("re-logs in once on a 302 to the login page and retries", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=stale");
    const { c, seen } = client(
      [() => redirect("/"), ...LOGIN_OK, () => html(fixture("synthetic-request-solved.html"))],
      kv,
    );
    const status = await c.getRequestStatus("a1B2c3");
    expect(status.status).toBe("solved");
    expect(status.pdfUrl).toBe("https://sci-net.xyz/files/a1B2c3/example.5678.pdf?dl=1&v=2");
    expect(seen[3]?.cookie).toBe("sid=abc; lang=en");
    expect(kv.data.get(SESSION_KEY)).toBe("sid=abc; lang=en");
  });

  it("re-logs in when a 200 page is the login form", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=stale");
    const { c } = client(
      [
        () => html(fixture("synthetic-login-page.html")),
        ...LOGIN_OK,
        () => html(fixture("synthetic-doi-page-none.html")),
      ],
      kv,
    );
    expect(await c.findExistingRequest("10.1234/example.5678")).toBeUndefined();
  });

  it("gives up when the session is rejected right after re-login", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=stale");
    const { c } = client([() => redirect("/"), ...LOGIN_OK, () => redirect("/")], kv);
    await expect(c.getRequestStatus("x")).rejects.toThrow(/rejected after re-login/);
  });
});

describe("SciNetClient.postRequest", () => {
  it("posts the DOI and bounty and reads the id from Location", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const { c, seen } = client([() => redirect("/request/new42")], kv);
    expect(await c.postRequest("10.1234/example.5678", 2)).toEqual({
      id: "new42",
      url: "https://sci-net.xyz/request/new42",
    });
    const form = new URLSearchParams(seen[0]?.body);
    expect(form.get("doi")).toBe("10.1234/example.5678");
    expect(form.get("reward")).toBe("2");
  });

  it("never replays a bounced POST without checking for the request first", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=stale");
    const { c, seen } = client(
      [
        () => redirect("/"),
        // Probe with the stale session: really logged out.
        () => html(fixture("synthetic-login-page.html")),
        ...LOGIN_OK,
        () => html(fixture("synthetic-doi-page-existing.html")),
      ],
      kv,
    );
    expect((await c.postRequest("10.1234/example.5678", 2)).id).toBe("a1B2c3");
    expect(seen.filter((s) => s.method === "POST" && s.url.endsWith("/request"))).toHaveLength(1);
  });

  it("treats a redirect home with a live session as a successful post", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const { c, seen } = client(
      [
        () => redirect("/"),
        () => html(fixture("synthetic-home-logged-in.html")),
        () => html(fixture("synthetic-doi-page-existing.html")),
      ],
      kv,
    );
    expect((await c.postRequest("10.1234/example.5678", 2)).id).toBe("a1B2c3");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("never re-posts when a live-session redirect leaves no findable id", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const { c, seen } = client(
      [
        () => redirect("/"),
        () => html(fixture("synthetic-home-logged-in.html")),
        () => html(fixture("synthetic-doi-page-none.html")),
      ],
      kv,
    );
    await expect(c.postRequest("10.1234/example.5678", 2)).rejects.toThrow(/not re-posting/);
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("errors carry status and a short text excerpt, never raw HTML", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const long = `<html><body><h1>Server error</h1><p>${"x".repeat(500)}</p></body></html>`;
    const { c } = client([() => html(long, 500)], kv);
    const err = (await c.postRequest("10.1/x", 2).catch((e: unknown) => e)) as SciNetError;
    expect(err).toBeInstanceOf(SciNetError);
    const body = err.toJSON();
    expect(body["status"]).toBe(500);
    expect(String(body["excerpt"]).length).toBeLessThanOrEqual(200);
    expect(String(body["excerpt"])).not.toMatch(/[<>]/);
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });

  it("errors when the response has no request id", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const { c } = client([() => html("<p>Your request was received.</p>")], kv);
    await expect(c.postRequest("10.1/x", 2)).rejects.toThrow(/no request id/);
  });
});

describe("SciNetClient.downloadPdf and verifyUpload", () => {
  it("follows redirects and only sends the cookie to sci-net.xyz", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const bytes = pdfBytes();
    const { c, seen } = client(
      [
        () => redirect("https://files.example.org/x.pdf"),
        () => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }),
      ],
      kv,
    );
    const got = await c.downloadPdf("https://sci-net.xyz/files/a1B2c3/x.pdf");
    expect(got).toEqual(bytes);
    expect(seen[0]?.cookie).toBe("sid=ok");
    expect(seen[1]?.cookie).toBeNull();
  });

  it("refuses oversized PDFs by Content-Length", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const { c } = client(
      [() => new Response("x", { headers: { "content-length": String(60 * 1024 * 1024) } })],
      kv,
    );
    await expect(c.downloadPdf("/files/big.pdf")).rejects.toThrow(/over 50 MB/);
  });

  it("verifies with the configured form", async () => {
    const kv = new FakeKV();
    kv.data.set(SESSION_KEY, "sid=ok");
    const { c, seen } = client([() => html("<p>Thanks, confirmed.</p>")], kv);
    expect(await c.verifyUpload("a1B2c3")).toBe(true);
    expect(seen[0]?.method).toBe("POST");
    expect(new URLSearchParams(seen[0]?.body).get("action")).toBe("verify");
  });
});
