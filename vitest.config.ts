import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { FIXED_TEST_SECRETS, RANDOM_SECRET_NAMES } from "./test/integration/test-secrets.ts";

// Read once here, in Node, and handed to the integration runtime as a binding:
// workerd has no filesystem to read migrations from. test/integration/setup.ts
// applies them, so a migration that breaks also breaks the suite.
const migrations = await readD1Migrations(fileURLToPath(new URL("migrations", import.meta.url)));

/**
 * A dummy for every secret and var in `src/env.ts`, bound into the integration
 * runtime last so it wins over wrangler.jsonc and, crucially, over a real
 * `.dev.vars`: the pool loads config the way `wrangler dev` does, so without
 * this a test that spreads `env` would hold the owner's real credentials.
 * A name added to `Env` without a line in test/integration/test-secrets.ts is
 * a gap; test/integration/env.test.ts is the tripwire.
 */
const TEST_SECRETS: Record<string, string> = {
  ...FIXED_TEST_SECRETS,
  ...Object.fromEntries(
    RANDOM_SECRET_NAMES.map((name) => [name, `test-${randomBytes(32).toString("hex")}`]),
  ),
};

/**
 * Three projects:
 *  - unit: plain Node, every parser and pure function, fetch injected.
 *  - integration: workerd via @cloudflare/vitest-plugin, driven from
 *    wrangler.jsonc so the tests and the deployment cannot drift; exercises
 *    POST /mcp end to end, the auth paths, /healthz and the resource read.
 *  - live: opt-in (LIVE=1), hits real upstream APIs, never runs in CI.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Never open a remote proxy session: the AI binding is remote-only,
            // CI has no Cloudflare credentials, and a test must not incur
            // Workers AI charges. Code that needs AI stubs it.
            remoteBindings: false,
            miniflare: {
              bindings: { TEST_MIGRATIONS: migrations, ...TEST_SECRETS },
            },
          }),
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["./test/integration/setup.ts"],
          // With console interception on, a line logged from inside a Durable
          // Object alarm after the last test can leave the file waiting for
          // ever (seen in pmaxhogan/healthy); SciNetRequest will run alarms.
          disableConsoleIntercept: true,
        },
      },
      {
        test: {
          name: "live",
          environment: "node",
          include: process.env["LIVE"] ? ["test/live/**/*.test.ts"] : [],
        },
      },
    ],
  },
});
