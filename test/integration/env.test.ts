// Tripwire: the integration runtime must hold the dummy secrets bound by
// vitest.config.ts, never the operator's real `.dev.vars`.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { FIXED_TEST_SECRETS, RANDOM_SECRET_NAMES, RANDOM_SECRET_PATTERN } from "./test-secrets.ts";

/** Every optional string in src/env.ts. A new secret there needs a line here. */
const ENV_STRING_NAMES = [
  "DEV_MODE",
  "DOILY_BEARER",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "CF_ACCESS_ALLOWED_EMAIL",
  "CONTACT_EMAIL",
  "NCBI_API_KEY",
  "OPENALEX_API_KEY",
  "S2_API_KEY",
  "CORE_API_KEY",
  "SCIHUB_MIRRORS",
  "SCIHUB_MIRROR_LIST_URL",
  "SCIHUB_PROXY_URL",
  "SCIHUB_PROXY_TOKEN",
  "SCINET_USER",
  "SCINET_PASS",
  "SCINET_BOUNTY",
  "SCINET_DAILY_CAP",
  "REQUEST_TOKEN_SECRET",
];

const bound = env as unknown as Record<string, unknown>;

describe("the integration environment", () => {
  it("has a dummy for every secret in src/env.ts", () => {
    const covered = [...Object.keys(FIXED_TEST_SECRETS), ...RANDOM_SECRET_NAMES].sort();
    expect(covered).toEqual([...ENV_STRING_NAMES].sort());
  });

  it("binds the fixed dummies, overriding wrangler.jsonc and .dev.vars", () => {
    for (const [name, value] of Object.entries(FIXED_TEST_SECRETS)) {
      expect(bound[name], name).toBe(value);
    }
  });

  it("binds per-run random values for key material", () => {
    for (const name of RANDOM_SECRET_NAMES) {
      expect(bound[name], name).toMatch(RANDOM_SECRET_PATTERN);
    }
  });

  it("runs with DEV_MODE off, like production", () => {
    expect(bound["DEV_MODE"]).toBe("false");
  });
});
