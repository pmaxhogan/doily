import { MIRROR_CACHE_KEY } from "./scihub/mirrors.ts";
import { SESSION_KEY as SCINET_SESSION_KEY } from "./scinet/client.ts";

import type { Env } from "./env.ts";

/**
 * Unauthenticated health report. Booleans only: never a URL, a mirror name or
 * anything derived from a secret, because this endpoint is public. The
 * reachability flags read what the Worker already cached in KV rather than
 * probing upstreams, so an unauthenticated caller cannot make the Worker hit
 * Sci-Hub or Sci-Net on demand.
 */
export interface Health {
  ok: boolean;
  bearer_configured: boolean;
  scinet_configured: boolean;
  /** A Sci-Net session cookie is cached, i.e. the last login worked. */
  scinet_session_cached: boolean;
  /** A healthy Sci-Hub mirror list is cached, i.e. the last health check found one. */
  scihub_mirror_cached: boolean;
}

export async function healthz(
  env: Pick<Env, "SCINET_USER" | "SCINET_PASS" | "DOILY_BEARER"> & { DOILY_KV?: KVNamespace },
): Promise<Health> {
  const [session, mirrors] = await Promise.all([
    cachedFlag(env.DOILY_KV, SCINET_SESSION_KEY),
    cachedFlag(env.DOILY_KV, MIRROR_CACHE_KEY),
  ]);
  return {
    ok: true,
    bearer_configured: Boolean(env.DOILY_BEARER),
    scinet_configured: Boolean(env.SCINET_USER && env.SCINET_PASS),
    scinet_session_cached: session,
    scihub_mirror_cached: mirrors,
  };
}

async function cachedFlag(kv: KVNamespace | undefined, key: string): Promise<boolean> {
  if (!kv) return false;
  try {
    return (await kv.get(key)) !== null;
  } catch {
    return false;
  }
}
