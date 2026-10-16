// Raw-wire helpers for the integration suite: plain fetch against the Worker's
// default export, no MCP client library, so the tests assert on what a client
// actually receives.

import { exports } from "cloudflare:workers";
import { expect } from "vitest";

/** Not localhost, so neither the dev Access bypass nor localhost host checks engage. */
export const ORIGIN = "https://doily.test";

/** A 2025-era revision: the stateless legacy lane Claude Code uses today. */
export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

let nextId = 1;

/** POST one JSON-RPC request to /mcp with the given headers. */
export function mcpPost(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchWorker("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

/** The JSON-RPC message out of a JSON body or the first `data:` line of an SSE body. */
export async function rpcBody(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text();
  expect(response.status, text.slice(0, 400)).toBe(200);
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    expect(line, `no data line in SSE body: ${text.slice(0, 400)}`).toBeDefined();
    return JSON.parse((line ?? "").slice("data:".length)) as JsonRpcResponse;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

/** Call an MCP method and return its JSON-RPC response. */
export async function mcpCall(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<JsonRpcResponse> {
  return rpcBody(await mcpPost(method, params, headers));
}

export const INITIALIZE_PARAMS = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "doily-integration-test", version: "0.0.0" },
};
