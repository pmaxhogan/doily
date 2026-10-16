import { describe, expect, it } from "vitest";

import { scinetHooks } from "../../src/scinet/hooks.ts";
import { extraHops, scihubHop } from "../../src/wiring.ts";

/**
 * The review of the first merge found that nothing wired the Sci-Net hooks,
 * so request_paper would have spent bounties on freely available papers. This
 * pins the wiring: importing src/wiring.ts (which src/index.ts does) must
 * replace both default hooks and register Sci-Hub as the last chain hop.
 */
describe("wiring", () => {
  it("registers Sci-Hub as the extra chain hop", () => {
    expect(extraHops.map((h) => h.source)).toEqual(["scihub"]);
    expect(scihubHop.source).toBe("scihub");
  });

  it("replaces the default Sci-Net hooks", async () => {
    // The default isObtainable always returns false and the default textOf
    // returns ""; the wired versions run the chain and unpdf respectively.
    expect(scinetHooks.isObtainable.name).not.toBe("");
    const text = await scinetHooks
      .textOf(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
      .catch((e: unknown) => (e instanceof Error ? `threw:${e.name}` : "threw"));
    // A 4-byte "PDF" is not parseable: the wired extractor rejects it instead
    // of silently returning "" like the default does.
    expect(text).not.toBe("");
  });
});
