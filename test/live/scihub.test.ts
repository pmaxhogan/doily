import { describe, expect, it } from "vitest";

import { resolveScihub } from "../../src/scihub/resolve.ts";

import type { ToolDeps } from "../../src/tools/types.ts";

/** Runs only with LIVE=1 (see vitest.config.ts); hits real mirrors. */
describe("scihub live", () => {
  it("resolves a well-known 2013 DOI through some mirror", async () => {
    const deps: Pick<ToolDeps, "env" | "fetch" | "now"> = {
      env: {} as ToolDeps["env"],
      fetch: globalThis.fetch,
      now: () => new Date(),
    };
    const result = await resolveScihub(deps, "10.1038/nature12373");
    console.log(JSON.stringify(result.attempts, null, 2));
    expect(result.ok).toBe(true);
  }, 120_000);
});
