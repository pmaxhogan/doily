import { z } from "zod";

import {
  getOpenAlexAuthor,
  parseOpenAlexAuthor,
  searchOpenAlexAuthors,
  stripOpenAlexUrl,
} from "../providers/openalex.ts";
import { ToolError, type ToolDef } from "./types.ts";

import type { ProviderDeps } from "../providers/types.ts";

/** get_author: an OpenAlex author profile by id, ORCID or name. */

const ORCID_RE = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;

export interface GetAuthorArgs {
  id_or_name: string;
}

export async function getAuthor(deps: ProviderDeps, args: GetAuthorArgs): Promise<unknown> {
  const input = args.id_or_name.trim();
  if (!input) throw new ToolError("id_or_name is empty", { source: "get_author" });

  const openalex = /^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:authors\/)?)?(A\d+)$/i.exec(input);
  const orcid = /^(?:https?:\/\/orcid\.org\/)?(?:orcid:)?\s*\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(
    input,
  )
    ? ORCID_RE.exec(input)?.[1]?.toUpperCase()
    : undefined;

  if (openalex?.[1] || orcid) {
    const author = await getOpenAlexAuthor(deps, { openalex: openalex?.[1]?.toUpperCase(), orcid });
    if (!author) {
      throw new ToolError("OpenAlex has no author with that id", {
        source: "openalex",
        status: 404,
      });
    }
    return { ...parseOpenAlexAuthor(author), source: "openalex" };
  }

  const hits = await searchOpenAlexAuthors(deps, input, 5);
  const [best, ...rest] = hits;
  if (!best)
    throw new ToolError("no author found by that name", { source: "openalex", status: 404 });
  return {
    ...parseOpenAlexAuthor(best),
    source: "openalex",
    match: "name search (top hit by OpenAlex relevance); check other_matches for namesakes",
    other_matches: rest.map((a) => ({
      openalex_id: stripOpenAlexUrl(a.id),
      name: a.display_name,
      works_count: a.works_count,
      cited_by_count: a.cited_by_count,
      institution: a.last_known_institutions?.[0]?.display_name,
    })),
  };
}

export const getAuthorTool: ToolDef<GetAuthorArgs> = {
  name: "get_author",
  title: "Author profile",
  description:
    "OpenAlex author profile: works count, cited-by count, h-index, i10-index, top topics, " +
    "affiliations over time and ORCID. Accepts an OpenAlex author id (A...), an ORCID, or a name " +
    "(name lookups return the top match plus other_matches for disambiguation). " +
    'Example: {"id_or_name": "Mikhail Lukin"}',
  inputSchema: {
    id_or_name: z
      .string()
      .min(1)
      .max(300)
      .describe(
        'OpenAlex author id ("A5086778667"), ORCID ("0000-0002-4189-3154"), or a full name ("Mikhail Lukin")',
      ),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: (deps, args) => getAuthor(deps, args),
};
