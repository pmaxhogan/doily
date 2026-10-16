import type { Env } from "../env.ts";
import type { ProviderDeps } from "../providers/types.ts";

/**
 * Per-provider token buckets.
 *
 * The hot path is an in-memory bucket per Worker isolate. Cloudflare KV only
 * tolerates about one write per second per key and is eventually consistent,
 * so it cannot be the authoritative counter at 10 requests per second. KV is
 * used to seed a fresh isolate (`ratelimit:<bucket>`) and is written back at
 * most once per second per bucket, best effort, errors swallowed. Without a
 * KV binding (unit tests) the in-memory bucket is all there is.
 *
 * Callers that exceed the rate go into debt: the bucket goes negative and each
 * caller sleeps until its token would have been minted, capped at
 * MAX_WAIT_MS so a burst can never stall a tool call indefinitely.
 */

export type BucketName =
  | "crossref_list"
  | "crossref_single"
  | "ncbi"
  | "openalex"
  | "s2"
  | "europepmc"
  | "doaj"
  | "unpaywall"
  | "biorxiv"
  | "core";

const MAX_WAIT_MS = 5000;
const KV_WRITE_INTERVAL_MS = 1000;

/** Requests per second for a bucket, given which API keys are configured. */
export function bucketRate(name: BucketName, env: Partial<Env>): number {
  switch (name) {
    case "crossref_list":
      return 3;
    case "crossref_single":
      return 10;
    case "ncbi":
      return env.NCBI_API_KEY ? 10 : 3;
    case "openalex":
      return env.OPENALEX_API_KEY ? 30 : 10;
    case "s2":
      // Keyed: 1 rps is the documented per-key limit. Unkeyed requests share
      // one global pool that 429s readily, so stay just as polite.
      return 1;
    case "europepmc":
      return 5;
    case "doaj":
      return 2;
    case "unpaywall":
      return 10;
    case "biorxiv":
      return 2;
    case "core":
      return 1;
  }
}

interface BucketState {
  tokens: number;
  ts: number;
  lastKvWrite: number;
  seeded: boolean;
}

const buckets = new Map<BucketName, BucketState>();

/** Test hook: forget all in-memory bucket state. */
export function resetRateLimits(): void {
  buckets.clear();
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function kvOf(deps: ProviderDeps): KVNamespace | undefined {
  const kv = (deps.env as Partial<Env>).DOILY_KV;
  return kv && typeof kv.get === "function" ? kv : undefined;
}

async function seed(deps: ProviderDeps, name: BucketName, state: BucketState): Promise<void> {
  state.seeded = true;
  const kv = kvOf(deps);
  if (!kv) return;
  try {
    const stored = await kv.get<{ tokens: number; ts: number }>(`ratelimit:${name}`, "json");
    if (stored && typeof stored.tokens === "number" && typeof stored.ts === "number") {
      state.tokens = Math.min(state.tokens, stored.tokens);
      state.ts = Math.max(state.ts, stored.ts);
    }
  } catch {
    // Best effort: a KV hiccup must never block an upstream call.
  }
}

/**
 * Takes one token from the bucket, sleeping first if the bucket is empty.
 * Returns the number of milliseconds waited (0 when a token was available).
 */
export async function acquire(deps: ProviderDeps, name: BucketName): Promise<number> {
  const rate = bucketRate(name, deps.env);
  const capacity = Math.max(1, rate);
  const now = deps.now().getTime();
  let state = buckets.get(name);
  if (!state) {
    state = { tokens: capacity, ts: now, lastKvWrite: 0, seeded: false };
    buckets.set(name, state);
  }
  if (!state.seeded) await seed(deps, name, state);

  const elapsed = Math.max(0, now - state.ts) / 1000;
  state.tokens = Math.min(capacity, state.tokens + elapsed * rate);
  state.ts = Math.max(state.ts, now);
  state.tokens -= 1;

  const kv = kvOf(deps);
  if (kv && now - state.lastKvWrite >= KV_WRITE_INTERVAL_MS) {
    state.lastKvWrite = now;
    kv.put(`ratelimit:${name}`, JSON.stringify({ tokens: state.tokens, ts: state.ts }), {
      expirationTtl: 60,
    }).catch(() => {
      // KV allows ~1 write/s per key; a rejected write only loses precision.
    });
  }

  if (state.tokens >= 0) return 0;
  const wait = Math.min(MAX_WAIT_MS, Math.ceil((-state.tokens / rate) * 1000));
  await (deps.sleep ?? defaultSleep)(wait);
  return wait;
}
