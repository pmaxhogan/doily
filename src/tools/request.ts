import { z } from "zod";

import { normalizeDoi } from "../scinet/doi.ts";
import { scinetHooks } from "../scinet/hooks.ts";
import { SITE, SITE_VERIFIED } from "../scinet/site.ts";
import { configuredBounty, release, reserve, usage } from "../scinet/spend.ts";
import { verifyRequestToken } from "../scinet/token.ts";
import { ToolError } from "./types.ts";

import type { Env } from "../env.ts";
import type { RequestState, RequestStatusName, StartResult } from "../scinet/machine.ts";
import type { ToolDef, ToolDeps } from "./types.ts";

/** KV key of the JSON array of requested DOIs (list_requests fans out over it). */
export const INDEX_KEY = "scinet:requests";
export const ETA_HINT = "usually hours, sometimes under 30 minutes";
/** Same page size as get_full_text. */
export const PAGE_CHARS = 60000;

const LIVE: readonly RequestStatusName[] = ["pending", "ready", "needs_owner"];
const STATUSES = ["pending", "ready", "expired", "failed", "needs_owner"] as const;

/** The RPC surface of the SciNetRequest DO as seen through a stub. */
export interface RequestStub {
  start(doi: string, bounty: number, title?: string): Promise<StartResult>;
  status(): Promise<RequestState | null>;
  waitFor(maxMs: number): Promise<RequestState | null>;
}

export function stubFor(env: Pick<Env, "SCINET_REQUEST">, doi: string): RequestStub {
  const ns = env.SCINET_REQUEST;
  return ns.get(ns.idFromName(doi)) as unknown as RequestStub;
}

/** A DOI, or a request_token from get_full_text, to a normalized DOI. */
export async function resolveId(deps: Pick<ToolDeps, "env">, id: string): Promise<string> {
  const direct = normalizeDoi(id);
  if (direct !== null) return direct;
  const trimmed = id.trim();
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    const fromToken = await verifyRequestToken(deps.env.REQUEST_TOKEN_SECRET, trimmed);
    const doi = fromToken === null ? null : normalizeDoi(fromToken);
    if (doi !== null) return doi;
    throw new ToolError("invalid request_token", { id: trimmed.slice(0, 80) });
  }
  throw new ToolError("id is neither a DOI nor a request_token", { id: trimmed.slice(0, 80) });
}

async function readIndex(kv: KVNamespace): Promise<string[]> {
  const raw = await kv.get(INDEX_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((d): d is string => typeof d === "string"))];
  } catch {
    return [];
  }
}

/**
 * Read-modify-write; two concurrent request_paper calls can drop one entry.
 * Accepted for a single-owner server: the DO still exists and a repeat
 * request_paper for that DOI re-adds it.
 */
async function addToIndex(kv: KVNamespace, doi: string): Promise<void> {
  const index = await readIndex(kv);
  if (index.includes(doi)) return;
  index.push(doi);
  await kv.put(INDEX_KEY, JSON.stringify(index));
}

function summary(state: RequestState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    request_id: state.doi,
    doi: state.doi,
    status: state.status,
    created_at: state.created_at,
    updated_at: state.updated_at,
    attempts: state.attempts,
    bounty: state.bounty,
  };
  if (state.request_id !== undefined) out["scinet_request_id"] = state.request_id;
  if (state.joined !== undefined) out["joined_existing"] = state.joined;
  if (state.ready_at !== undefined) out["ready_at"] = state.ready_at;
  if (state.uploaded_at !== undefined) out["uploaded_at"] = state.uploaded_at;
  if (state.verified !== undefined) out["verified"] = state.verified;
  if (state.verify_note !== undefined) out["verify_note"] = state.verify_note;
  if (state.accepted_at !== undefined) out["accepted_at"] = state.accepted_at;
  if (state.last_error !== undefined) out["last_error"] = state.last_error;
  if (state.status === "needs_owner") {
    const notAccepted = state.last_error?.includes("not accepted on Sci-Net") === true;
    out["note"] = notAccepted
      ? "a file was uploaded but failed the sanity check; it was left unverified for the owner " +
        "and was not accepted on Sci-Net (accept or report it at " +
        `${SITE.base}${SITE.view.path(state.doi)})`
      : "a file was uploaded but failed the sanity check; it was left unverified for the owner";
  }
  return out;
}

interface RequestPaperArgs {
  id: string;
  bounty?: number | undefined;
}

export const requestPaper: ToolDef<RequestPaperArgs> = {
  name: "request_paper",
  title: "Request a paper on Sci-Net",
  description:
    "Post a Sci-Net bounty request for a paper no open source can deliver (or join Sci-Net's " +
    "existing request for it). Refuses when the open-access chain can already get the paper, " +
    "when the bounty exceeds the configured maximum, or when today's request cap is used up. " +
    "Returns at once; poll with wait_for_request. " +
    'Example: request_paper({ "id": "10.1038/nature12373" })',
  inputSchema: {
    id: z
      .string()
      .min(1)
      .describe("A DOI (10.xxxx/...) or the request_token returned by get_full_text"),
    bounty: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Bounty in Sci-Net tokens; defaults to and may not exceed SCINET_BOUNTY (2)"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(deps, args) {
    const doi = await resolveId(deps, args.id);
    const max = configuredBounty(deps);
    const bounty = args.bounty ?? max;
    if (bounty > max) {
      throw new ToolError("bounty above the configured maximum; it is never raised", {
        bounty,
        max,
      });
    }
    if (!deps.env.SCINET_USER || !deps.env.SCINET_PASS) {
      throw new ToolError("Sci-Net is not configured (SCINET_USER / SCINET_PASS unset)", {
        source: "scinet",
      });
    }

    // Kill switch: if the site changes shape, SITE_VERIFIED goes back to false
    // and posting stays off (it could spend tokens on nothing) unless the owner
    // opts in explicitly. The flow was captured in docs/scinet-capture.md.
    if (!SITE_VERIFIED && deps.env.SCINET_ALLOW_UNVERIFIED !== "1") {
      throw new ToolError("Sci-Net posting is disabled until the site flow is verified", {
        source: "scinet",
        hint: "capture the logged-in flow and set SITE_VERIFIED, or set SCINET_ALLOW_UNVERIFIED=1",
      });
    }

    const obtainable = await scinetHooks.isObtainable(deps, doi);
    if (obtainable !== false) {
      throw new ToolError("obtainable", {
        source: obtainable.source,
        hint: "use get_full_text or get_pdf instead",
      });
    }

    const stub = stubFor(deps.env, doi);
    const current = await stub.status();
    if (current !== null && LIVE.includes(current.status)) {
      await addToIndex(deps.env.DOILY_KV, doi);
      return { request_id: doi, status: current.status, eta_hint: ETA_HINT, existing: true };
    }

    const { day } = await reserve(deps, bounty);
    let result: StartResult;
    try {
      result = await stub.start(doi, bounty);
    } catch (e) {
      await release(deps, day, bounty);
      throw new ToolError("Sci-Net request failed", {
        source: "scinet",
        reason: e instanceof Error ? e.message.slice(0, 200) : "unknown",
      });
    }
    if (!result.ok) {
      await release(deps, day, bounty);
      throw new ToolError(result.error, { source: "scinet", ...result.details });
    }
    // Only a fresh post spends a slot of the daily cap.
    if (!result.posted) await release(deps, day, bounty);
    await addToIndex(deps.env.DOILY_KV, doi);
    return {
      request_id: doi,
      status: result.state.status,
      eta_hint: ETA_HINT,
      joined_existing: result.state.joined === true,
    };
  },
};

interface WaitArgs {
  request_id: string;
  max_wait_seconds?: number | undefined;
}

export const waitForRequest: ToolDef<WaitArgs> = {
  name: "wait_for_request",
  title: "Wait for a Sci-Net request",
  description:
    "Long-poll a Sci-Net request made with request_paper for up to max_wait_seconds. On ready " +
    "returns the first page of the paper text (as get_full_text does) and the PDF resource URI; " +
    "otherwise the current status (pending, expired, failed, needs_owner). " +
    'Example: wait_for_request({ "request_id": "10.1038/nature12373", "max_wait_seconds": 60 })',
  inputSchema: {
    request_id: z.string().min(1).describe("The request_id from request_paper (the DOI)"),
    max_wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(120)
      .default(60)
      .describe("How long to wait for the request to leave pending, 0 to 120 seconds"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps, args) {
    const doi = await resolveId(deps, args.request_id);
    const seconds = Math.min(120, Math.max(0, args.max_wait_seconds ?? 60));
    const state = await stubFor(deps.env, doi).waitFor(seconds * 1000);
    if (state === null) {
      throw new ToolError("no Sci-Net request for this DOI; call request_paper first", {
        request_id: doi,
      });
    }
    if (state.status !== "ready") return summary(state);

    let text = "";
    if (state.text_key !== undefined) {
      const obj = await deps.env.PDFS.get(state.text_key);
      if (obj !== null) text = await obj.text();
    }
    const page = text.slice(0, PAGE_CHARS);
    const out: Record<string, unknown> = {
      ...summary(state),
      status: "ready",
      source: "sci-net",
      format: "pdf",
      pdf_resource: `doily://pdf/${doi}`,
      text_key: state.text_key ?? null,
      text: page,
      total_chars: text.length,
      offset: 0,
    };
    if (text.length > PAGE_CHARS) out["next_offset"] = PAGE_CHARS;
    if (state.text_key === undefined) {
      out["note"] = "no text was extracted; read the PDF resource or call get_full_text";
    }
    return out;
  },
};

interface ListArgs {
  status?: RequestStatusName | undefined;
}

export const listRequests: ToolDef<ListArgs> = {
  name: "list_requests",
  title: "List Sci-Net requests",
  description:
    "List every Sci-Net request made with request_paper, with state and timestamps, plus " +
    "today's spend against the daily cap. " +
    'Example: list_requests({ "status": "pending" })',
  inputSchema: {
    status: z.enum(STATUSES).optional().describe("Only return requests in this state"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(deps, args) {
    const index = await readIndex(deps.env.DOILY_KV);
    const states = await Promise.all(index.map((doi) => stubFor(deps.env, doi).status()));
    const requests = states
      .filter((s): s is RequestState => s !== null)
      .filter((s) => args.status === undefined || s.status === args.status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(summary);
    return { requests, spend_today: await usage(deps) };
  },
};

export const requestTools = [requestPaper, waitForRequest, listRequests];
