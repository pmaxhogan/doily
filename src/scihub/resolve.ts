import { isChallengePage, isNotFoundPage, isPdf } from "./detect.ts";
import { HTML_ACCEPT, ScihubFetchError, bodyText, scihubFetch } from "./fetch.ts";
import { getHealthyMirrors } from "./mirrors.ts";
import { extractPdfUrl } from "./parse.ts";

import type { ToolDeps } from "../tools/types.ts";
import type { CandidateSource } from "./parse.ts";

/**
 * Resolve a DOI to a PDF through the Sci-Hub mirror list: for each mirror in
 * order, GET the article page, skip it when the mirror answers with a bot
 * wall or a not-found page, otherwise take the PDF links the page declares
 * (see parse.ts) and fetch the first one that is an actual PDF.
 *
 * This module never solves a challenge; a mirror that presents one is simply
 * recorded as `challenge` and the next mirror is tried. Every attempt is
 * returned so the agent can see what happened.
 */

export type ResolveOutcome =
  | "ok"
  | "challenge"
  | "not_found"
  | "no_pdf_markup"
  | "bad_pdf"
  | "over_cap"
  | "status"
  | "timeout"
  | "error";

export interface ResolveAttempt {
  mirror: string;
  outcome: ResolveOutcome;
  status?: number;
  via?: CandidateSource;
  ms: number;
}

export type ScihubResult =
  | {
      ok: true;
      pdf: Uint8Array;
      source: "scihub";
      mirror: string;
      via: CandidateSource;
      attempts: ResolveAttempt[];
    }
  | { ok: false; attempts: ResolveAttempt[] };

export const PAGE_TIMEOUT_MS = 15_000;
export const PDF_TIMEOUT_MS = 60_000;
export const PAGE_CAP_BYTES = 2 * 1024 * 1024;
export const PDF_CAP_BYTES = 50 * 1024 * 1024;

type ResolveDeps = Pick<ToolDeps, "env" | "fetch" | "now">;

export async function resolveScihub(deps: ResolveDeps, doi: string): Promise<ScihubResult> {
  const attempts: ResolveAttempt[] = [];
  const mirrors = await getHealthyMirrors(deps);
  for (const mirror of mirrors) {
    const started = Date.now();
    const record = (outcome: ResolveOutcome, extra: Partial<ResolveAttempt> = {}): void => {
      attempts.push({ mirror, outcome, ...extra, ms: Date.now() - started });
    };
    const origin = `https://${mirror}`;
    let html: string;
    let status: number;
    try {
      const page = await scihubFetch(deps, `${origin}/${doi}`, {
        headers: { Accept: HTML_ACCEPT },
        timeoutMs: PAGE_TIMEOUT_MS,
        maxBytes: PAGE_CAP_BYTES,
        partialOnTimeout: true,
      });
      status = page.status;
      html = bodyText(page.body);
    } catch (err) {
      record(failureKind(err));
      continue;
    }
    if (isChallengePage(html)) {
      record("challenge", { status });
      continue;
    }
    if (status === 404 || isNotFoundPage(html)) {
      record("not_found", { status });
      continue;
    }
    if (status !== 200) {
      record("status", { status });
      continue;
    }
    const candidates = extractPdfUrl(html, origin, { doi });
    if (candidates.length === 0) {
      record("no_pdf_markup", { status });
      continue;
    }
    let last: ResolveOutcome = "bad_pdf";
    let lastVia: CandidateSource | undefined;
    for (const candidate of candidates) {
      lastVia = candidate.via;
      try {
        const res = await scihubFetch(deps, candidate.url, {
          headers: { Accept: "application/pdf,*/*;q=0.8", Referer: `${origin}/${doi}` },
          timeoutMs: PDF_TIMEOUT_MS,
          maxBytes: PDF_CAP_BYTES,
        });
        if (res.overCap) {
          last = "over_cap";
          continue;
        }
        if (res.status !== 200 || !isPdf(res.body)) {
          last = "bad_pdf";
          continue;
        }
        record("ok", { status: res.status, via: candidate.via });
        return { ok: true, pdf: res.body, source: "scihub", mirror, via: candidate.via, attempts };
      } catch (err) {
        last = failureKind(err);
      }
    }
    record(last, { status, ...(lastVia ? { via: lastVia } : {}) });
  }
  return { ok: false, attempts };
}

function failureKind(err: unknown): ResolveOutcome {
  if (err instanceof ScihubFetchError) return err.kind === "timeout" ? "timeout" : "error";
  return "error";
}
