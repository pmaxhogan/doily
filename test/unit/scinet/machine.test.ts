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
      verify_note: "no verify control on sci-net; nothing to confirm",
      pdf_key: `pdf/${PDF_DOI}.pdf`,
      text_key: `text/${PDF_DOI}.md`,
    });
    // Sci-Net shows no upload time.
    expect(s.uploaded_at).toBeUndefined();
    expect(s.last_error).toBeUndefined();
    expect(r.bucket.objects.get(`pdf/${PDF_DOI}.pdf`)?.contentType).toBe("application/pdf");
    expect(r.bucket.objects.get(`text/${PDF_DOI}.md`)?.value).toContain("# Paper");
    expect(r.client.calls.verify).toBe(1);

    // Repeated alarms after completion are no-ops.
    const alarmsBefore = r.storage.alarmsSet;
    await r.machine.alarm();
    await r.machine.alarm();
    expect(r.client.calls).toMatchObject({ download: 1, verify: 1 });
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
    expect(r.client.calls.verify).toBe(0);
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
    expect(r.client.calls.verify).toBe(0);
  });

  it("retries verification on later alarms when Sci-Net does not confirm", async () => {
    const r = machineRig();
    await r.machine.start(PDF_DOI, 2);
    r.client.remote = SOLVED;
    r.client.verifyResult = false;
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({ status: "ready", verified: false });
    r.client.verifyResult = true;
    await r.machine.alarm();
    expect(await r.machine.status()).toMatchObject({ status: "ready", verified: true });
    expect(r.client.calls).toMatchObject({ download: 1, verify: 2 });
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
