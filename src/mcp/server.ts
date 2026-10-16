/**
 * The MCP server: one fresh `McpServer` per request (the handler is stateless),
 * carrying every tool in `src/tools/index.ts`, the built-in `ping`, and the
 * `doily://pdf/{+doi}` resource template.
 *
 * Tool modules never see the MCP SDK. They return plain values and throw
 * `ToolError`; `wrapHandler` below is the single place that turns either into a
 * `CallToolResult`, so every tool answers in the same shape: one JSON text block,
 * with `isError: true` and a structured `{ error, ... }` body on failure.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import { tools } from "../tools/index.ts";

import { registerPdfResource } from "./resources.ts";

import type { ToolDef, ToolDeps } from "../tools/types.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";

export const SERVER_NAME = "doily";
export const VERSION: string = pkg.version;

/** Shown to clients on initialize; short, because it is prepended to every session. */
const INSTRUCTIONS =
  "doily finds research papers (biomed first) and returns their metadata and full text. " +
  "Every tool answers with one JSON text block; failures carry isError and a JSON body " +
  "{ error, source?, attempts? }.";

function jsonText(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null) }],
    ...(isError && { isError: true }),
  };
}

/**
 * The structured body for a thrown value. A `ToolError` (or anything else with a
 * `toJSON`) speaks for itself; any other error is reduced to its message, never
 * its stack, which can carry file paths and upstream URLs.
 */
export function errorBody(err: unknown): unknown {
  if (typeof err === "object" && err !== null && "toJSON" in err) {
    const toJSON: unknown = err.toJSON;
    if (typeof toJSON === "function") return (toJSON as () => unknown).call(err);
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

/** Wrap a tool handler so its value or its throw becomes a `CallToolResult`. */
export function wrapHandler<Args>(
  def: ToolDef<Args>,
  deps: ToolDeps,
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return jsonText(await def.handler(deps, args));
    } catch (err) {
      return jsonText(errorBody(err), true);
    }
  };
}

/** Always present, so the transport and both auth paths are testable on their own. */
export const ping: ToolDef<Record<string, never>> = {
  name: "ping",
  title: "Ping",
  description:
    "Liveness check: returns { ok: true, version }. Use it to confirm the connection " +
    "and authentication work. Example call: ping({})",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async () => ({ ok: true, version: VERSION }),
};

function registerTool<Args>(server: McpServer, def: ToolDef<Args>, deps: ToolDeps): void {
  const handler = wrapHandler(def, deps);
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: z.object(def.inputSchema),
      ...(def.annotations && { annotations: { title: def.title, ...def.annotations } }),
    },
    // The SDK has already parsed `args` with `inputSchema`, which is the very
    // schema the tool declared for `Args`; the cast restores that link, which
    // the generic `ZodRawShape` in `ToolDef` cannot express.
    (args) => handler(args as Args),
  );
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTool(server, ping, deps);
  for (const def of tools) registerTool(server, def, deps);
  registerPdfResource(server, deps);
  return server;
}
