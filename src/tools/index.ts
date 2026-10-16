import { requestTools } from "./request.ts";

import type { ToolDef } from "./types.ts";

/**
 * Every tool the server exposes, in the order they are listed to clients.
 * Each workstream appends its own definitions here; `src/mcp/server.ts`
 * registers them all. Keep this file free of logic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous arg types; the server only needs the shared shape
export const tools: ToolDef<any>[] = [...requestTools];
