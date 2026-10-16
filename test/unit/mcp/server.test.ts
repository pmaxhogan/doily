import { describe, expect, it } from "vitest";

import { errorBody, ping, wrapHandler } from "../../../src/mcp/server.ts";
import { ToolError } from "../../../src/tools/types.ts";

import type { Env } from "../../../src/env.ts";
import type { ToolDef, ToolDeps } from "../../../src/tools/types.ts";

const deps: ToolDeps = {
  env: {} as Env,
  fetch: () => Promise.reject(new Error("no network in unit tests")),
  now: () => new Date("2026-10-16T00:00:00Z"),
  origin: "https://doily.test",
};

function tool(handler: ToolDef<{ q: string }>["handler"]): ToolDef<{ q: string }> {
  return { name: "t", title: "T", description: "Example call: t({})", inputSchema: {}, handler };
}

describe("wrapHandler", () => {
  it("turns a returned value into one JSON text block", async () => {
    const result = await wrapHandler(
      tool(async (_deps, args) => ({ echoed: args.q, n: 1 })),
      deps,
    )({ q: "x" });

    expect(result).toEqual({ content: [{ type: "text", text: '{"echoed":"x","n":1}' }] });
  });

  it("passes the deps through to the handler", async () => {
    const result = await wrapHandler(
      tool(async (d) => ({ origin: d.origin, now: d.now().toISOString() })),
      deps,
    )({ q: "" });

    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "")).toEqual({
      origin: "https://doily.test",
      now: "2026-10-16T00:00:00.000Z",
    });
  });

  it("encodes undefined as JSON null rather than an empty text", async () => {
    const result = await wrapHandler(
      tool(async () => undefined),
      deps,
    )({ q: "" });

    expect(result.content).toEqual([{ type: "text", text: "null" }]);
  });

  it("turns a thrown ToolError into isError with its structured body", async () => {
    const result = await wrapHandler(
      tool(async () => {
        throw new ToolError("upstream failed", { source: "openalex", status: 503 });
      }),
      deps,
    )({ q: "" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ error: "upstream failed", source: "openalex", status: 503 }),
      },
    ]);
  });

  it("turns any other error into isError with only its message", async () => {
    const result = await wrapHandler(
      tool(async () => {
        throw new TypeError("boom");
      }),
      deps,
    )({ q: "" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: '{"error":"boom"}' }]);
  });
});

describe("errorBody", () => {
  it("handles non-Error throws", () => {
    expect(errorBody("plain string")).toEqual({ error: "plain string" });
    expect(errorBody(42)).toEqual({ error: "42" });
    expect(errorBody(null)).toEqual({ error: "null" });
  });

  it("never includes a stack", () => {
    expect(JSON.stringify(errorBody(new Error("x")))).not.toContain("at ");
  });
});

describe("ping", () => {
  it("returns ok and the package version", async () => {
    await expect(ping.handler(deps, {})).resolves.toEqual({
      ok: true,
      version: expect.stringMatching(/^\d+\.\d+\.\d+/u),
    });
  });

  it("is read-only and carries an example call", () => {
    expect(ping.annotations?.readOnlyHint).toBe(true);
    expect(ping.description).toContain("Example call:");
  });
});
