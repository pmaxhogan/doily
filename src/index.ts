/**
 * The Worker's entry point: the OAuth provider wrapping everything else, with
 * the static bearer checked first. Same layering as pmaxhogan/healthy.
 *
 * Request topology, top to bottom:
 *
 *   /mcp* with `Authorization: Bearer <DOILY_BEARER>`   MCP handler, directly
 *   /.well-known/oauth-authorization-server             the provider, itself
 *   /.well-known/oauth-protected-resource*              the provider, itself
 *   POST /oauth/token                                   the provider (exact path)
 *   POST /oauth/register                                the provider (exact path)
 *   /mcp*                                               provider-validated token,
 *                                                       then the MCP handler;
 *                                                       anything else is a 401
 *                                                       with WWW-Authenticate
 *   everything else                                     `defaultHandler` below:
 *                                                       /healthz, /authorize,
 *                                                       /download/<doi> (its own
 *                                                       HMAC-signed query string)
 *
 * The static bearer is tried before the provider so a wrong or missing one is
 * not an error of its own: it falls through, and the provider either accepts
 * the request as one of its OAuth tokens or answers the 401 challenge that
 * tells a client where to start OAuth.
 *
 * Cloudflare Access guards /authorize at the edge (and the consent handler
 * re-verifies the Access JWT). `/mcp`, `/oauth/*` and `/.well-known/*` bypass
 * Access; they carry their own auth. That is configuration, not code.
 *
 * The export is a hand-written object because `OAuthProvider` exposes only
 * `fetch`, and the Worker also needs `scheduled`.
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { hasStaticBearer } from "./auth/bearer.ts";
import { AUTHORIZE_PATH, MCP_API_ROUTE, oauthCoreFor, resourceFor } from "./auth/oauth-config.ts";
import { handleAuthorize } from "./consent/authorize.ts";
import { serveDownload } from "./fulltext/download.ts";
import { healthz } from "./healthz.ts";
import { mcpApiHandler, serveMcp } from "./mcp/handler.ts";

import type { OAuthEnv } from "./consent/authorize.ts";
import type { Env } from "./env.ts";

// Re-exported because wrangler resolves Durable Object classes from `main`.
export { SciNetRequest } from "./scinet/request-object.ts";

/** Everything that is not the provider's or the MCP endpoint's. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json(await healthz(env), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === AUTHORIZE_PATH) {
      return handleAuthorize(request, env as OAuthEnv);
    }
    if (url.pathname.startsWith("/download/")) {
      return serveDownload(request, env);
    }
    return new Response("not found", { status: 404 });
  },
};

/**
 * Built per request: the resource every token is bound to is derived from the
 * request's own origin (see src/auth/oauth-config.ts). Construction is
 * synchronous config validation, not I/O.
 */
function oauthProviderFor(request: Request): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    ...oauthCoreFor(resourceFor(request)),
    apiRoute: MCP_API_ROUTE,
    apiHandler: mcpApiHandler,
    defaultHandler,
  });
}

/**
 * A per-request view of `env` for the provider to write into.
 *
 * The provider injects its helpers as `env.OAUTH_PROVIDER` only when that is
 * unset, and workerd hands every request in an isolate the same `env` object.
 * So the first request's helpers, bound to the first request's resource,
 * would stick for the isolate's lifetime, and a consent approved on another
 * origin (`localhost` vs `127.0.0.1` under `wrangler dev`) would mint a grant
 * the token endpoint then rejects as "not bound to a configured resource".
 * A prototype-linked object keeps every binding readable and takes the write
 * as its own property, leaving the shared `env` untouched.
 */
function perRequestEnv(env: Env): Env {
  return Object.create(env) as Env;
}

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_API_ROUTE || pathname.startsWith(`${MCP_API_ROUTE}/`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (isMcpPath(pathname) && (await hasStaticBearer(request, env.DOILY_BEARER))) {
      return serveMcp(request, env, ctx);
    }
    return oauthProviderFor(request).fetch(request, perRequestEnv(env), ctx);
  },

  scheduled(controller: ScheduledController): void {
    // Yearly reminder only; the snapshots under data/ are refreshed by hand.
    console.log(`cron ${controller.cron}: refresh data/sjr.json and data/predatory.json`);
  },
} satisfies ExportedHandler<Env>;
