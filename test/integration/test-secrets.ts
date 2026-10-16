// Dummy values for every secret and var in src/env.ts, shared by
// vitest.config.ts (which binds them) and env.test.ts (which asserts they are
// in force). Pure data: this module is imported both in Node and in workerd.

/** Fixed dummies: obviously fake, so nothing can mistake one for a real value. */
export const FIXED_TEST_SECRETS: Record<string, string> = {
  DEV_MODE: "false",
  CF_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.test",
  CF_ACCESS_AUD: "test-access-aud",
  CF_ACCESS_ALLOWED_EMAIL: "owner@example.test",
  CONTACT_EMAIL: "contact@example.test",
  NCBI_API_KEY: "test-ncbi-key",
  OPENALEX_API_KEY: "test-openalex-key",
  S2_API_KEY: "test-s2-key",
  CORE_API_KEY: "test-core-key",
  SCIHUB_MIRRORS: "scihub-a.example.test,scihub-b.example.test",
  SCIHUB_MIRROR_LIST_URL: "https://mirrors.example.test/",
  SCIHUB_PROXY_URL: "",
  SCIHUB_PROXY_TOKEN: "",
  SCINET_USER: "test-scinet-user",
  SCINET_PASS: "test-scinet-pass",
  SCINET_BOUNTY: "2",
  SCINET_DAILY_CAP: "5",
};

/**
 * Secrets that look like key material get a random value per run, generated in
 * vitest.config.ts: a committed key reads as a leaked one to every scanner.
 * Each is `test-` plus 64 hex characters.
 */
export const RANDOM_SECRET_NAMES = ["DOILY_BEARER", "REQUEST_TOKEN_SECRET"] as const;

export const RANDOM_SECRET_PATTERN = /^test-[0-9a-f]{64}$/u;
