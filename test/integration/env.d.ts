// `cloudflare:test` and `cloudflare:workers` type `env` as `Cloudflare.Env`,
// which wrangler generates from wrangler.jsonc. The bindings vitest.config.ts
// injects (migrations, dummy secrets) have no place in that file, so they are
// merged in here.

/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    DOILY_BEARER: string;
  }
}
