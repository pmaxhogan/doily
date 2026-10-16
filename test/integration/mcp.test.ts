// POST /mcp end to end through the real Worker entry point: both auth paths
// and the MCP protocol surface (initialize, tools/list, tools/call, resources).

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { INITIALIZE_PARAMS, fetchWorker, mcpCall, mcpPost } from "./helpers.ts";

const AUTH = { authorization: `Bearer ${env.DOILY_BEARER}` };

describe("POST /mcp auth", () => {
  it("is a 401 with a WWW-Authenticate challenge without credentials", async () => {
    const response = await mcpPost("initialize", INITIALIZE_PARAMS);

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /u);
    // Points the client at the RFC 9728 metadata for this exact resource.
    expect(challenge).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("is a 401 for a wrong static bearer", async () => {
    const response = await mcpPost("initialize", INITIALIZE_PARAMS, {
      authorization: `Bearer ${env.DOILY_BEARER}x`,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /u);
  });

  it("is a 401 for a bearer that only shares a prefix with the real one", async () => {
    const response = await mcpPost("initialize", INITIALIZE_PARAMS, {
      authorization: `Bearer ${env.DOILY_BEARER.slice(0, -1)}`,
    });

    expect(response.status).toBe(401);
  });

  it("does not accept the static bearer under another scheme", async () => {
    const response = await mcpPost("initialize", INITIALIZE_PARAMS, {
      authorization: `Basic ${env.DOILY_BEARER}`,
    });

    expect(response.status).toBe(401);
  });

  it("serves MCP for the right static bearer", async () => {
    const reply = await mcpCall("initialize", INITIALIZE_PARAMS, AUTH);

    expect(reply.error).toBeUndefined();
    expect(reply.result?.["serverInfo"]).toMatchObject({ name: "doily" });
    expect(reply.result?.["capabilities"]).toMatchObject({ tools: {}, resources: {} });
  });
});

describe("MCP surface", () => {
  it("lists ping with a read-only annotation and an example in its description", async () => {
    const reply = await mcpCall("tools/list", {}, AUTH);

    const tools = (reply.result?.["tools"] ?? []) as {
      name: string;
      description?: string;
      annotations?: Record<string, unknown>;
    }[];
    const ping = tools.find((tool) => tool.name === "ping");
    expect(ping).toBeDefined();
    expect(ping?.annotations?.["readOnlyHint"]).toBe(true);
    expect(ping?.description).toContain("Example call:");
  });

  it("calls ping and gets one JSON text block back", async () => {
    const reply = await mcpCall("tools/call", { name: "ping", arguments: {} }, AUTH);

    const result = reply.result as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const body = JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true });
    expect(typeof body["version"]).toBe("string");
  });

  it("advertises the doily://pdf resource template", async () => {
    const reply = await mcpCall("resources/templates/list", {}, AUTH);

    const templates = (reply.result?.["resourceTemplates"] ?? []) as { uriTemplate: string }[];
    expect(templates.map((t) => t.uriTemplate)).toContain("doily://pdf/{+doi}");
  });

  it("reports a resource read for an uncached DOI as not found", async () => {
    const uri = "doily://pdf/10.1234/not-cached";
    const reply = await mcpCall("resources/read", { uri }, AUTH);

    expect(reply.result).toBeUndefined();
    // The SDK sends resource-not-found as -32602 with data { uri }.
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.data).toEqual({ uri });
  });

  it("serves a cached PDF from R2 as a base64 blob", async () => {
    const doi = "10.5555/cached-pdf";
    const bytes = new TextEncoder().encode("%PDF-1.7\n% test fixture\n");
    await env.PDFS.put(`pdf/${doi}.pdf`, bytes);

    const uri = `doily://pdf/${doi}`;
    const reply = await mcpCall("resources/read", { uri }, AUTH);

    const contents = (reply.result?.["contents"] ?? []) as {
      uri: string;
      mimeType: string;
      blob: string;
    }[];
    expect(contents).toHaveLength(1);
    expect(contents[0]?.uri).toBe(uri);
    expect(contents[0]?.mimeType).toBe("application/pdf");
    expect(atob(contents[0]?.blob ?? "")).toBe("%PDF-1.7\n% test fixture\n");
  });

  it("answers GET /mcp with 405: the handler is stateless", async () => {
    const response = await fetchWorker("/mcp", {
      headers: { ...AUTH, accept: "text/event-stream" },
    });

    expect(response.status).toBe(405);
  });
});
