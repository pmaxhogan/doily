import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://doily.test";

describe("/healthz", () => {
  it("answers unauthenticated, with booleans only", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/healthz`);

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body["ok"]).toBe(true);
    for (const [key, value] of Object.entries(body)) {
      expect(typeof value, key).toBe("boolean");
    }
  });

  it("is a 404 for unknown paths, not the consent page", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/nope`);

    expect(response.status).toBe(404);
  });
});
