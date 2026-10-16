import type { Env } from "./env.ts";

/**
 * Unauthenticated health report. Booleans only: never a URL, a mirror name or
 * anything derived from a secret, because this endpoint is public.
 */
export interface Health {
  ok: boolean;
  scihub_configured: boolean;
  scinet_configured: boolean;
  bearer_configured: boolean;
}

export function healthz(env: Pick<Env, "SCINET_USER" | "SCINET_PASS" | "DOILY_BEARER">): Health {
  return {
    ok: true,
    scihub_configured: true,
    scinet_configured: Boolean(env.SCINET_USER && env.SCINET_PASS),
    bearer_configured: Boolean(env.DOILY_BEARER),
  };
}
