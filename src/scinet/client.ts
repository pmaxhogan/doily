import { ToolError } from "../tools/types.ts";
import { SITE, VERIFY_NOTE, htmlToText } from "./site.ts";

import type { LibraryRow, RemoteStatus } from "./site.ts";

/** KV key of the stored Sci-Net cookie jar. */
export const SESSION_KEY = "scinet:session";

/** PDFs over this size are refused, matching get_pdf. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Deadline for one page request (headers plus body). */
export const PAGE_TIMEOUT_MS = 20_000;
/** Deadline for a whole PDF download, every redirect hop and the body included. */
export const PDF_TIMEOUT_MS = 60_000;

const MAX_REDIRECTS = 5;
/** Initial buffer when a PDF response declares no Content-Length. */
const INITIAL_PDF_BUFFER = 1024 * 1024;

/** Where the cookie jar string is kept between invocations. */
export interface SessionStore {
  get(): Promise<string | null>;
  put(cookie: string, ttlSeconds: number): Promise<void>;
  clear(): Promise<void>;
}

/** Minimal KV surface the session store needs (KVNamespace satisfies it). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function kvSessionStore(kv: KvLike, key = SESSION_KEY): SessionStore {
  return {
    get: () => kv.get(key),
    // KV rejects TTLs under 60 seconds.
    put: (cookie, ttl) => kv.put(key, cookie, { expirationTtl: Math.max(60, ttl) }),
    clear: () => kv.delete(key),
  };
}

/** Body excerpt for errors: visible text only, at most 200 chars. Never raw HTML. */
export function excerpt(body: string): string {
  return htmlToText(body).slice(0, 200);
}

/** A Sci-Net failure. Carries the upstream status and a short text excerpt. */
export class SciNetError extends ToolError {
  constructor(message: string, status: number, body = "") {
    super(message, { source: "scinet", status, excerpt: excerpt(body) });
    this.name = "SciNetError";
  }

  get status(): number {
    return this.details["status"] as number;
  }
}

export interface RequestStatus {
  status: RemoteStatus;
  pdfUrl?: string;
  uploadedAt?: string;
  reward?: number;
  taken?: boolean;
}

/** Outcome of confirming an upload on Sci-Net. */
export interface VerifyResult {
  ok: boolean;
  note?: string;
}

/** A request body: a urlencoded form or a JSON value. */
type Body = { form: Record<string, string> } | { json: unknown };

export interface SciNetClientOptions {
  fetch: typeof globalThis.fetch;
  user: string;
  pass: string;
  session: SessionStore;
  /** Overrides for tests; default PAGE_TIMEOUT_MS and PDF_TIMEOUT_MS. */
  pageTimeoutMs?: number;
  pdfTimeoutMs?: number;
}

interface Sent {
  status: number;
  location: string | null;
  body: string;
  loggedOut: boolean;
}

/** Parse `name=value` pairs out of Set-Cookie headers into the jar. */
export function mergeCookies(jar: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  for (const pair of jar.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const header of setCookies) {
    const first = header.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const expired =
      /;\s*max-age\s*=\s*(?:0|-\d+)/i.test(header) || value === "" || value === "deleted";
    if (expired) map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}

function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single === null ? [] : [single];
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** True when `url` is on sci-net.xyz itself, the only host that may see the cookie. */
function isSiteHost(url: URL): boolean {
  return url.host === new URL(SITE.base).host;
}

/**
 * Read a body into one buffer, refusing it as soon as it passes `max` bytes,
 * so a chunked or endless body never gets buffered whole. With a declared
 * Content-Length the buffer is allocated once at that size.
 */
async function readCapped(res: Response, max: number, declared: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  let buf = new Uint8Array(declared > 0 ? declared : Math.min(INITIAL_PDF_BUFFER, max));
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > max) {
      await reader.cancel().catch(() => undefined);
      throw new SciNetError("Sci-Net PDF is over 50 MB", 413);
    }
    if (total + value.byteLength > buf.byteLength) {
      const grown = new Uint8Array(
        Math.min(max, Math.max(buf.byteLength * 2, total + value.byteLength)),
      );
      grown.set(buf.subarray(0, total));
      buf = grown;
    }
    buf.set(value, total);
    total += value.byteLength;
  }
  return total === buf.byteLength ? buf : buf.subarray(0, total);
}

/**
 * Talks to sci-net.xyz as a logged-in browser would. Site specifics come from
 * `SITE`; this class only handles cookies, re-login, redirects, deadlines and
 * errors. Every fetch has a deadline, every redirect is followed by hand, and
 * the session cookie is only ever sent to sci-net.xyz itself.
 */
export class SciNetClient {
  private jar: string | null = null;

  constructor(private readonly opts: SciNetClientOptions) {}

  /** Log in with the configured account and persist the cookie jar. */
  async login(): Promise<string> {
    const form = {
      form: {
        [SITE.login.userField]: this.opts.user,
        [SITE.login.passField]: this.opts.pass,
        ...SITE.login.extraFields,
      },
    };
    const first = await this.fetchPage(new URL(SITE.login.path, SITE.base), {
      method: "POST",
      headers: this.headers("", form),
      body: new URLSearchParams(form.form).toString(),
    });
    let jar = mergeCookies("", setCookiesOf(first.res));
    if (first.res.status >= 400) {
      throw new SciNetError("Sci-Net login failed", first.res.status, first.body);
    }
    if (jar === "") {
      throw new SciNetError("Sci-Net login set no session cookie", first.res.status, first.body);
    }

    let page = first.body;
    let status = first.res.status;
    const location = first.res.headers.get("location");
    if (isRedirect(first.res.status) && location !== null) {
      // Confirm the session by loading where the login redirected us. An
      // off-site Location never sees the cookie: confirm on the home page.
      const target = new URL(location, SITE.base);
      const next = await this.fetchPage(isSiteHost(target) ? target : new URL("/", SITE.base), {
        method: "GET",
        headers: this.headers(jar),
      });
      page = next.body;
      status = next.res.status;
      jar = mergeCookies(jar, setCookiesOf(next.res));
    }
    if (SITE.isLoginPage(page)) {
      // Do not echo the page: it is the login form, and nothing useful is in it.
      throw new SciNetError("Sci-Net login rejected (still on the login form)", status);
    }
    this.jar = jar;
    await this.opts.session.put(jar, SITE.sessionTtlSeconds);
    return jar;
  }

  /**
   * The id of Sci-Net's existing request for this DOI (the DOI itself), or
   * undefined when a new request can be posted. `POST /search` answers with an
   * HTML fragment; a DOI Crossref does not know, or a fragment we cannot read,
   * is an error so nothing gets posted on a guess.
   */
  async findExistingRequest(doi: string): Promise<string | undefined> {
    const id = doi.trim().toLowerCase();
    const r = await this.authed("POST", SITE.lookup.path, { json: SITE.lookup.body(id) });
    this.assertOk(r, "Sci-Net existing-request lookup failed");
    const found = SITE.lookup.parse(r.body, id);
    switch (found.kind) {
      case "existing":
        return id;
      case "new":
        return undefined;
      case "not_found":
        throw new SciNetError("DOI not found in Crossref; Sci-Net cannot take it", r.status);
      default:
        throw new SciNetError(
          "Sci-Net lookup returned an unrecognized response; not posting",
          r.status,
          r.body,
        );
    }
  }

  /**
   * Post a new request, then confirm it on its page. Never replays blindly:
   * if the POST bounced to the login page we log in, look for the request
   * first, and only then post once more, so a session expiry cannot
   * double-spend the bounty. The request id is the DOI.
   */
  async postRequest(doi: string, bounty: number): Promise<{ id: string; url: string }> {
    const id = doi.trim().toLowerCase();
    const body: Body = { json: SITE.request.body(id, bounty) };
    await this.ensureSession();
    let r = await this.send("POST", SITE.request.path, body);
    if (r.loggedOut && isRedirect(r.status)) {
      // A POST that redirects to "/" may still have gone through. Probe with
      // the current session: if it is still alive, look the request up and
      // never re-post. An off-site Location is never probed (it would receive
      // the cookie); "/" is.
      const probe = await this.send("GET", this.onSitePath(r.location));
      if (!probe.loggedOut) {
        const existing = await this.findExistingRequest(id);
        if (existing !== undefined) return { id: existing, url: this.requestUrl(existing) };
        throw new SciNetError(
          "Sci-Net request may have been posted but the lookup does not show it; not re-posting",
          r.status,
        );
      }
    }
    if (r.loggedOut) {
      await this.login();
      const existing = await this.findExistingRequest(id);
      if (existing !== undefined) return { id: existing, url: this.requestUrl(existing) };
      r = await this.send("POST", SITE.request.path, body);
      if (r.loggedOut) throw new SciNetError("Sci-Net session lost while posting", r.status);
    }
    this.assertOk(r, "Sci-Net request post failed");
    // The response is a re-rendered fragment; the request page is the proof.
    const page = await this.getRequestStatus(id);
    if (page.status === "unknown") {
      throw new SciNetError(
        "Sci-Net request posted but its page does not show it; not re-posting",
        r.status,
      );
    }
    return { id, url: this.requestUrl(id) };
  }

  /** The owner's requests from the library page, newest first. */
  async listOwnRequests(): Promise<LibraryRow[]> {
    const r = await this.authed("GET", SITE.library.path);
    this.assertOk(r, "Sci-Net library page failed");
    return SITE.library.parse(r.body);
  }

  /** Status of a request; `id` is the DOI. */
  async getRequestStatus(id: string): Promise<RequestStatus> {
    const r = await this.authed("GET", SITE.requestPage.path(id));
    this.assertOk(r, "Sci-Net request page failed");
    const parsed = SITE.requestPage.parse(r.body);
    if (parsed.pdfUrl !== undefined) {
      parsed.pdfUrl = new URL(parsed.pdfUrl, SITE.base).toString();
    }
    return parsed;
  }

  /**
   * Download a fulfilled PDF. Redirects are followed by hand so the session
   * cookie is only ever sent to sci-net.xyz itself, never to a file host. The
   * body is streamed into a buffer capped at MAX_PDF_BYTES, and the whole
   * download (every hop plus the body) shares one PDF_TIMEOUT_MS deadline.
   */
  async downloadPdf(url: string): Promise<Uint8Array> {
    await this.ensureSession();
    const ms = this.opts.pdfTimeoutMs ?? PDF_TIMEOUT_MS;
    return this.withDeadline(ms, "Sci-Net PDF download", async (signal) => {
      let target = new URL(url, SITE.base);
      let relogged = false;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const sameSite = isSiteHost(target);
        const res = await this.opts.fetch(target.toString(), {
          method: "GET",
          headers: this.headers(sameSite ? (this.jar ?? "") : ""),
          redirect: "manual",
          signal,
        });
        if (sameSite) this.absorb(res);
        const location = res.headers.get("location");
        if (isRedirect(res.status) && location !== null) {
          await res.body?.cancel().catch(() => undefined);
          if (sameSite && SITE.isLoginRedirect(location) && !relogged) {
            await this.login();
            relogged = true;
            continue;
          }
          target = new URL(location, target);
          continue;
        }
        if (res.status >= 400) {
          throw new SciNetError("Sci-Net PDF download failed", res.status, await res.text());
        }
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (declared > MAX_PDF_BYTES) {
          await res.body?.cancel().catch(() => undefined);
          throw new SciNetError("Sci-Net PDF is over 50 MB", 413);
        }
        return readCapped(res, MAX_PDF_BYTES, Number.isFinite(declared) ? declared : 0);
      }
      throw new SciNetError("Sci-Net PDF download redirected too many times", 310);
    });
  }

  /**
   * Confirm the upload on Sci-Net. No verify or confirm control was seen on
   * any solved page (docs/scinet-capture.md), so there is nothing to send:
   * the request is complete once the PDF passes the machine's sanity check.
   */
  verifyUpload(_id: string): Promise<VerifyResult> {
    return Promise.resolve({ ok: true, note: VERIFY_NOTE });
  }

  requestUrl(id: string): string {
    return new URL(SITE.requestPage.path(id), SITE.base).toString();
  }

  /** Idempotent request with one re-login on a logged-out response. */
  private async authed(method: "GET" | "POST", path: string, body?: Body): Promise<Sent> {
    await this.ensureSession();
    let r = await this.send(method, path, body);
    if (r.loggedOut) {
      await this.login();
      r = await this.send(method, path, body);
      if (r.loggedOut) throw new SciNetError("Sci-Net session rejected after re-login", r.status);
    }
    return r;
  }

  private async ensureSession(): Promise<void> {
    if (this.jar !== null && this.jar !== "") return;
    const stored = await this.opts.session.get();
    if (stored !== null && stored !== "") {
      this.jar = stored;
      return;
    }
    await this.login();
  }

  /** The path of an on-site Location, or "/" for a missing or off-site one. */
  private onSitePath(location: string | null): string {
    if (location === null) return "/";
    try {
      const target = new URL(location, SITE.base);
      return isSiteHost(target) ? `${target.pathname}${target.search}` : "/";
    } catch {
      return "/";
    }
  }

  private async send(method: "GET" | "POST", path: string, payload?: Body): Promise<Sent> {
    const target = new URL(path, SITE.base);
    // `new URL` accepts absolute URLs; never let one carry the cookie off-site.
    if (!isSiteHost(target)) throw new SciNetError("Sci-Net off-site request refused", 0);
    const init: RequestInit = { method, headers: this.headers(this.jar ?? "", payload) };
    if (payload !== undefined) {
      init.body =
        "json" in payload
          ? JSON.stringify(payload.json)
          : new URLSearchParams(payload.form).toString();
    }
    const { res, body } = await this.fetchPage(target, init);
    this.absorb(res);
    const location = res.headers.get("location");
    const loggedOut =
      (isRedirect(res.status) && SITE.isLoginRedirect(location)) ||
      (res.status === 200 && SITE.isLoginPage(body));
    return { status: res.status, location, body, loggedOut };
  }

  /** One page fetch (no redirect following) with its body read under PAGE_TIMEOUT_MS. */
  private fetchPage(target: URL, init: RequestInit): Promise<{ res: Response; body: string }> {
    const ms = this.opts.pageTimeoutMs ?? PAGE_TIMEOUT_MS;
    return this.withDeadline(ms, "Sci-Net request", async (signal) => {
      const res = await this.opts.fetch(target.toString(), { ...init, redirect: "manual", signal });
      return { res, body: await res.text() };
    });
  }

  /** Runs `fn` with an abort signal that fires after `ms`, reported as a SciNetError. */
  private async withDeadline<T>(
    ms: number,
    what: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (timedOut) throw new SciNetError(`${what} timed out after ${ms} ms`, 0);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private absorb(res: Response): void {
    const set = setCookiesOf(res);
    if (set.length > 0) this.jar = mergeCookies(this.jar ?? "", set);
  }

  private assertOk(r: Sent, message: string): void {
    if (r.status >= 400) throw new SciNetError(message, r.status, r.body);
  }

  private headers(cookie: string, body?: Body): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": SITE.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${SITE.base}/`,
    };
    if (cookie !== "") h["Cookie"] = cookie;
    if (body !== undefined && "json" in body) {
      // What the home page's fetch() sends for /search and /request.
      h["Content-Type"] = "application/json";
      h["Origin"] = SITE.base;
    } else if (body !== undefined) {
      h["Content-Type"] = "application/x-www-form-urlencoded";
    }
    return h;
  }
}
