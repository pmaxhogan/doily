import { describe, expect, it } from "vitest";

import { SciNetError } from "../../../src/scinet/client.ts";
import {
  EXPIRY_MS,
  POLL_INTERVAL_MS,
  RequestMachine,
  isPdf,
  textMatches,
} from "../../../src/scinet/machine.ts";
import { PDF_DOI, machineRig, pdfBytes } from "./fakes.ts";

import type { RequestState } from "../../../src/scinet/machine.ts";

const SOLVED = {
  status: "solved" as const,
  pdfUrl: "https://sci-net.xyz/storage/2026/1/ab/Example.pdf",
};
const UNACCEPTED = { status: "solved_unaccepted" as const, fileName: "Example.pdf", reward: 2 };
const VIEW_PDF = "https://sci-net.xyz/storage/0123456789abcdef0123456789abcdef/Example.pdf";

describe("RequestMachine.start", () => {
  it("posts a new request and schedules the first poll in 5 minutes", async () => {
    const r = machineRig();
    const res = await r.machine.start(PDF_DOI, 2);
    expect(res).toMatchObject({ ok: true, posted: true, existing: false });
    expect(res.state).toMatchObject({
      doi: PDF_DOI,
      status: "pending",
      request_id: PDF_DOI,
      joined: false,
      bounty: 2,
      attempts: 0,
    });
    expect(r.storage.alarm).toBe(r.clock.t + POLL_INTERVAL_MS);
  });

  it("joins an existing Sci-Net request instead of posting", async () => {
    const r = machineRig();
    r.client.existing = "theirs";
    const res = await r.machine.start(PDF_DOI, 2);
    expect(res).toMatchObject({ ok: true, posted: false });
    expect(res.state).toMatchObject({ request_id: "theirs", joined: true });
    expect(r.client.calls.post).toBe(0);
  });

  it("is idempotent while the request is live", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    const again = await r.machine.start(PDF_DOI, 2);
    expect(again).toMatchObject({ ok: true, posted: false, existing: true });
    expect(r.client.calls.post).toBe(1);
  });

  it("records a post failure as failed, and a later start retries", async () => {
    const r = machineRig();
    r.client.failPost = new SciNetError("Sci-Net request post failed", 503, "<p>busy</p>");
    const res = await r.machine.start(PDF_DOI, 2);
    expect(res).toMatchObject({
      ok: false,
      error: "Sci-Net request post failed",
      details: { status: 503, excerpt: "busy" },
    });
    expect((await r.machine.status())?.status).toBe("failed");
    expect(r.storage.alarm).toBeNull();

    r.client.failPost = null;
    const retry = await r.machine.start(PDF_DOI, 2);
    expect(retry).toMatchObject({ ok: true, posted: true });
  });

  it("fails cleanly when the client cannot be built (no credentials)", async () => {
    const r = machineRig();
    const m = new RequestMachine({
      storage: r.storage,
      client: () => {
        throw new Error("Sci-Net is not configured");
      },
      bucket: r.bucket,
      now: r.clock.now,
      textOf: async () => "",
      sleep: r.clock.sleep,
    });
    expect(await m.start(PDF_DOI, 2)).toMatchObject({ ok: false, state: { status: "failed" } });
  });
});

describe("RequestMachine.alarm", () => {
  it("keeps polling while the request is open", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.clock.advance(POLL_INTERVAL_MS);
    await r.machine.alarm();
    const s = await r.machine.status();
    expect(s).toMatchObject({ status: "pending", attempts: 1 });
    expect(r.storage.alarm).toBe(r.clock.t + POLL_INTERVAL_MS);
  });

  it("on fulfilment stores the PDF and text, marks ready and completes", async () => {
    const r = machineRig(async () => `# Paper\n\ndoi: ${PDF_DOI.toUpperCase()}`);
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = SOLVED;
    await r.machine.alarm();
    const s = (await r.machine.status()) as RequestState;
    expect(s).toMatchObject({
      status: "ready",
      verified: true,
      verify_note: "already accepted on sci-net",
      pdf_key: `pdf/${PDF_DOI}.pdf`,
      text_key: `text/${PDF_DOI}.md`,
    });
    // Sci-Net shows no upload time.
    expect(s.uploaded_at).toBeUndefined();
    expect(s.last_error).toBeUndefined();
    expect(r.bucket.objects.get(`pdf/${PDF_DOI}.pdf`)?.contentType).toBe("application/pdf");
    expect(r.bucket.objects.get(`text/${PDF_DOI}.md`)?.value).toContain("# Paper");
    // An accepted page needs no preview and no accept.
    expect(r.client.calls).toMatchObject({ view: 0, accept: 0 });

    // Repeated alarms after completion are no-ops.
    const alarmsBefore = r.storage.alarmsSet;
    await r.machine.alarm();
    await r.machine.alarm();
    expect(r.client.calls).toMatchObject({ download: 1, view: 0, accept: 0 });
    expect(r.storage.alarmsSet).toBe(alarmsBefore);
  });

  it("accepts the DOI from the raw bytes when no text extractor is wired", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = SOLVED;
    await r.machine.alarm();
    const s = await r.machine.status();
    expect(s).toMatchObject({ status: "ready", pdf_key: `pdf/${PDF_DOI}.pdf` });
    expect(s?.text_key).toBeUndefined();
  });

  it("accepts a title match when the DOI is absent", async () => {
    const r = machineRig(async () => "A STUDY OF SYNTHETIC FIXTURES, in unit tests. Abstract...");
    await r.machine.start(PDF_DOI, 2, "A Study of Synthetic Fixtures in Unit Tests");
    r.client.remote = SOLVED;
    r.client.pdf = pdfBytes("no identifiers here");
    await r.machine.alarm();
    expect((await r.machine.status())?.status).toBe("ready");
  });

  it("a failed sanity check leaves it unverified as needs_owner", async () => {
    const r = machineRig(async () => "An entirely different paper about 10.9999/other");
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = SOLVED;
    r.client.pdf = pdfBytes("no identifiers here");
    await r.machine.alarm();
    const s = await r.machine.status();
    expect(s).toMatchObject({
      status: "needs_owner",
      pdf_key: `pdf-unverified/${PDF_DOI}.pdf`,
    });
    expect(s?.last_error).toMatch(/sanity check failed/);
    expect(r.client.calls.accept).toBe(0);
    expect(r.bucket.objects.has(`pdf/${PDF_DOI}.pdf`)).toBe(false);
    expect(r.storage.alarmsSet).toBe(1);
  });

  it("a non-PDF upload is needs_owner", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = SOLVED;
    r.client.pdf = new TextEncoder().encode(`<html>${PDF_DOI}</html>`);
    await r.machine.alarm();
    const s = await r.machine.status();
    expect(s?.status).toBe("needs_owner");
    expect(s?.last_error).toMatch(/not a PDF/);
    expect(r.client.calls.accept).toBe(0);
  });

  it("a solved page without a storage PDF is fetched through the preview", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = { status: "solved" };
    r.client.view = { pdfUrl: VIEW_PDF, canAccept: false };
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "ready",
      verified: true,
      verify_note: "already accepted on sci-net",
    });
    expect(r.client.calls).toMatchObject({ view: 1, download: 1, accept: 0 });
  });
});

describe("RequestMachine solved_unaccepted", () => {
  it("views, downloads, sanity checks, stores, accepts and marks ready", async () => {
    const r = machineRig(async () => `# Paper\n\ndoi: ${PDF_DOI}`);
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    r.client.remoteAfterAccept = SOLVED;
    r.clock.advance(POLL_INTERVAL_MS);
    await r.machine.alarm();
    const s = (await r.machine.status()) as RequestState;
    expect(s).toMatchObject({
      status: "ready",
      verified: true,
      verify_note: "accepted on sci-net",
      pdf_key: `pdf/${PDF_DOI}.pdf`,
      text_key: `text/${PDF_DOI}.md`,
      accepted_at: new Date(r.clock.t).toISOString(),
    });
    expect(s.accept_pending).toBeUndefined();
    expect(s.accept_tried).toBeUndefined();
    expect(s.last_error).toBeUndefined();
    expect(r.client.calls).toMatchObject({ status: 1, view: 1, download: 1, accept: 1 });
    expect(r.bucket.objects.get(`pdf/${PDF_DOI}.pdf`)?.contentType).toBe("application/pdf");
  });

  it("is idempotent: alarms after ready never view, download or accept again", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    await r.machine.alarm();
    expect((await r.machine.status())?.verified).toBe(true);
    const alarmsBefore = r.storage.alarmsSet;
    await r.machine.alarm();
    await r.machine.alarm();
    expect(r.client.calls).toMatchObject({ status: 1, view: 1, download: 1, accept: 1 });
    expect(r.storage.alarmsSet).toBe(alarmsBefore);
  });

  it("a failed sanity check stores under pdf-unverified/ and never accepts", async () => {
    const r = machineRig(async () => "An entirely different paper about 10.9999/other");
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    r.client.pdf = pdfBytes("no identifiers here");
    await r.machine.alarm();
    const s = await r.machine.status();
    expect(s).toMatchObject({ status: "needs_owner", pdf_key: `pdf-unverified/${PDF_DOI}.pdf` });
    expect(s?.last_error).toMatch(/sanity check failed.*not accepted on Sci-Net/);
    expect(s?.verified).toBeUndefined();
    expect(r.bucket.objects.has(`pdf/${PDF_DOI}.pdf`)).toBe(false);
    expect(r.client.calls).toMatchObject({ view: 1, download: 1, accept: 0 });
    await r.machine.alarm();
    expect(r.client.calls).toMatchObject({ view: 1, download: 1, accept: 0 });
  });

  it("keeps polling when the preview has no PDF yet", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    r.client.view = { canAccept: true };
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "pending",
      last_error: "the Sci-Net preview shows no PDF yet; will retry",
    });
    expect(r.client.calls).toMatchObject({ download: 0, accept: 0 });
    expect(r.storage.alarm).toBe(r.clock.t + POLL_INTERVAL_MS);
  });

  it("without an accept link it stores the PDF but accepts nothing", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    r.client.view = { pdfUrl: VIEW_PDF, canAccept: false };
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "ready",
      verified: false,
      verify_note: "the sci-net preview offered no accept link; nothing was accepted",
    });
    await r.machine.alarm();
    expect(r.client.calls).toMatchObject({ download: 1, accept: 0 });
  });

  it("an unconfirmed accept is re-checked on the page, then re-sent once", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    r.client.acceptOk = false;
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "ready",
      verified: false,
      accept_pending: true,
      accept_tried: true,
    });
    expect(r.storage.alarm).toBe(r.clock.t + POLL_INTERVAL_MS);

    r.client.acceptOk = true;
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({ verified: true });
    // One poll before download, one page re-check before the second accept.
    expect(r.client.calls).toMatchObject({ status: 2, view: 1, download: 1, accept: 2 });
  });

  it("a retry finds the page already accepted and sends nothing", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    r.client.failAccept = new Error("network down");
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "ready",
      accept_tried: true,
      last_error: "network down",
    });
    r.client.failAccept = null;
    r.client.remote = SOLVED;
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      verified: true,
      verify_note: "accepted on sci-net",
    });
    expect(r.client.calls).toMatchObject({ download: 1, accept: 1 });
  });

  it("stops retrying the accept after 72 hours", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = UNACCEPTED;
    r.client.acceptOk = false;
    await r.machine.alarm();
    r.clock.advance(EXPIRY_MS);
    const before = r.storage.alarmsSet;
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "ready",
      last_error: "the accept on Sci-Net was never confirmed",
    });
    expect(r.storage.alarmsSet).toBe(before);
    expect(r.client.calls.accept).toBe(1);
  });
});

describe("RequestMachine.start join detection", () => {
  it("a DOI already in the own library is a join: nothing is posted, nothing is spent", async () => {
    const r = machineRig();
    r.client.library = [{ doi: PDF_DOI.toUpperCase(), status: "solved" }];
    const res = await r.machine.start(PDF_DOI, 2);
    expect(res).toMatchObject({ ok: true, posted: false, state: { joined: true } });
    expect(r.client.calls.post).toBe(0);

    // It is still ours: the preview offers the accept link, so it is accepted.
    r.client.remote = UNACCEPTED;
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "ready",
      joined: true,
      verify_note: "accepted on sci-net",
    });
  });

  it("a fresh post is a spend even when a solver took it within seconds", async () => {
    // Seen live 2026-10-16: the request page read right after posting already
    // showed a solver, and the old heuristic skipped the spend ledger.
    for (const remote of [
      { status: "open", reward: 2, taken: true },
      { status: "solved", pdfUrl: SOLVED.pdfUrl },
      { status: "open", reward: 2 },
    ] as const) {
      const r = machineRig();
      r.client.postRemote = remote;
      const res = await r.machine.start(PDF_DOI, 2);
      expect(res).toMatchObject({ ok: true, posted: true, state: { joined: false } });
      expect(r.client.calls.post).toBe(1);
    }
  });

  it("posts when the library page cannot be read", async () => {
    const r = machineRig();
    r.client.failLibrary = new Error("library down");
    const res = await r.machine.start(PDF_DOI, 2);
    expect(res).toMatchObject({ ok: true, posted: true });
    expect(r.client.calls.post).toBe(1);
  });

  it("records poll errors and keeps polling", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.failStatus = new Error("network down");
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({
      status: "pending",
      last_error: "network down",
      attempts: 1,
    });
    expect(r.storage.alarm).toBe(r.clock.t + POLL_INTERVAL_MS);
  });

  it("expires after 72 hours and stops polling", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.clock.advance(EXPIRY_MS);
    const before = r.storage.alarmsSet;
    await r.machine.alarm();
    expect((await r.machine.status())?.status).toBe("expired");
    expect(r.storage.alarmsSet).toBe(before);
    expect(r.client.calls.status).toBe(0);
  });

  it("status() applies expiry lazily if an alarm was missed", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.clock.advance(EXPIRY_MS + 1);
    expect((await r.machine.status())?.status).toBe("expired");
    expect(r.storage.alarm).toBeNull();
  });

  it("does nothing without state", async () => {
    const r = machineRig();
    await r.machine.alarm();
    expect(await r.machine.status()).toBeNull();
  });
});

describe("RequestMachine.waitFor", () => {
  it("returns as soon as the request is ready", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = SOLVED;
    await r.machine.alarm();
    const t0 = r.clock.t;
    expect((await r.machine.waitFor(60_000))?.status).toBe("ready");
    expect(r.clock.t).toBe(t0);
  });

  it("polls every 2 s and gives up at maxMs", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    const t0 = r.clock.t;
    expect((await r.machine.waitFor(5000))?.status).toBe("pending");
    expect(r.clock.t - t0).toBe(5000);
  });

  it("returns null for an unknown request", async () => {
    expect(await machineRig().machine.waitFor(1000)).toBeNull();
  });

  it("re-arms a lost poll alarm when a pending request is read", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    expect(r.storage.alarm).not.toBeNull();
    // The alarm vanished (seen live once); a status read must put it back.
    r.storage.alarm = null;
    const before = r.storage.alarmsSet;
    const state = await r.machine.status();
    expect(state?.status).toBe("pending");
    expect(state?.last_error).toMatch(/re-armed/);
    expect(r.storage.alarm).not.toBeNull();
    expect(r.storage.alarmsSet).toBe(before + 1);
    // An armed alarm is left alone.
    await r.machine.status();
    expect(r.storage.alarmsSet).toBe(before + 1);
  });
});

describe("sanity helpers", () => {
  it("checks the PDF magic", () => {
    expect(isPdf(pdfBytes())).toBe(true);
    expect(isPdf(new TextEncoder().encode("<html>"))).toBe(false);
    expect(isPdf(new Uint8Array())).toBe(false);
  });

  it("finds the DOI across case and line breaks", () => {
    expect(textMatches("DOI 10.1234/EXAMPLE.5678", PDF_DOI)).toBe(true);
    expect(textMatches("doi 10.1234/exam\nple.5678", PDF_DOI)).toBe(true);
    expect(textMatches("nothing", PDF_DOI, "short")).toBe(false);
  });
});
