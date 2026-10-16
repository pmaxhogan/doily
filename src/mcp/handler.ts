/**
 * Streamable HTTP at POST /mcp, stateless: `createMcpHandler` from
 * `agents/mcp/server` builds a fresh server for every request, so GET and
 * DELETE (2025 session operations) answer 405 and nothing is kept between
 * calls.
 *
 * The handler is constructed per request, not once at module scope, because
 * the server factory is only handed `{ era, authInfo, requestInfo }` and the
 * tools need `env`. Construction is cheap (no I/O). The Worker's real
 * `ExecutionContext` is passed through: that is how the library reads the
 * OAuth provider's verified token context off `ctx` on the OAuth path.
 */

import { createMcpHandler } from "agents/mcp/server";

import { createServer } from "./server.ts";

import type { Env } from "../env.ts";
import type { ToolDeps } from "../tools/types.ts";

export const MCP_ROUTE = "/mcp";

export function toolDeps(request: Request, env: Env): ToolDeps {
  return {
    env,
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => new Date(),
    origin: new URL(request.url).origin,
  };
}

export function serveMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const deps = toolDeps(request, env);
  const handler = createMcpHandler(() => createServer(deps), {
    route: MCP_ROUTE,
    // Clients are CLIs and claude.ai's backend, neither of which sends a
    // browser Origin; no browser page is meant to call this endpoint.
    corsOptions: false,
  });
  return handler(request, env, ctx);
}

/** The `{ fetch }` shape `OAuthProvider` wants for its `apiHandler`. */
export const mcpApiHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    serveMcp(request, env, ctx),
};
