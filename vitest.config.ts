import { defineConfig } from "vitest/config";

/**
 * Three projects:
 *  - unit: plain Node, every provider parser and pure function, fetch injected.
 *  - integration: workerd via @cloudflare/vitest-plugin, exercises /mcp end to
 *    end with stubbed upstreams (added in wave 1 once wrangler.jsonc has bindings
 *    that miniflare can load).
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
        test: {
          name: "live",
          environment: "node",
          include: process.env["LIVE"] ? ["test/live/**/*.test.ts"] : [],
        },
      },
    ],
  },
});
