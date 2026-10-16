import { describe, expect, it } from "vitest";

import { healthz } from "../../src/healthz.ts";

describe("healthz", () => {
  it("reports configured features as booleans only", () => {
    const health = healthz({ SCINET_USER: "u", SCINET_PASS: "p", DOILY_BEARER: "b" });
    expect(health).toEqual({
      ok: true,
      scihub_configured: true,
      scinet_configured: true,
      bearer_configured: true,
    });
    for (const value of Object.values(health)) {
      expect(typeof value).toBe("boolean");
    }
  });

  it("reports missing secrets as false", () => {
    expect(healthz({})).toMatchObject({ scinet_configured: false, bearer_configured: false });
  });
});
