// Brings the real D1 schema up before any integration test runs, from the same
// migrations/ directory `npm run migrate:remote` applies in production.

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
