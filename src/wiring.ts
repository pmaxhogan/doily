/**
 * The seams between workstreams, joined in one place and imported once by the
 * Worker entry point:
 *
 *  - the Sci-Hub resolver becomes the last hop of the full-text chain
 *    (spec section 4, hop 6), after every open-access source;
 *  - the Sci-Net Durable Object gets a real PDF text extractor, and
 *    `request_paper` gets the "is it obtainable without a bounty" check that
 *    runs the whole chain (OA hops plus Sci-Hub) before any tokens are spent.
 *
 * Nothing here has side effects beyond registering those functions, so the
 * module is safe to import from tests.
 */

import { obtainFullText, type Hop, type HopResult } from "./fulltext/chain.ts";
import { pdfToText } from "./fulltext/pdf.ts";
import { resolveScihub } from "./scihub/resolve.ts";
import { setScinetHooks } from "./scinet/hooks.ts";
import { setChainOptions } from "./tools/fulltext.ts";

/** Hop 6: Sci-Hub, via the mirror list and page parser in src/scihub. */
export const scihubHop: Hop = {
  source: "scihub",
  async run({ deps, doi }): Promise<HopResult> {
    const result = await resolveScihub(deps, doi);
    if (result.ok) return { outcome: "hit", format: "pdf", pdf: result.pdf };
    // One compact line per mirror, so the agent can see why nothing came back.
    const detail = result.attempts.map((a) => `${a.mirror}:${a.outcome}`).join(", ");
    const last = result.attempts.at(-1)?.outcome;
    return { outcome: last === "challenge" ? "challenge" : "miss", detail };
  },
};

/** Every hop after the open-access ones, in order. */
export const extraHops: readonly Hop[] = [scihubHop];

export function wire(): void {
  setChainOptions({ extraHops: [...extraHops] });
  setScinetHooks({
    textOf: async (bytes) => (await pdfToText(bytes)).text,
    isObtainable: async (deps, doi) => {
      const result = await obtainFullText(deps, doi, { extraHops: [...extraHops] });
      return result.status === "ok" ? { source: result.source } : false;
    },
  });
}

wire();
