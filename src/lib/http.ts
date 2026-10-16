import pkg from "../../package.json" with { type: "json" };
import { ToolError } from "../tools/types.ts";
import { acquire, defaultSleep, type BucketName } from "./ratelimit.ts";

import type { Env } from "../env.ts";
import type { ProviderDeps } from "../providers/types.ts";

/**
 * The one way provider clients talk to upstreams: polite headers, the
 * provider's token bucket, one retry on 429, a deadline on every attempt
 * (headers and body), and errors that never leak a URL or a key. Never call
 * global fetch; always `deps.fetch`.
 */

/** Read from package.json so the User-Agent never drifts from the release. */
export const VERSION: string = pkg.version;
export const DEFAULT_CONTACT = "pmaxhogan@gmail.com";
/** Per-attempt budget (headers plus body) when a spec sets no timeoutMs. */
export const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_MS = 2000;
/** Used when a 429 carries no Retry-After (Semantic Scholar never sends one). */
const DEFAULT_RETRY_MS = 1000;
const EXCERPT_CHARS = 300;

export function contactEmail(env: Partial<Env>): string {
  return env.CONTACT_EMAIL?.trim() || DEFAULT_CONTACT;
}

export function userAgent(env: Partial<Env>): string {
  return `doily/${VERSION} (https://github.com/pmaxhogan/doily; mailto:${contactEmail(env)})`;
}

export interface RequestSpec {
  /** Provider name reported in errors. */
  source: string;
  url: string;
  bucket: BucketName;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  /** Return null instead of throwing on 404 (lookups of unknown ids). */
  allowNotFound?: boolean;
  /** Secret values to scrub from any error text (API keys). */
  secrets?: (string | undefined)[];
  /** Per-attempt deadline covering headers and body; defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds, clamped. */
export function retryAfterMs(header: string | null, now: Date): number {
  if (!header) return DEFAULT_RETRY_MS;
  const seconds = Number(header);
  let ms: number;
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const date = Date.parse(header);
    ms = Number.isFinite(date) ? date - now.getTime() : DEFAULT_RETRY_MS;
  }
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, ms));
}

/** Removes every secret from a string, so excerpts are safe to show. */
export function scrub(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  // Belt and braces: mask anything shaped like a key query parameter.
  return out.replace(/((?:api_key|apikey|key|token)=)[^&\s"']+/gi, "$1***");
}

export function excerpt(text: string, secrets?: (string | undefined)[]): string {
  return scrub(text.replace(/\s+/g, " ").trim(), secrets).slice(0, EXCERPT_CHARS);
}

/**
 * A DOI as a URL path: every character that would end the path (`?`, `#`) or
 * be misread (`%`, `<`, `>`, `;`, spaces) is percent-encoded, while `/` stays
 * literal so `10.1000/a/b` keeps its segments. SICI DOIs such as
 * `10.1002/(sici)...co;2-#` depend on this.
 */
export function encodeDoiPath(doi: string): string {
  return doi.split("/").map(encodeURIComponent).join("/");
}

/** A response whose deadline stays armed until `finish` is called. */
interface Sent {
  res: Response;
  /** Disarms the deadline; called once the body is consumed or discarded. */
  finish: () => void;
  timedOut: () => boolean;
}

function timeoutMsOf(spec: RequestSpec): number {
  return spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function timeoutError(spec: RequestSpec): ToolError {
  return new ToolError(`${spec.source} request timed out after ${timeoutMsOf(spec)} ms`, {
    source: spec.source,
    status: 0,
    timeout: true,
  });
}

async function send(deps: ProviderDeps, spec: RequestSpec): Promise<Sent> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent(deps.env),
    Accept: "application/json",
    ...spec.headers,
  };
  const secrets = spec.secrets ?? [];
  for (let attempt = 0; ; attempt++) {
    await acquire(deps, spec.bucket);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMsOf(spec));
    const finish = (): void => clearTimeout(timer);
    let res: Response;
    try {
      res = await deps.fetch(spec.url, {
        method: spec.method ?? "GET",
        headers,
        body: spec.body,
        signal: controller.signal,
      });
    } catch (err) {
      finish();
      if (timedOut) throw timeoutError(spec);
      const message = err instanceof Error ? err.message : String(err);
      throw new ToolError(`${spec.source} request failed: ${scrub(message, secrets)}`, {
        source: spec.source,
        status: 0,
      });
    }
    if (res.status === 429 && attempt === 0) {
      const wait = retryAfterMs(res.headers.get("Retry-After"), deps.now());
      await discard({ res, finish, timedOut: () => timedOut });
      await (deps.sleep ?? defaultSleep)(wait);
      continue;
    }
    return { res, finish, timedOut: () => timedOut };
  }
}

/** Reads the body as text under the attempt's deadline, then disarms it. */
async function readText(spec: RequestSpec, sent: Sent): Promise<string> {
  try {
    return await sent.res.text();
  } catch (err) {
    if (sent.timedOut()) throw timeoutError(spec);
    const message = err instanceof Error ? err.message : String(err);
    throw new ToolError(`${spec.source} response failed: ${scrub(message, spec.secrets)}`, {
      source: spec.source,
      status: sent.res.status,
    });
  } finally {
    sent.finish();
  }
}

/** Discards the body and disarms the deadline. */
async function discard(sent: Sent): Promise<void> {
  try {
    await sent.res.body?.cancel();
  } catch {
    // The response is being thrown away; nothing to report.
  } finally {
    sent.finish();
  }
}

async function failure(spec: RequestSpec, sent: Sent): Promise<ToolError> {
  let body = "";
  try {
    body = await readText(spec, sent);
  } catch {
    // The status alone is still useful.
  }
  return new ToolError(`${spec.source} returned HTTP ${sent.res.status}`, {
    source: spec.source,
    status: sent.res.status,
    body_excerpt: excerpt(body, spec.secrets),
  });
}

/** GETs JSON. Throws ToolError on non-2xx (or returns null on 404 if allowed). */
export async function fetchJson<T>(
  deps: ProviderDeps,
  spec: RequestSpec,
): Promise<HttpResult<T> | null> {
  const sent = await send(deps, spec);
  const { res } = sent;
  if (res.status === 404 && spec.allowNotFound) {
    await discard(sent);
    return null;
  }
  if (!res.ok) throw await failure(spec, sent);
  const text = await readText(spec, sent);
  try {
    return { data: JSON.parse(text) as T, status: res.status, headers: res.headers };
  } catch {
    throw new ToolError(`${spec.source} returned invalid JSON`, {
      source: spec.source,
      status: res.status,
      body_excerpt: excerpt(text, spec.secrets),
    });
  }
}

/** Like fetchJson but asserts a result (no allowNotFound). */
export async function fetchJsonRequired<T>(
  deps: ProviderDeps,
  spec: RequestSpec,
): Promise<HttpResult<T>> {
  const result = await fetchJson<T>(deps, { ...spec, allowNotFound: false });
  // fetchJson only returns null when allowNotFound is set.
  return result as HttpResult<T>;
}

/** GETs a text body (XML). Same error, timeout and 404 rules as fetchJson. */
export async function fetchText(
  deps: ProviderDeps,
  spec: RequestSpec,
): Promise<HttpResult<string> | null> {
  const sent = await send(deps, { ...spec, headers: { Accept: "*/*", ...spec.headers } });
  const { res } = sent;
  if (res.status === 404 && spec.allowNotFound) {
    await discard(sent);
    return null;
  }
  if (!res.ok) throw await failure(spec, sent);
  return { data: await readText(spec, sent), status: res.status, headers: res.headers };
}

/** Builds a query string, skipping undefined values. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}
