import { ToolError } from "../tools/types.ts";

import type { ToolDeps } from "../tools/types.ts";

/**
 * Daily Sci-Net spend ledger in D1 (`scinet_spend`, migration 0001), keyed by
 * UTC day. A reservation is one atomic UPSERT guarded by `requests < cap`, so
 * two concurrent request_paper calls cannot both take the last slot.
 */

export const DEFAULT_BOUNTY = 2;
export const DEFAULT_DAILY_CAP = 5;

export const SPEND_SQL = {
  reserve:
    "INSERT INTO scinet_spend (day, requests, tokens) VALUES (?1, 1, ?2) " +
    "ON CONFLICT(day) DO UPDATE SET requests = scinet_spend.requests + 1, " +
    "tokens = scinet_spend.tokens + excluded.tokens WHERE scinet_spend.requests < ?3",
  release:
    "UPDATE scinet_spend SET requests = MAX(requests - 1, 0), tokens = MAX(tokens - ?2, 0) " +
    "WHERE day = ?1",
  usage: "SELECT requests, tokens FROM scinet_spend WHERE day = ?1",
} as const;

type SpendDeps = Pick<ToolDeps, "env" | "now">;

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** The configured bounty (SCINET_BOUNTY, default 2). */
export function configuredBounty(deps: Pick<ToolDeps, "env">): number {
  return intEnv(deps.env.SCINET_BOUNTY, DEFAULT_BOUNTY);
}

/** The configured daily cap of new requests (SCINET_DAILY_CAP, default 5). */
export function dailyCap(deps: Pick<ToolDeps, "env">): number {
  return intEnv(deps.env.SCINET_DAILY_CAP, DEFAULT_DAILY_CAP);
}

/** UTC day, `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Take one request slot for today, or throw a ToolError when the cap is reached. */
export async function reserve(deps: SpendDeps, bounty: number): Promise<{ day: string }> {
  const day = utcDay(deps.now());
  const cap = dailyCap(deps);
  if (cap > 0) {
    const res = await deps.env.DB.prepare(SPEND_SQL.reserve).bind(day, bounty, cap).run();
    if ((res.meta.changes ?? 0) === 1) return { day };
  }
  throw new ToolError("daily Sci-Net request cap reached", {
    source: "scinet",
    cap,
    day,
    hint: "the cap resets at 00:00 UTC; raise SCINET_DAILY_CAP to change it",
  });
}

/** Give back a slot taken by `reserve` (posting failed or an existing request was joined). */
export async function release(deps: SpendDeps, day: string, bounty: number): Promise<void> {
  await deps.env.DB.prepare(SPEND_SQL.release).bind(day, bounty).run();
}

/** Today's usage, for list_requests. */
export async function usage(
  deps: SpendDeps,
): Promise<{ day: string; requests: number; tokens: number; cap: number }> {
  const day = utcDay(deps.now());
  const row = await deps.env.DB.prepare(SPEND_SQL.usage)
    .bind(day)
    .first<{ requests: number; tokens: number }>();
  return { day, requests: row?.requests ?? 0, tokens: row?.tokens ?? 0, cap: dailyCap(deps) };
}
