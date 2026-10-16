import type { Env } from "../env.ts";
import type { ZodRawShape } from "zod";

/**
 * What every tool handler receives. `fetch` is injected so unit tests never
 * touch the network, and `now` so time-based logic (rate buckets, daily spend
 * caps, request expiry) is deterministic under test.
 */
export interface ToolDeps {
  env: Env;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  /** Base URL of the request being served, for signed download links. */
  origin: string;
}

/**
 * The contract between a tool module and the MCP server registration in
 * `src/mcp/server.ts`. Tool modules export one of these per tool; the server
 * wraps `handler` so that a returned value becomes a single JSON text content
 * block and a thrown `ToolError` becomes an `isError` result with the
 * structured body. Keep handlers pure over `deps` so they are testable without
 * workerd.
 */
export interface ToolDef<Args = Record<string, unknown>> {
  name: string;
  title: string;
  /** Must include one example call, per the spec. */
  description: string;
  inputSchema: ZodRawShape;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (deps: ToolDeps, args: Args) => Promise<unknown>;
}

/**
 * A structured, agent-facing error. `details` may carry an upstream status and
 * a body excerpt; it must never carry a secret or a full upstream URL that
 * embeds one.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }

  toJSON(): Record<string, unknown> {
    return { error: this.message, ...this.details };
  }
}
