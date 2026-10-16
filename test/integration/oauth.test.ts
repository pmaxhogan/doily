// The OAuth side: discovery documents, the Access gate on /authorize, the
// consent page's CSRF layers, and the whole dance (register, consent, token,
// MCP call) for real.
//
// The gated tests call the Worker's default export directly with DEV_MODE on
// and a localhost origin, which is the only combination that relaxes the Access
// check (there is no Access in front of the test runtime). Everything else goes
// through the same entry point with the production posture (DEV_MODE off).

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../../src/index.ts";

import { INITIALIZE_PARAMS, PROTOCOL_VERSION, fetchWorker, rpcBody } from "./helpers.ts";

import type { Env } from "../../src/env.ts";

const DEV_ORIGIN = "http://localhost:8787";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const DEV_ENV = { ...env, DEV_MODE: "true" } as unknown as Env;

async function dev(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(DEV_ORIGIN + path, init);
  // A constructed Request has no Host header, and the MCP handler's DNS
  // rebinding check on localhost endpoints requires one, as a real request has.
  request.headers.set("host", new URL(DEV_ORIGIN).host);
  const response = await worker.fetch(request, DEV_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Register a client the way claude.ai does: public, one fixed redirect. */
async function register(clientName: string): Promise<string> {
  const response = await dev("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await response.json<{ client_id?: string }>();
  expect(response.status, JSON.stringify(body)).toBeLessThan(300);
  return body.client_id ?? "";
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

interface ConsentForm {
  clientId: string;
  handle: string;
  cookie: string;
  html: string;
  response: Response;
}

async function openConsent(clientName: string, challenge: string): Promise<ConsentForm> {
  const clientId = await register(clientName);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "papers",
    state: "client-state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const response = await dev(`/authorize?${query.toString()}`);
  const html = await response.text();
  expect(response.status, html.slice(0, 400)).toBe(200);
  const handle = /name="handle" value="([^"]+)"/u.exec(html)?.[1] ?? "";
  expect(handle).not.toBe("");
  // The binding cookie, as a browser would send it back.
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  expect(cookie).toMatch(/^__Host-/u);
  return { clientId, handle: unescapeHtml(handle), cookie, html, response };
}

function submit(form: ConsentForm, decision: string, headers: Record<string, string> = {}) {
  return dev("/authorize", {
    method: "POST",
    headers: {
      origin: DEV_ORIGIN,
      cookie: form.cookie,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams({ handle: form.handle, decision }).toString(),
  });
}

function handOffTarget(html: string): URL {
  const meta = /<meta http-equiv="refresh" content="0;url=([^"]+)">/u.exec(html);
  expect(meta, `no hand-off in: ${html.slice(0, 400)}`).not.toBeNull();
  return new URL(unescapeHtml(meta?.[1] ?? ""));
}

describe("OAuth discovery", () => {
  it("serves the authorization server metadata", async () => {
    const response = await fetchWorker("/.well-known/oauth-authorization-server");

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body["authorization_endpoint"]).toBe("https://doily.test/authorize");
    expect(body["token_endpoint"]).toBe("https://doily.test/oauth/token");
    expect(body["registration_endpoint"]).toBe("https://doily.test/oauth/register");
    expect(body["scopes_supported"]).toEqual(["papers"]);
    expect(body["code_challenge_methods_supported"]).toEqual(["S256"]);
  });

  it("serves the protected resource metadata for /mcp", async () => {
    const response = await fetchWorker("/.well-known/oauth-protected-resource/mcp");

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body["resource"]).toBe("https://doily.test/mcp");
  });
});

describe("/authorize without Cloudflare Access", () => {
  it("refuses the consent page", async () => {
    const response = await fetchWorker("/authorize?response_type=code&client_id=x");

    expect(response.status).toBe(403);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("refuses the consent POST", async () => {
    const response = await fetchWorker("/authorize", {
      method: "POST",
      headers: {
        origin: "https://doily.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "handle=x&decision=approve",
    });

    expect(response.status).toBe(403);
  });

  it("is not opened by DEV_MODE on a non-local hostname", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://doily.test/authorize?response_type=code&client_id=x"),
      DEV_ENV,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });
});

describe("the consent page", () => {
  it("shows the client, the redirect host and the scope, with strict headers", async () => {
    const { challenge } = await pkce();
    const form = await openConsent("Test <Connector>", challenge);

    // Escaped, never raw: the client name is attacker-controlled.
    expect(form.html).toContain("Test &lt;Connector&gt;");
    expect(form.html).not.toContain("<Connector>");
    expect(form.html).toContain("claude.ai");
    expect(form.html).toContain("papers");
    expect(form.html).not.toContain("<script");
    const csp = form.response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(form.response.headers.get("x-frame-options")).toBe("DENY");
    expect(form.response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a POST without a same-origin proof", async () => {
    const { challenge } = await pkce();
    const form = await openConsent("CSRF Probe", challenge);

    const response = await submit(form, "approve", { origin: "https://evil.example" });

    expect(response.status).toBe(403);
  });

  it("refuses a handle without its binding cookie", async () => {
    const { challenge } = await pkce();
    const form = await openConsent("Cookie Probe", challenge);

    const response = await submit({ ...form, cookie: "" }, "approve");

    expect(response.status).toBe(400);
  });

  it("refuses a handle the second time", async () => {
    const { challenge } = await pkce();
    const form = await openConsent("Replay Probe", challenge);

    expect((await submit(form, "approve")).status).toBe(200);
    expect((await submit(form, "approve")).status).toBe(400);
  });

  it("sends a denial back to the client as access_denied", async () => {
    const { challenge } = await pkce();
    const form = await openConsent("Deny Probe", challenge);

    const response = await submit(form, "deny");
    const target = handOffTarget(await response.text());

    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("client-state-123");
  });
});

describe("the full OAuth flow", () => {
  it("registers, consents, exchanges the code, and calls ping with the token", async () => {
    // Regression: serve another origin from the same env object first. The
    // provider caches its helpers on `env`, and before src/index.ts gave it a
    // per-request view, that origin's resource was baked into the grant below
    // and the token endpoint refused it.
    const ctx = createExecutionContext();
    await worker.fetch(new Request("https://doily.test/healthz"), DEV_ENV, ctx);
    await waitOnExecutionContext(ctx);

    const { verifier, challenge } = await pkce();
    const form = await openConsent("Flow Connector", challenge);

    const decided = await submit(form, "approve");
    expect(decided.status).toBe(200);
    // No 302: the consent page's form-action 'self' would block it in Chrome.
    expect(decided.headers.get("location")).toBeNull();
    const target = handOffTarget(await decided.text());
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("state")).toBe("client-state-123");
    const code = target.searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    const tokenResponse = await dev("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: form.clientId,
      }).toString(),
    });
    const tokens = await tokenResponse.json<{ access_token?: string; scope?: string }>();
    expect(tokenResponse.status, JSON.stringify(tokens)).toBe(200);
    expect(tokens.scope).toBe("papers");
    const accessToken = tokens.access_token ?? "";
    expect(accessToken).not.toBe("");

    const mcpHeaders = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    const init = await dev("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: INITIALIZE_PARAMS,
      }),
    });
    expect((await rpcBody(init)).result?.["serverInfo"]).toMatchObject({ name: "doily" });

    const call = await dev("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      }),
    });
    const result = (await rpcBody(call)).result as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({ ok: true });
  });
});
