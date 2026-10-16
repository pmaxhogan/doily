import type { ToolDeps } from "../tools/types.ts";
import { isChallengePage } from "./detect.ts";
import { HTML_ACCEPT, ScihubFetchError, bodyText, scihubFetch } from "./fetch.ts";

/**
 * Mirror list: configured (or default) hosts, merged with hosts discovered
 * from mirror-list pages, health-checked, and cached for an hour.
 */

export const DEFAULT_MIRRORS: readonly string[] = [
  "sci-hub.ru",
  "sci-hub.ee",
  "sci-hub.ren",
  "sci-hub.al",
];

/**
 * Built-in discovery pages, used when SCIHUB_MIRROR_LIST_URL is unset. Both
 * answered 200 from a residential IP on 2026-10-16: the sci-hub.ru front page
 * has a mirror bar (`href = "//sci-hub.su"` ...), sci-hub.pub lists official
 * and third-party hosts. sci-hub.41610.org did not resolve and is left out.
 */
export const DISCOVERY_PAGES: readonly string[] = [
  "https://sci-hub.ru/",
  "https://www.sci-hub.pub/",
];

/** Hosts that match the sci-hub.<tld> shape but are not mirrors. */
const NOT_MIRRORS: ReadonlySet<string> = new Set(["sci-hub.pub", "sci-hub.shop"]);

export const MAX_MIRRORS = 12;
export const MIRROR_CACHE_KEY = "scihub:mirrors";
export const MIRROR_CACHE_TTL_MS = 60 * 60 * 1000;
export const HEALTH_TIMEOUT_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 8_000;
const PAGE_CAP_BYTES = 2 * 1024 * 1024;

type MirrorDeps = Pick<ToolDeps, "env" | "fetch" | "now">;

/** `https://www.Sci-Hub.ru/x` -> `sci-hub.ru`; null when not a plausible host. */
export function normalizeHost(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^\/\//, "");
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

/** Mirrors from SCIHUB_MIRRORS (comma separated) or the defaults. */
export function configuredMirrors(env: { SCIHUB_MIRRORS?: string }): string[] {
  const raw = env.SCIHUB_MIRRORS?.trim();
  if (!raw) return [...DEFAULT_MIRRORS];
  return dedupe(raw.split(",").map(normalizeHost));
}

/**
 * Every `sci-hub.<tld>` host linked from a page, absolute (`https://...`) or
 * protocol-relative (`//...`). Anchoring on `//` skips CDN subdomains such as
 * `img.sci-hub.shop`; the trailing look-ahead skips `sci-hub.reatk.com`.
 */
export function parseMirrorHosts(html: string): string[] {
  const re = /(?:https?:)?\/\/(?:www\.)?(sci-hub\.[a-z]{2,10})(?![a-z0-9.-])/gi;
  const found: (string | null)[] = [];
  for (let m = re.exec(html); m; m = re.exec(html)) found.push(normalizeHost(m[1] ?? ""));
  return dedupe(found).filter((h) => !NOT_MIRRORS.has(h));
}

function dedupe(hosts: (string | null)[]): string[] {
  const out: string[] = [];
  for (const h of hosts) if (h && !out.includes(h)) out.push(h);
  return out;
}

/**
 * Discovery pages to read: SCIHUB_MIRROR_LIST_URL (comma separated) when set,
 * `none` to disable discovery, otherwise the built-in pages.
 */
export function discoveryPages(env: { SCIHUB_MIRROR_LIST_URL?: string }): string[] {
  const raw = env.SCIHUB_MIRROR_LIST_URL?.trim();
  if (!raw) return [...DISCOVERY_PAGES];
  if (raw.toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Hosts discovered from every discovery page that answers; failures are skipped. */
export async function discoverMirrors(deps: MirrorDeps): Promise<string[]> {
  const pages = discoveryPages(deps.env);
  const results = await Promise.all(
    pages.map(async (page) => {
      try {
        const res = await scihubFetch(deps, page, {
          headers: { Accept: HTML_ACCEPT },
          timeoutMs: DISCOVERY_TIMEOUT_MS,
          maxBytes: PAGE_CAP_BYTES,
          partialOnTimeout: true,
        });
        if (res.status !== 200) return [];
        return parseMirrorHosts(bodyText(res.body));
      } catch {
        return [];
      }
    }),
  );
  return dedupe(results.flat());
}

export type HealthOutcome = "ok" | "challenge" | "status" | "empty" | "timeout" | "error";

export interface MirrorHealth {
  host: string;
  healthy: boolean;
  outcome: HealthOutcome;
  status?: number;
  ms: number;
}

/**
 * GET https://<host>/ within 5 s. Healthy = 200, a non-empty body, and not a
 * challenge page. Some mirrors (sci-hub.ee on 2026-10-16) send the page and
 * then stall the connection, so a body cut off by the deadline still counts if
 * the status line and some bytes arrived.
 */
export async function checkMirror(deps: MirrorDeps, host: string): Promise<MirrorHealth> {
  const started = Date.now();
  const done = (outcome: HealthOutcome, status?: number): MirrorHealth => ({
    host,
    healthy: outcome === "ok",
    outcome,
    ...(status === undefined ? {} : { status }),
    ms: Date.now() - started,
  });
  try {
    const res = await scihubFetch(deps, `https://${host}/`, {
      headers: { Accept: HTML_ACCEPT },
      timeoutMs: HEALTH_TIMEOUT_MS,
      maxBytes: PAGE_CAP_BYTES,
      partialOnTimeout: true,
    });
    if (res.status !== 200) {
      // DDoS-Guard answers 403 with its interstitial; report that as a challenge.
      return done(isChallengePage(bodyText(res.body)) ? "challenge" : "status", res.status);
    }
    if (res.body.byteLength === 0) return done(res.partial ? "timeout" : "empty", res.status);
    return done(isChallengePage(bodyText(res.body)) ? "challenge" : "ok", res.status);
  } catch (err) {
    return done(err instanceof ScihubFetchError && err.kind === "timeout" ? "timeout" : "error");
  }
}

interface CachedMirrors {
  mirrors: string[];
  checkedAt: number;
}

let memoryCache: CachedMirrors | null = null;

/** Test hook: forget the per-isolate cache. */
export function clearMirrorMemoryCache(): void {
  memoryCache = null;
}

function fresh(c: CachedMirrors | null, now: number): c is CachedMirrors {
  return c != null && now - c.checkedAt >= 0 && now - c.checkedAt < MIRROR_CACHE_TTL_MS;
}

async function readCache(deps: MirrorDeps, now: number): Promise<string[] | null> {
  if (fresh(memoryCache, now)) return memoryCache.mirrors;
  const kv = deps.env.DOILY_KV as KVNamespace | undefined;
  if (!kv) return null;
  try {
    const raw = await kv.get(MIRROR_CACHE_KEY, "text");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedMirrors;
    if (!Array.isArray(parsed.mirrors) || typeof parsed.checkedAt !== "number") return null;
    if (!fresh(parsed, now)) return null;
    memoryCache = parsed;
    return parsed.mirrors;
  } catch {
    return null;
  }
}

async function writeCache(deps: MirrorDeps, value: CachedMirrors): Promise<void> {
  memoryCache = value;
  const kv = deps.env.DOILY_KV as KVNamespace | undefined;
  if (!kv) return;
  try {
    await kv.put(MIRROR_CACHE_KEY, JSON.stringify(value), {
      expirationTtl: MIRROR_CACHE_TTL_MS / 1000,
    });
  } catch {
    // A cache write failure only costs a re-check next time.
  }
}

export interface MirrorListResult {
  mirrors: string[];
  fromCache: boolean;
  health: MirrorHealth[];
}

/**
 * Ordered mirrors to try: healthy ones (configured order first, then
 * discovered), followed by configured mirrors whose front page merely timed
 * out (sci-hub.ren stalled its front page on 2026-10-16 while its article
 * pages answered). Cached in KV `scihub:mirrors` for one hour. When nothing
 * passes, the configured list is returned uncached so resolution still tries.
 */
export async function getMirrors(
  deps: MirrorDeps,
  opts: { refresh?: boolean } = {},
): Promise<MirrorListResult> {
  const now = deps.now().getTime();
  if (!opts.refresh) {
    const cached = await readCache(deps, now);
    if (cached && cached.length > 0) return { mirrors: cached, fromCache: true, health: [] };
  }
  const configured = configuredMirrors(deps.env);
  const discovered = await discoverMirrors(deps);
  const candidates = dedupe([...configured, ...discovered]).slice(0, MAX_MIRRORS);
  const health = await Promise.all(candidates.map((h) => checkMirror(deps, h)));
  const healthy = health.filter((h) => h.healthy).map((h) => h.host);
  const slow = health
    .filter((h) => h.outcome === "timeout" && configured.includes(h.host))
    .map((h) => h.host);
  if (healthy.length === 0) return { mirrors: configured, fromCache: false, health };
  const mirrors = [...healthy, ...slow];
  await writeCache(deps, { mirrors, checkedAt: now });
  return { mirrors, fromCache: false, health };
}

/** Convenience: just the ordered host list. */
export async function getHealthyMirrors(deps: MirrorDeps): Promise<string[]> {
  return (await getMirrors(deps)).mirrors;
}
