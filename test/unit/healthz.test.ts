import { describe, expect, it } from "vitest";

import { healthz } from "../../src/healthz.ts";

function kvWith(keys: string[]): KVNamespace {
  return {
    get: async (key: string) => (keys.includes(key) ? "x" : null),
  } as unknown as KVNamespace;
}

describe("healthz", () => {
  it("reports configured features and cached state as booleans only", async () => {
    const health = await healthz({
      SCINET_USER: "u",
      SCINET_PASS: "p",
      DOILY_BEARER: "b",
      DOILY_KV: kvWith(["scinet:session", "scihub:mirrors"]),
    });
    expect(health).toEqual({
      ok: true,
      bearer_configured: true,
      scinet_configured: true,
      scinet_session_cached: true,
      scihub_mirror_cached: true,
    });
    for (const value of Object.values(health)) {
      expect(typeof value).toBe("boolean");
    }
  });

  it("reports missing secrets and an empty cache as false", async () => {
    expect(await healthz({})).toMatchObject({
      scinet_configured: false,
      bearer_configured: false,
      scinet_session_cached: false,
      scihub_mirror_cached: false,
    });
  });

  it("never fails when KV throws", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    expect(await healthz({ DOILY_KV: kv })).toMatchObject({
      ok: true,
      scihub_mirror_cached: false,
    });
  });
});
