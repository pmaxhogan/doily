import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { noText, scinetHooks, setScinetHooks } from "../../../src/scinet/hooks.ts";
import { makeRequestToken } from "../../../src/scinet/token.ts";
import { tools } from "../../../src/tools/index.ts";
import {
  ETA_HINT,
  INDEX_KEY,
  PAGE_CHARS,
  listRequests,
  requestPaper,
  waitForRequest,
} from "../../../src/tools/request.ts";
import { ToolError } from "../../../src/tools/types.ts";
import { PDF_DOI, toolRig } from "./fakes.ts";

import type { ToolDef } from "../../../src/tools/types.ts";

const SOLVED = {
  status: "solved" as const,
  pdfUrl: "https://sci-net.xyz/storage/2026/1/ab/Example.pdf",
};

function parse(tool: ToolDef<never>, args: unknown) {
  return z.object(tool.inputSchema).safeParse(args);
}

afterEach(() => {
  setScinetHooks({ textOf: noText, isObtainable: async () => false });
});

describe("tool registration and schemas", () => {
  it("registers the three request tools with an example in each description", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["request_paper", "wait_for_request", "list_requests"]),
    );
    for (const t of [requestPaper, waitForRequest, listRequests]) {
      expect(t.description).toMatch(/Example: \w+\(/);
    }
    expect(requestPaper.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("validates request_paper args", () => {
    expect(parse(requestPaper as ToolDef<never>, { id: PDF_DOI }).success).toBe(true);
    expect(parse(requestPaper as ToolDef<never>, { id: "" }).success).toBe(false);
    expect(parse(requestPaper as ToolDef<never>, { id: PDF_DOI, bounty: 0 }).success).toBe(false);
    expect(parse(requestPaper as ToolDef<never>, { id: PDF_DOI, bounty: 1.5 }).success).toBe(false);
  });

  it("validates wait_for_request args and defaults to 60 s", () => {
    const ok = parse(waitForRequest as ToolDef<never>, { request_id: PDF_DOI });
    expect(ok.success && ok.data).toEqual({ request_id: PDF_DOI, max_wait_seconds: 60 });
    const tooLong = { request_id: PDF_DOI, max_wait_seconds: 121 };
    expect(parse(waitForRequest as ToolDef<never>, tooLong).success).toBe(false);
  });

  it("validates list_requests status", () => {
    expect(parse(listRequests as ToolDef<never>, {}).success).toBe(true);
    expect(parse(listRequests as ToolDef<never>, { status: "ready" }).success).toBe(true);
    expect(parse(listRequests as ToolDef<never>, { status: "done" }).success).toBe(false);
  });
});

describe("request_paper", () => {
  it("posts, reserves one slot and indexes the DOI", async () => {
    const r = toolRig();
    const out = await requestPaper.handler(r.deps, { id: "https://doi.org/10.1234/EXAMPLE.5678" });
    expect(out).toEqual({
      request_id: PDF_DOI,
      status: "pending",
      eta_hint: ETA_HINT,
      joined_existing: false,
    });
    expect(r.client.calls.post).toBe(1);
    expect([...r.db.rows.values()]).toEqual([{ requests: 1, tokens: 2 }]);
    expect(JSON.parse(r.kv.data.get(INDEX_KEY) ?? "[]")).toEqual([PDF_DOI]);
    expect(r.ns.rigs.has(PDF_DOI)).toBe(true);
  });

  it("accepts a request_token", async () => {
    const r = toolRig();
    const token = await makeRequestToken("test-secret", PDF_DOI);
    expect(await requestPaper.handler(r.deps, { id: token })).toMatchObject({
      request_id: PDF_DOI,
    });
  });

  it("rejects a forged token and garbage ids", async () => {
    const r = toolRig();
    const token = await makeRequestToken("other-secret", PDF_DOI);
    await expect(requestPaper.handler(r.deps, { id: token })).rejects.toThrow(
      /invalid request_token/,
    );
    await expect(requestPaper.handler(r.deps, { id: "not a doi" })).rejects.toThrow(
      /neither a DOI/,
    );
  });

  it("refuses a bounty above SCINET_BOUNTY and never raises it", async () => {
    const r = toolRig();
    const err = await requestPaper.handler(r.deps, { id: PDF_DOI, bounty: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).toJSON()).toMatchObject({ bounty: 3, max: 2 });
    expect(r.client.calls.post).toBe(0);
    expect(r.db.rows.size).toBe(0);
  });

  it("posts without the owner opt-in now that the site flow is verified", async () => {
    const r = toolRig({ SCINET_ALLOW_UNVERIFIED: "0" });
    const out = await requestPaper.handler(r.deps, { id: PDF_DOI });
    expect(out).toMatchObject({ request_id: PDF_DOI, status: "pending" });
    expect(r.client.calls.post).toBe(1);
  });

  it("refuses when the paper is obtainable", async () => {
    const r = toolRig();
    setScinetHooks({ isObtainable: async () => ({ source: "unpaywall" }) });
    const err = (await requestPaper.handler(r.deps, { id: PDF_DOI }).catch((e) => e)) as ToolError;
    expect(err.toJSON()).toMatchObject({ error: "obtainable", source: "unpaywall" });
    expect(r.db.rows.size).toBe(0);
    expect(scinetHooks.isObtainable).toBeTypeOf("function");
  });

  it("enforces the daily cap across DOIs", async () => {
    const r = toolRig({ SCINET_DAILY_CAP: "2" });
    await requestPaper.handler(r.deps, { id: "10.1000/a" });
    await requestPaper.handler(r.deps, { id: "10.1000/b" });
    await expect(requestPaper.handler(r.deps, { id: "10.1000/c" })).rejects.toThrow(/cap reached/);
    expect(r.client.calls.post).toBe(2);
  });

  it("returns a live request without spending again", async () => {
    const r = toolRig();
    await requestPaper.handler(r.deps, { id: PDF_DOI });
    const again = await requestPaper.handler(r.deps, { id: PDF_DOI });
    expect(again).toMatchObject({ request_id: PDF_DOI, status: "pending", existing: true });
    expect(r.client.calls.post).toBe(1);
    expect([...r.db.rows.values()]).toEqual([{ requests: 1, tokens: 2 }]);
  });

  it("joining an existing Sci-Net request gives the slot back", async () => {
    const r = toolRig();
    r.client.existing = "theirs";
    expect(await requestPaper.handler(r.deps, { id: PDF_DOI })).toMatchObject({
      joined_existing: true,
    });
    expect([...r.db.rows.values()]).toEqual([{ requests: 0, tokens: 0 }]);
  });

  it("a post that lands on the owner's already-solved request gives the slot back", async () => {
    const r = toolRig();
    // Sci-Net answers 200 for a DOI this account already requested.
    r.client.postRemote = { status: "solved_unaccepted", fileName: "Example.pdf", reward: 2 };
    expect(await requestPaper.handler(r.deps, { id: PDF_DOI })).toMatchObject({
      status: "pending",
      joined_existing: true,
    });
    expect(r.client.calls.post).toBe(1);
    expect([...r.db.rows.values()]).toEqual([{ requests: 0, tokens: 0 }]);
  });

  it("a failed post gives the slot back and reports the upstream status", async () => {
    const r = toolRig();
    const { SciNetError } = await import("../../../src/scinet/client.ts");
    r.client.failPost = new SciNetError("Sci-Net request post failed", 502, "bad gateway");
    const err = (await requestPaper.handler(r.deps, { id: PDF_DOI }).catch((e) => e)) as ToolError;
    expect(err.toJSON()).toMatchObject({ source: "scinet", status: 502, excerpt: "bad gateway" });
    expect([...r.db.rows.values()]).toEqual([{ requests: 0, tokens: 0 }]);
  });

  it("refuses when Sci-Net credentials are missing", async () => {
    const r = toolRig({ SCINET_PASS: "" });
    await expect(requestPaper.handler(r.deps, { id: PDF_DOI })).rejects.toThrow(/not configured/);
  });
});

describe("wait_for_request", () => {
  it("returns pending with timestamps when nothing happened", async () => {
    const r = toolRig();
    await requestPaper.handler(r.deps, { id: PDF_DOI });
    const out = await waitForRequest.handler(r.deps, { request_id: PDF_DOI, max_wait_seconds: 4 });
    expect(out).toMatchObject({ status: "pending", request_id: PDF_DOI, attempts: 0 });
  });

  it("on ready returns the first page of text and the PDF resource", async () => {
    const r = toolRig();
    setScinetHooks({ textOf: async () => `doi ${PDF_DOI} ${"y".repeat(PAGE_CHARS + 10)}` });
    await requestPaper.handler(r.deps, { id: PDF_DOI });
    r.client.remote = SOLVED;
    await r.ns.rig(PDF_DOI).machine.alarm();
    const out = (await waitForRequest.handler(r.deps, {
      request_id: PDF_DOI,
      max_wait_seconds: 60,
    })) as Record<string, unknown>;
    expect(out).toMatchObject({
      status: "ready",
      doi: PDF_DOI,
      source: "sci-net",
      pdf_resource: `doily://pdf/${PDF_DOI}`,
      text_key: `text/${PDF_DOI}.md`,
      offset: 0,
      next_offset: PAGE_CHARS,
      verified: true,
    });
    expect(String(out["text"])).toHaveLength(PAGE_CHARS);
    expect(out["total_chars"]).toBe(PAGE_CHARS + 10 + PDF_DOI.length + 5);
  });

  it("reports an accepted solution with accepted_at and the accept note", async () => {
    const r = toolRig();
    await requestPaper.handler(r.deps, { id: PDF_DOI });
    r.client.remote = { status: "solved_unaccepted" };
    await r.ns.rig(PDF_DOI).machine.alarm();
    const out = await waitForRequest.handler(r.deps, { request_id: PDF_DOI, max_wait_seconds: 0 });
    expect(out).toMatchObject({
      status: "ready",
      verified: true,
      verify_note: "accepted on sci-net",
      accepted_at: expect.any(String),
    });
  });

  it("needs_owner says nothing was accepted and where to decide", async () => {
    const r = toolRig();
    await requestPaper.handler(r.deps, { id: PDF_DOI });
    r.client.remote = { status: "solved_unaccepted" };
    r.client.pdf = new TextEncoder().encode("%PDF-1.7\nunrelated\n%%EOF\n");
    await r.ns.rig(PDF_DOI).machine.alarm();
    const out = (await waitForRequest.handler(r.deps, {
      request_id: PDF_DOI,
      max_wait_seconds: 0,
    })) as Record<string, unknown>;
    expect(out["status"]).toBe("needs_owner");
    expect(String(out["note"])).toContain("not accepted on Sci-Net");
    expect(String(out["note"])).toContain(`https://sci-net.xyz/view/${PDF_DOI}`);
    expect(r.client.calls.accept).toBe(0);
  });

  it("needs_owner on an already-accepted solution does not ask to accept it", async () => {
    const r = toolRig();
    await requestPaper.handler(r.deps, { id: PDF_DOI });
    r.client.remote = SOLVED;
    r.client.pdf = new TextEncoder().encode("%PDF-1.7\nunrelated\n%%EOF\n");
    await r.ns.rig(PDF_DOI).machine.alarm();
    const out = (await waitForRequest.handler(r.deps, {
      request_id: PDF_DOI,
      max_wait_seconds: 0,
    })) as Record<string, unknown>;
    expect(out["status"]).toBe("needs_owner");
    expect(String(out["note"])).not.toContain("accept");
  });

  it("errors for a DOI that was never requested", async () => {
    const r = toolRig();
    await expect(
      waitForRequest.handler(r.deps, { request_id: PDF_DOI, max_wait_seconds: 1 }),
    ).rejects.toThrow(/request_paper first/);
  });
});

describe("list_requests", () => {
  it("fans out to every indexed DO and filters by status", async () => {
    const r = toolRig();
    await requestPaper.handler(r.deps, { id: "10.1000/a" });
    r.clock.advance(1000);
    await requestPaper.handler(r.deps, { id: "10.1000/b" });
    r.client.remote = SOLVED;
    r.client.pdf = new TextEncoder().encode("%PDF-1.7 doi 10.1000/b");
    await r.ns.rig("10.1000/b").machine.alarm();

    const all = (await listRequests.handler(r.deps, {})) as {
      requests: { doi: string; status: string }[];
      spend_today: { requests: number; cap: number };
    };
    expect(all.requests.map((q) => [q.doi, q.status])).toEqual([
      ["10.1000/b", "ready"],
      ["10.1000/a", "pending"],
    ]);
    expect(all.spend_today).toMatchObject({ requests: 2, cap: 5 });

    const ready = (await listRequests.handler(r.deps, { status: "ready" })) as {
      requests: { doi: string }[];
    };
    expect(ready.requests.map((q) => q.doi)).toEqual(["10.1000/b"]);
  });

  it("tolerates a missing or corrupt index", async () => {
    const r = toolRig();
    r.kv.data.set(INDEX_KEY, "{not json");
    expect(await listRequests.handler(r.deps, {})).toMatchObject({ requests: [] });
  });
});
