import { z } from "zod";

import { DOWNLOAD_TTL_SECONDS, presignPdfUrl } from "../fulltext/cache.ts";
import {
  obtainFullText,
  obtainPdf,
  type Attempt,
  type ChainOptions,
  type NoPdf,
} from "../fulltext/chain.ts";
import { DEFAULT_PAGE_CHARS, pageText } from "../fulltext/page.ts";
import { makeRequestToken } from "../scinet/token.ts";

import type { ToolDef, ToolDeps } from "./types.ts";

/**
 * get_full_text and get_pdf: thin wrappers over the open-access chain in
 * src/fulltext/chain.ts. Total failure is a normal result (not isError) so the
 * agent sees every attempt.
 *
 * `chainOptions` is the seam for hops appended after the OA chain; the
 * orchestrator sets it once at module load (see setChainOptions).
 */

let chainOptions: ChainOptions = {};

/** Options every get_full_text/get_pdf call passes to the chain (extraHops). */
export function setChainOptions(opts: ChainOptions): void {
  chainOptions = { ...opts };
}

export interface UnavailableBody {
  status: "unavailable";
  doi: string;
  attempts: Attempt[];
  [extra: string]: unknown;
}

/**
 * The body get_full_text returns when no hop produced text. One place to
 * extend: async and given `deps` so it can mint a request token later.
 */
export async function unavailableBody(
  deps: ToolDeps,
  doi: string,
  attempts: Attempt[],
): Promise<UnavailableBody> {
  const body: UnavailableBody = { status: "unavailable", doi, attempts };
  // Spec 3.5: hand out a stateless token the agent can pass to request_paper
  // if it decides the paper is worth a Sci-Net bounty. Nothing is posted here.
  if (deps.env.REQUEST_TOKEN_SECRET) {
    body["request_token"] = await makeRequestToken(deps.env.REQUEST_TOKEN_SECRET, doi);
    body["next_step"] =
      "If this paper is worth a Sci-Net bounty (2 tokens), call request_paper with the request_token, then wait_for_request.";
  }
  return body;
}

export interface GetFullTextArgs {
  id: string;
  offset?: number;
  include_references?: boolean;
}

export async function getFullText(deps: ToolDeps, args: GetFullTextArgs): Promise<unknown> {
  const result = await obtainFullText(deps, args.id, {
    ...chainOptions,
    includeReferences: args.include_references === true,
  });
  if (result.status !== "ok") return unavailableBody(deps, result.doi, result.attempts);
  const page = pageText(result.text, args.offset ?? 0, DEFAULT_PAGE_CHARS);
  return {
    status: "ok",
    doi: result.doi,
    source: result.source,
    format: result.format,
    text: page.text,
    total_chars: page.total_chars,
    offset: page.offset,
    ...(page.next_offset !== undefined && { next_offset: page.next_offset }),
    ...(result.references_unavailable && { references_unavailable: true }),
    ...(result.cached && { cached: true }),
    attempts: result.attempts,
  };
}

export const getFullTextTool: ToolDef<GetFullTextArgs> = {
  name: "get_full_text",
  title: "Full text",
  description:
    "Full text of a paper as markdown, from legal open-access sources tried in order: PMC/Europe " +
    "PMC JATS, Unpaywall, OpenAlex, Semantic Scholar, bioRxiv/medRxiv, CORE. Returns { status, " +
    "doi, source, format (jats|pdf), text, total_chars, offset, next_offset?, attempts }; text is " +
    "capped at 60000 chars per call, so pass next_offset back as offset for the next page. " +
    "References are stripped unless include_references (only possible for JATS sources). When " +
    'nothing works the result is { status: "unavailable", doi, attempts } (not an error). ' +
    'Example: {"id": "10.1038/nature12373"}',
  inputSchema: {
    id: z
      .string()
      .min(1)
      .max(500)
      .describe("DOI, PMID, PMCID, arXiv id, a URL containing one, or an exact title"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Character offset to start from; use next_offset from the previous call"),
    include_references: z
      .boolean()
      .optional()
      .describe("Keep the reference list (JATS sources only); default false"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: (deps, args) => getFullText(deps, args),
};

export interface GetPdfArgs {
  id: string;
}

export async function getPdf(deps: ToolDeps, args: GetPdfArgs): Promise<unknown> {
  const result = await obtainPdf(deps, args.id, chainOptions);
  if (result.status !== "ok") return result satisfies NoPdf;
  const base = {
    status: "ok" as const,
    doi: result.doi,
    source: result.source,
    resource_uri: `doily://pdf/${result.doi}`,
    size_bytes: result.size_bytes,
  };
  let url: string;
  try {
    url = await presignPdfUrl(deps, result.doi, DOWNLOAD_TTL_SECONDS);
  } catch {
    // No signing key configured: the resource still works over MCP.
    return { ...base, url_unavailable: "REQUEST_TOKEN_SECRET is not set; read resource_uri" };
  }
  const exp = Number(new URL(url).searchParams.get("exp"));
  return {
    status: base.status,
    doi: base.doi,
    source: base.source,
    url,
    expires_at: new Date(exp * 1000).toISOString(),
    resource_uri: base.resource_uri,
    size_bytes: base.size_bytes,
    ...(result.cached && { cached: true }),
    attempts: result.attempts,
  };
}

export const getPdfTool: ToolDef<GetPdfArgs> = {
  name: "get_pdf",
  title: "PDF download",
  description:
    "Finds an open-access PDF of a paper (same sources as get_full_text) and caches it. Returns " +
    "{ status, doi, source, url (signed download link, valid about 1 hour), expires_at, " +
    "resource_uri (doily://pdf/<doi>, readable over MCP), size_bytes }. PDFs over 50 MB are " +
    'refused. When no PDF is found: { status: "no_pdf", doi, text_available, attempts }; if ' +
    "text_available is true, get_full_text will work. " +
    'Example: {"id": "PMC3123456"}',
  inputSchema: {
    id: z
      .string()
      .min(1)
      .max(500)
      .describe("DOI, PMID, PMCID, arXiv id, a URL containing one, or an exact title"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: (deps, args) => getPdf(deps, args),
};

export const fullTextTools = [getFullTextTool, getPdfTool];
