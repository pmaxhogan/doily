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
  contentType: string | null;
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
      contentType: headers.get("content-type"),
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

const DOI = "10.1080/03630269.2026.2729189";
const PAGE_URL = `https://sci-net.xyz/${DOI}`;
const SOLVED_PDF =
  "https://sci-net.xyz/storage/2026/7/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0/Title-With-Dashes.pdf";
/** What POST /request answers with: the re-rendered home fragment. */
const POSTED_FRAGMENT = "<div class='feed'><div class='request'>new</div></div>";

const LOGIN_OK = [
  () => redirect("/", ["sid=abc; Path=/; HttpOnly", "lang=en; Path=/"]),
  () => html(fixture("captured-home-logged-in.html")),
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

function loggedIn(session = "sid=ok"): FakeKV {
  const kv = new FakeKV();
  kv.data.set(SESSION_KEY, session);
  return kv;
}

const posts = (seen: Seen[]) =>
  seen.filter((s) => s.method === "POST" && s.url === "https://sci-net.xyz/request");

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
    expect(seen[0]?.contentType).toBe("application/x-www-form-urlencoded");
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
      () => html(fixture("captured-login-page.html")),
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
  it("reuses a stored session and reads an open request taken by a solver", async () => {
    const { c, seen } = client(
      [() => html(fixture("captured-request-open.html"))],
      loggedIn("sid=stored"),
    );
    expect(await c.getRequestStatus(DOI)).toEqual({ status: "open", reward: 2, taken: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.cookie).toBe("sid=stored");
    expect(seen[0]?.url).toBe(PAGE_URL);
  });

  it("re-logs in once on a 302 to the login page and reads a solved request with its PDF", async () => {
    const kv = loggedIn("sid=stale");
    const { c, seen } = client(
      [() => redirect("/"), ...LOGIN_OK, () => html(fixture("captured-request-solved.html"))],
      kv,
    );
    const status = await c.getRequestStatus("10.1177/26345161261465536");
    expect(status).toEqual({ status: "solved", pdfUrl: SOLVED_PDF });
    expect(status.uploadedAt).toBeUndefined();
    expect(seen[3]?.url).toBe("https://sci-net.xyz/10.1177/26345161261465536");
    expect(seen[3]?.cookie).toBe("sid=abc; lang=en");
    expect(kv.data.get(SESSION_KEY)).toBe("sid=abc; lang=en");
  });

  it("re-logs in when a 200 page is the login form", async () => {
    const { c } = client(
      [
        () => html(fixture("captured-login-page.html")),
        ...LOGIN_OK,
        () => html(fixture("captured-search-card.html")),
      ],
      loggedIn("sid=stale"),
    );
    expect(await c.findExistingRequest(DOI)).toBeUndefined();
  });

  it("gives up when the session is rejected right after re-login", async () => {
    const { c } = client(
      [() => redirect("/"), ...LOGIN_OK, () => redirect("/")],
      loggedIn("sid=stale"),
    );
    await expect(c.getRequestStatus(DOI)).rejects.toThrow(/rejected after re-login/);
  });
});

describe("SciNetClient.findExistingRequest (POST /search)", () => {
  it("joins an existing request: the id is the lowercased DOI", async () => {
    const { c, seen } = client([() => html(fixture("captured-search-existing.html"))], loggedIn());
    expect(await c.findExistingRequest(DOI.toUpperCase())).toBe(DOI);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://sci-net.xyz/search");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(seen[0]?.cookie).toBe("sid=ok");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ doi: DOI });
  });

  it("returns undefined when the paper card offers a new request", async () => {
    const { c } = client([() => html(fixture("captured-search-card.html"))], loggedIn());
    expect(await c.findExistingRequest(DOI)).toBeUndefined();
  });

  it("errors on a DOI Crossref does not know", async () => {
    const { c } = client([() => html(fixture("captured-search-not-found.html"))], loggedIn());
    const err = await c.findExistingRequest(DOI).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SciNetError);
    expect(String((err as Error).message)).toMatch(/not found in Crossref/);
  });

  it("errors on a fragment it cannot read", async () => {
    const { c } = client([() => html("<div>maintenance</div>")], loggedIn());
    await expect(c.findExistingRequest(DOI)).rejects.toThrow(/unrecognized response; not posting/);
  });
});

describe("SciNetClient.postRequest", () => {
  it("posts JSON {doi, reward} and confirms on the request page", async () => {
    const { c, seen } = client(
      [() => html(POSTED_FRAGMENT), () => html(fixture("captured-request-open.html"))],
      loggedIn(),
    );
    expect(await c.postRequest(DOI.toUpperCase(), 2)).toEqual({ id: DOI, url: PAGE_URL });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://sci-net.xyz/request");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ doi: DOI, reward: 2 });
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.url).toBe(PAGE_URL);
  });

  it("never re-posts when the request page does not show the new request", async () => {
    const { c, seen } = client(
      [() => html(POSTED_FRAGMENT), () => html("<p>maintenance</p>")],
      loggedIn(),
    );
    await expect(c.postRequest(DOI, 2)).rejects.toThrow(/does not show it; not re-posting/);
    expect(posts(seen)).toHaveLength(1);
  });

  it("never replays a bounced POST without checking for the request first", async () => {
    const { c, seen } = client(
      [
        () => redirect("/"),
        // Probe with the stale session: really logged out.
        () => html(fixture("captured-login-page.html")),
        ...LOGIN_OK,
        () => html(fixture("captured-search-existing.html")),
      ],
      loggedIn("sid=stale"),
    );
    expect((await c.postRequest(DOI, 2)).id).toBe(DOI);
    expect(posts(seen)).toHaveLength(1);
  });

  it("re-posts once after re-login when the lookup shows no request", async () => {
    const { c, seen } = client(
      [
        () => html(fixture("captured-login-page.html")),
        ...LOGIN_OK,
        () => html(fixture("captured-search-card.html")),
        () => html(POSTED_FRAGMENT),
        () => html(fixture("captured-request-open.html")),
      ],
      loggedIn("sid=stale"),
    );
    expect(await c.postRequest(DOI, 2)).toEqual({ id: DOI, url: PAGE_URL });
    expect(posts(seen)).toHaveLength(2);
    expect(posts(seen)[1]?.cookie).toBe("sid=abc; lang=en");
  });

  it("treats a redirect home with a live session as a possible post and looks it up", async () => {
    const { c, seen } = client(
      [
        () => redirect("/"),
        () => html(fixture("captured-home-logged-in.html")),
        () => html(fixture("captured-search-existing.html")),
      ],
      loggedIn(),
    );
    expect((await c.postRequest(DOI, 2)).id).toBe(DOI);
    expect(posts(seen)).toHaveLength(1);
  });

  it("never re-posts when a live-session redirect leaves nothing to find", async () => {
    const { c, seen } = client(
      [
        () => redirect("/"),
        () => html(fixture("captured-home-logged-in.html")),
        () => html(fixture("captured-search-card.html")),
      ],
      loggedIn(),
    );
    await expect(c.postRequest(DOI, 2)).rejects.toThrow(/not re-posting/);
    expect(posts(seen)).toHaveLength(1);
  });

  it("errors carry status and a short text excerpt, never raw HTML", async () => {
    const long = `<html><body><h1>Server error</h1><p>${"x".repeat(500)}</p></body></html>`;
    const { c } = client([() => html(long, 500)], loggedIn());
    const err = (await c.postRequest("10.1/x", 2).catch((e: unknown) => e)) as SciNetError;
    expect(err).toBeInstanceOf(SciNetError);
    const body = err.toJSON();
    expect(body["status"]).toBe(500);
    expect(String(body["excerpt"]).length).toBeLessThanOrEqual(200);
    expect(String(body["excerpt"])).not.toMatch(/[<>]/);
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });
});

describe("SciNetClient.listOwnRequests", () => {
  it("reads the library page into {doi, status}", async () => {
    const { c, seen } = client([() => html(fixture("captured-papers-requests.html"))], loggedIn());
    expect(await c.listOwnRequests()).toEqual([
      { doi: DOI, status: "open" },
      { doi: "10.1177/26345161261465536", status: "solved" },
    ]);
    expect(seen[0]?.url).toBe("https://sci-net.xyz/papers/requests");
  });
});

describe("SciNetClient.downloadPdf and verifyUpload", () => {
  it("downloads the storage PDF with the session cookie (same host)", async () => {
    const bytes = pdfBytes();
    const { c, seen } = client(
      [() => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } })],
      loggedIn(),
    );
    expect(await c.downloadPdf(SOLVED_PDF)).toEqual(bytes);
    expect(seen[0]?.url).toBe(SOLVED_PDF);
    expect(seen[0]?.cookie).toBe("sid=ok");
  });

  it("follows redirects and only sends the cookie to sci-net.xyz", async () => {
    const bytes = pdfBytes();
    const { c, seen } = client(
      [
        () => redirect("https://files.example.org/x.pdf"),
        () => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }),
      ],
      loggedIn(),
    );
    const got = await c.downloadPdf(SOLVED_PDF);
    expect(got).toEqual(bytes);
    expect(seen[0]?.cookie).toBe("sid=ok");
    expect(seen[1]?.cookie).toBeNull();
  });

  it("refuses oversized PDFs by Content-Length", async () => {
    const { c } = client(
      [() => new Response("x", { headers: { "content-length": String(60 * 1024 * 1024) } })],
      loggedIn(),
    );
    await expect(c.downloadPdf("/storage/2026/1/ab/big.pdf")).rejects.toThrow(/over 50 MB/);
  });

  it("verifyUpload is a no-op: Sci-Net has no verify control", async () => {
    const { c, seen } = client([], loggedIn());
    expect(await c.verifyUpload(DOI)).toEqual({
      ok: true,
      note: "no verify control on sci-net; nothing to confirm",
    });
    expect(seen).toHaveLength(0);
  });
});
