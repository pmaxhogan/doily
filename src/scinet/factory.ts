import { ToolError } from "../tools/types.ts";
import { SciNetClient, kvSessionStore } from "./client.ts";

import type { Env } from "../env.ts";

/** A SciNetClient for the configured account, with the session kept in KV. */
export function clientFromEnv(
  env: Pick<Env, "SCINET_USER" | "SCINET_PASS" | "DOILY_KV">,
  fetch: typeof globalThis.fetch,
): SciNetClient {
  const user = env.SCINET_USER;
  const pass = env.SCINET_PASS;
  if (user === undefined || user === "" || pass === undefined || pass === "") {
    throw new ToolError("Sci-Net is not configured (SCINET_USER / SCINET_PASS unset)", {
      source: "scinet",
    });
  }
  return new SciNetClient({ fetch, user, pass, session: kvSessionStore(env.DOILY_KV) });
}
