// GET/POST /authorize: the OAuth consent page.
//
// Gate: Cloudflare Access, verified in code (src/auth/access.ts) on both
// methods. Access also guards the path at the edge; checking the JWT here means
// a dashboard slip cannot turn the consent page into an open grant machine.
//
// CSRF on the POST is two independent layers:
//   1. A synchronizer token from the OAuth library: `beginConsent` stores the
//      parsed request in KV under a 256-bit single-use handle, bound to this
//      browser by a `__Host-` cookie; `approveConsent`/`denyConsent` only accept
//      the handle together with that cookie, once, within ten minutes.
//   2. A same-origin proof: `Origin` equal to this origin, or
//      `Sec-Fetch-Site: same-origin`. Browsers set both and script cannot.
//
// The posted form carries only the handle and the decision: the redirect URI,
// state, PKCE challenge and client all come back out of KV, never the form.

import { AuthorizationError } from "@cloudflare/workers-oauth-provider";

import { verifyAccess } from "../auth/access.ts";
import { MCP_SCOPE, OWNER_USER_ID } from "../auth/oauth-config.ts";

import { hasSameOriginProof } from "./csrf.ts";
import { consentPage, errorPage, handOffPage, randomNonce, securityHeaders } from "./page.ts";

import type { Env } from "../env.ts";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** `Env` as the OAuth provider hands it to the default handler. */
export type OAuthEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };

function html(status: number, body: (nonce: string) => string, extra?: Headers): Response {
  const nonce = randomNonce();
  const headers = new Headers(securityHeaders(nonce));
  // Cookies and the like from the OAuth library. Its own CSP and framing
  // headers are skipped: ours are a strict superset (frame-ancestors 'none').
  if (extra) {
    for (const [name, value] of extra) {
      const lower = name.toLowerCase();
      if (lower === "set-cookie") headers.append(name, value);
      else if (lower === "cache-control") headers.set(name, value);
    }
  }
  return new Response(body(nonce), { status, headers });
}

function failure(status: number, title: string, message: string): Response {
  return html(status, (nonce) => errorPage(nonce, title, message));
}

function forbidden(): Response {
  return failure(403, "Forbidden", "Sign in through Cloudflare Access to approve connections.");
}

async function showConsent(request: Request, helpers: OAuthHelpers): Promise<Response> {
  let authRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch (err) {
    // A validated redirect URI means the client can be told; otherwise the
    // error stays on this page (never redirect to an unvalidated URI).
    if (err instanceof AuthorizationError && err.redirectTo) {
      return Response.redirect(err.redirectTo, 302);
    }
    const message = err instanceof Error ? err.message : "Invalid authorization request.";
    return failure(400, "Invalid request", message);
  }
  const described = await helpers.describeConsent(authRequest);
  const { handle, headers } = await helpers.beginConsent(authRequest);
  return html(
    200,
    (nonce) =>
      consentPage(nonce, {
        clientName: described.clientName,
        clientDomain: described.clientDomain,
        redirectUri: described.redirectUri,
        redirectHost: described.redirectHost,
        redirectIsLoopback: described.redirectIsLoopback,
        scopes: [MCP_SCOPE],
        handle,
      }),
    headers,
  );
}

async function decide(request: Request, helpers: OAuthHelpers): Promise<Response> {
  if (!hasSameOriginProof(request)) {
    return failure(403, "Forbidden", "Cross-site form submission refused.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failure(400, "Invalid request", "Expected a form submission.");
  }
  const handle = form.get("handle");
  const decision = form.get("decision");
  if (typeof handle !== "string" || handle === "") {
    return failure(400, "Invalid request", "Missing consent handle.");
  }

  try {
    if (decision === "deny") {
      const denied = await helpers.denyConsent(request, handle);
      return html(200, (nonce) => handOffPage(nonce, denied.redirectTo), denied.headers);
    }
    if (decision !== "approve") {
      return failure(400, "Invalid request", "Unknown decision.");
    }
    // The one scope this server has, whatever (if anything) the client asked for.
    const approved = await helpers.approveConsent(request, handle, { scope: [MCP_SCOPE] });
    const { redirectTo } = await helpers.completeAuthorization({
      request: approved.request,
      userId: OWNER_USER_ID,
      scope: approved.request.scope,
      metadata: { approvedAt: new Date().toISOString() },
      props: { userId: OWNER_USER_ID },
    });
    return html(200, (nonce) => handOffPage(nonce, redirectTo), approved.headers);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return failure(400, "Consent expired", "This consent form expired or was already used.");
    }
    throw err;
  }
}

export async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (!(await verifyAccess(request, env))) return forbidden();

  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) {
    // Only reachable when the default handler is called without the provider
    // in front of it, which is a wiring bug.
    return failure(500, "Misconfigured", "OAuth provider not available.");
  }
  return request.method === "GET" ? showConsent(request, helpers) : decide(request, helpers);
}
