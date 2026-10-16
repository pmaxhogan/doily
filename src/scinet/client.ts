import { ToolError } from "../tools/types.ts";
import { SITE, htmlToText } from "./site.ts";

import type { RemoteStatus } from "./site.ts";

/** KV key of the stored Sci-Net cookie jar. */
export const SESSION_KEY = "scinet:session";

/** PDFs over this size are refused, matching get_pdf. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

const MAX_REDIRECTS = 5;

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
}

export interface SciNetClientOptions {
  fetch: typeof globalThis.fetch;
  user: string;
  pass: string;
  session: SessionStore;
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

/**
 * Talks to sci-net.xyz as a logged-in browser would. Site specifics come from
 * `SITE`; this class only handles cookies, re-login, redirects and errors.
 */
export class SciNetClient {
  private jar: string | null = null;

  constructor(private readonly opts: SciNetClientOptions) {}

  /** Log in with the configured account and persist the cookie jar. */
  async login(): Promise<string> {
    const form = new URLSearchParams({
      [SITE.login.userField]: this.opts.user,
      [SITE.login.passField]: this.opts.pass,
      ...SITE.login.extraFields,
    });
    const res = await this.opts.fetch(new URL(SITE.login.path, SITE.base).toString(), {
      method: "POST",
      headers: this.headers("", true),
      body: form.toString(),
      redirect: "manual",
    });
    const body = await res.text();
    let jar = mergeCookies("", setCookiesOf(res));
    if (res.status >= 400) throw new SciNetError("Sci-Net login failed", res.status, body);
    if (jar === "") throw new SciNetError("Sci-Net login set no session cookie", res.status, body);

    let page = body;
    let status = res.status;
    const location = res.headers.get("location");
    if (isRedirect(res.status) && location !== null) {
      // Confirm the session by loading where the login redirected us.
      const next = await this.opts.fetch(new URL(location, SITE.base).toString(), {
        method: "GET",
        headers: this.headers(jar, false),
        redirect: "manual",
      });
      page = await next.text();
      status = next.status;
      jar = mergeCookies(jar, setCookiesOf(next));
    }
    if (SITE.isLoginPage(page)) {
      // Do not echo the page: it is the login form, and nothing useful is in it.
      throw new SciNetError("Sci-Net login rejected (still on the login form)", status);
    }
    this.jar = jar;
    await this.opts.session.put(jar, SITE.sessionTtlSeconds);
    return jar;
  }

  /** Request id of an existing Sci-Net request for this DOI, if any. */
  async findExistingRequest(doi: string): Promise<string | undefined> {
    const r = await this.authed("GET", SITE.existing.path(doi));
    if (r.status === 404) return undefined;
    this.assertOk(r, "Sci-Net existing-request lookup failed");
    return SITE.existing.parse(r.body);
  }

  /**
   * Post a new request. Never replays blindly: if the POST bounced to the
   * login page we log in, look for the request first, and only then post once
   * more, so a session expiry cannot double-spend the bounty.
   */
  async postRequest(doi: string, bounty: number): Promise<{ id: string; url: string }> {
    const form: Record<string, string> = {
      [SITE.request.doiField]: doi,
      [SITE.request.bountyField]: String(bounty),
      ...SITE.request.extraFields,
    };
    await this.ensureSession();
    let r = await this.send("POST", SITE.request.path, form);
    if (r.loggedOut) {
      await this.login();
      const existing = await this.findExistingRequest(doi);
      if (existing !== undefined) return { id: existing, url: this.requestUrl(existing) };
      r = await this.send("POST", SITE.request.path, form);
      if (r.loggedOut) throw new SciNetError("Sci-Net session lost while posting", r.status);
    }
    this.assertOk(r, "Sci-Net request post failed");
    const id = SITE.request.parseId(r.location, r.body);
    if (id === undefined) {
      throw new SciNetError("Sci-Net request posted but no request id found", r.status, r.body);
    }
    return { id, url: this.requestUrl(id) };
  }

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
   * cookie is only ever sent to sci-net.xyz itself, never to a file host.
   */
  async downloadPdf(url: string): Promise<Uint8Array> {
    await this.ensureSession();
    let target = new URL(url, SITE.base);
    let relogged = false;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const sameSite = target.host === new URL(SITE.base).host;
      const res = await this.opts.fetch(target.toString(), {
        method: "GET",
        headers: this.headers(sameSite ? (this.jar ?? "") : "", false),
        redirect: "manual",
      });
      if (sameSite) this.absorb(res);
      const location = res.headers.get("location");
      if (isRedirect(res.status) && location !== null) {
        if (sameSite && SITE.isLoginRedirect(location) && !relogged) {
          await res.body?.cancel();
          await this.login();
          relogged = true;
          continue;
        }
        await res.body?.cancel();
        target = new URL(location, target);
        continue;
      }
      if (res.status >= 400) {
        throw new SciNetError("Sci-Net PDF download failed", res.status, await res.text());
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_PDF_BYTES) {
        await res.body?.cancel();
        throw new SciNetError("Sci-Net PDF is over 50 MB", 413);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_PDF_BYTES) throw new SciNetError("Sci-Net PDF is over 50 MB", 413);
      return bytes;
    }
    throw new SciNetError("Sci-Net PDF download redirected too many times", 310);
  }

  /** Confirm the upload on Sci-Net, which releases the bounty to the uploader. */
  async verifyUpload(id: string): Promise<boolean> {
    const r = await this.authed("POST", SITE.verify.path(id), SITE.verify.fields(id));
    return SITE.verify.parseOk(r.status, r.body);
  }

  requestUrl(id: string): string {
    return new URL(SITE.requestPage.path(id), SITE.base).toString();
  }

  /** Idempotent request with one re-login on a logged-out response. */
  private async authed(
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
  ): Promise<Sent> {
    await this.ensureSession();
    let r = await this.send(method, path, form);
    if (r.loggedOut) {
      await this.login();
      r = await this.send(method, path, form);
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

  private async send(
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
  ): Promise<Sent> {
    const init: RequestInit = {
      method,
      headers: this.headers(this.jar ?? "", form !== undefined),
      redirect: "manual",
    };
    if (form !== undefined) init.body = new URLSearchParams(form).toString();
    const res = await this.opts.fetch(new URL(path, SITE.base).toString(), init);
    this.absorb(res);
    const body = await res.text();
    const location = res.headers.get("location");
    const loggedOut =
      (isRedirect(res.status) && SITE.isLoginRedirect(location)) ||
      (res.status === 200 && SITE.isLoginPage(body));
    return { status: res.status, location, body, loggedOut };
  }

  private absorb(res: Response): void {
    const set = setCookiesOf(res);
    if (set.length > 0) this.jar = mergeCookies(this.jar ?? "", set);
  }

  private assertOk(r: Sent, message: string): void {
    if (r.status >= 400) throw new SciNetError(message, r.status, r.body);
  }

  private headers(cookie: string, form: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": SITE.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${SITE.base}/`,
    };
    if (cookie !== "") h["Cookie"] = cookie;
    if (form) h["Content-Type"] = "application/x-www-form-urlencoded";
    return h;
  }
}
