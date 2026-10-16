/**
 * Worker entry point. Wave 1 replaces this with the OAuth provider wrapping the
 * MCP handler (see .claude/doily-spec.md section 2); the scaffold only serves
 * /healthz so the first deploy and CI run have something real to check.
 */

import { healthz } from "./healthz.ts";

import type { Env } from "./env.ts";

export { SciNetRequest } from "./scinet/request-object.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json(await healthz(env));
    }
    return new Response("not found", { status: 404 });
  },

  scheduled(controller: ScheduledController): void {
    // Yearly reminder only; the snapshots under data/ are refreshed by hand.
    console.log(`cron ${controller.cron}: refresh data/sjr.json and data/predatory.json`);
  },
} satisfies ExportedHandler<Env>;
