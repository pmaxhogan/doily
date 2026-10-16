import { pdfKey, textKey, unverifiedPdfKey } from "./doi.ts";
import { latin1 } from "./hooks.ts";

import type { SciNetClient } from "./client.ts";
import type { TextOf } from "./hooks.ts";

/**
 * The per-DOI request state machine behind the SciNetRequest Durable Object.
 * It is a plain class over injected storage, alarm, client, bucket and clock so
 * it runs in Node unit tests; request-object.ts is the thin workerd shell.
 *
 *   start --> pending --(solved, %PDF, DOI/title found)--> ready (then verify)
 *                     --(solved, sanity check fails)-----> needs_owner
 *                     --(72h since created_at)-----------> expired
 *   start --(lookup/post error)--> failed   (a later start retries)
 *
 * Every alarm re-reads storage and only advances, so repeated or overlapping
 * alarms are safe.
 */

export type RequestStatusName = "pending" | "ready" | "expired" | "failed" | "needs_owner";

export interface RequestState {
  doi: string;
  title?: string;
  request_id?: string;
  request_url?: string;
  /** True when we joined an existing Sci-Net request instead of posting. */
  joined?: boolean;
  status: RequestStatusName;
  created_at: string;
  updated_at: string;
  bounty: number;
  attempts: number;
  last_error?: string;
  pdf_key?: string;
  text_key?: string;
  uploaded_at?: string;
  ready_at?: string;
  /** Whether Sci-Net confirmed our verification (bounty released). */
  verified?: boolean;
}

export type StartResult =
  | { ok: true; state: RequestState; posted: boolean; existing: boolean }
  | { ok: false; error: string; details: Record<string, unknown>; state: RequestState };

export interface MachineStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export type ScinetClientLike = Pick<
  SciNetClient,
  "findExistingRequest" | "postRequest" | "getRequestStatus" | "downloadPdf" | "verifyUpload"
>;

/** The R2 surface the machine writes to (R2Bucket satisfies it). */
export interface BlobStore {
  put(
    key: string,
    value: Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface MachineDeps {
  storage: MachineStorage;
  /** Builds the Sci-Net client; throws when credentials are not configured. */
  client: () => ScinetClientLike;
  bucket: BlobStore;
  now: () => number;
  textOf: TextOf;
  sleep: (ms: number) => Promise<void>;
}

export const POLL_INTERVAL_MS = 5 * 60 * 1000;
export const EXPIRY_MS = 72 * 60 * 60 * 1000;
export const WAIT_POLL_MS = 2000;

const STATE_KEY = "state";
const LIVE: readonly RequestStatusName[] = ["pending", "ready", "needs_owner"];

/** `%PDF` magic at the start of the file. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function words(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Sanity check: the DOI, or failing that the title, appears in the text. */
export function textMatches(text: string, doi: string, title?: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(doi) || lower.replace(/\s+/g, "").includes(doi)) return true;
  if (title !== undefined) {
    const t = words(title);
    if (t.length >= 10 && words(text).includes(t)) return true;
  }
  return false;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function details(e: unknown): Record<string, unknown> {
  if (e !== null && typeof e === "object" && "details" in e) {
    const d = (e as { details: unknown }).details;
    if (d !== null && typeof d === "object") return { ...(d as Record<string, unknown>) };
  }
  return {};
}

export class RequestMachine {
  constructor(private readonly deps: MachineDeps) {}

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private async load(): Promise<RequestState | undefined> {
    return this.deps.storage.get<RequestState>(STATE_KEY);
  }

  private async save(state: RequestState): Promise<RequestState> {
    state.updated_at = this.iso();
    await this.deps.storage.put(STATE_KEY, state);
    return state;
  }

  private async schedule(): Promise<void> {
    await this.deps.storage.setAlarm(this.deps.now() + POLL_INTERVAL_MS);
  }

  private expired(state: RequestState): boolean {
    return this.deps.now() - Date.parse(state.created_at) >= EXPIRY_MS;
  }

  /**
   * Post the request (or join Sci-Net's existing one) and start polling.
   * Idempotent: a live request (pending, ready, needs_owner) is returned as is;
   * only a missing, expired or failed one is (re)started.
   */
  async start(doi: string, bounty: number, title?: string): Promise<StartResult> {
    const current = await this.status();
    if (current !== null && LIVE.includes(current.status)) {
      return { ok: true, state: current, posted: false, existing: true };
    }
    const now = this.iso();
    const state: RequestState = {
      doi,
      status: "pending",
      created_at: now,
      updated_at: now,
      bounty,
      attempts: 0,
    };
    if (title !== undefined && title !== "") state.title = title;
    try {
      const client = this.deps.client();
      const existingId = await client.findExistingRequest(doi);
      let posted = false;
      if (existingId !== undefined) {
        state.request_id = existingId;
        state.joined = true;
      } else {
        const created = await client.postRequest(doi, bounty);
        state.request_id = created.id;
        state.request_url = created.url;
        state.joined = false;
        posted = true;
      }
      await this.save(state);
      await this.schedule();
      return { ok: true, state, posted, existing: false };
    } catch (e) {
      state.status = "failed";
      state.last_error = message(e);
      await this.save(state);
      return { ok: false, error: message(e), details: details(e), state };
    }
  }

  /** Current state, with expiry applied lazily in case an alarm was missed. */
  async status(): Promise<RequestState | null> {
    const state = await this.load();
    if (state === undefined) return null;
    if (state.status === "pending" && this.expired(state)) {
      state.status = "expired";
      await this.save(state);
      await this.deps.storage.deleteAlarm();
    }
    return state;
  }

  /** Long-poll own storage every 2 s until the request leaves `pending` or maxMs passes. */
  async waitFor(maxMs: number): Promise<RequestState | null> {
    const deadline = this.deps.now() + Math.max(0, maxMs);
    for (;;) {
      const state = await this.status();
      if (state === null || state.status !== "pending") return state;
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) return state;
      await this.deps.sleep(Math.min(WAIT_POLL_MS, remaining));
    }
  }

  /** One poll. Never throws: errors are recorded and the next alarm is scheduled. */
  async alarm(): Promise<void> {
    const state = await this.load();
    if (state === undefined) return;
    const needsVerify = state.status === "ready" && state.verified !== true;
    if (state.status !== "pending" && !needsVerify) return;

    if (this.expired(state)) {
      if (state.status === "pending") state.status = "expired";
      else state.last_error = "verification on Sci-Net was never confirmed";
      await this.save(state);
      return;
    }

    state.attempts += 1;
    try {
      const client = this.deps.client();
      if (state.status === "pending") {
        const advanced = await this.collect(client, state);
        if (!advanced) {
          await this.save(state);
          await this.schedule();
          return;
        }
        // collect() mutates state; widen the narrowed type back.
        if ((state.status as RequestStatusName) !== "ready") return;
      }
      const ok = await client.verifyUpload(state.request_id ?? "");
      state.verified = ok;
      if (ok) {
        delete state.last_error;
        await this.save(state);
      } else {
        state.last_error = "Sci-Net did not confirm the verification; will retry";
        await this.save(state);
        await this.schedule();
      }
    } catch (e) {
      state.last_error = message(e);
      await this.save(state);
      await this.schedule();
    }
  }

  /**
   * Poll Sci-Net; on fulfilment download, sanity check and store. Returns false
   * when the request is still open (nothing changed but attempts). Saves the
   * state itself whenever it advances so a crash before verification never
   * repeats the download.
   */
  private async collect(client: ScinetClientLike, state: RequestState): Promise<boolean> {
    const remote = await client.getRequestStatus(state.request_id ?? "");
    if (remote.status !== "solved" || remote.pdfUrl === undefined) {
      delete state.last_error;
      return false;
    }
    if (remote.uploadedAt !== undefined) state.uploaded_at = remote.uploadedAt;
    const bytes = await client.downloadPdf(remote.pdfUrl);
    const pdf = { httpMetadata: { contentType: "application/pdf" } };

    if (!isPdf(bytes)) {
      await this.deps.bucket.put(unverifiedPdfKey(state.doi), bytes);
      state.pdf_key = unverifiedPdfKey(state.doi);
      state.status = "needs_owner";
      state.last_error = "fulfilment is not a PDF (no %PDF magic); left unverified";
      await this.save(state);
      return true;
    }

    let text = "";
    try {
      text = await this.deps.textOf(bytes);
    } catch (e) {
      state.last_error = `text extraction failed: ${message(e)}`;
    }
    // The extracted text is the primary evidence; the raw bytes are a fallback
    // for the DOI only (uncompressed text or XMP metadata).
    const sane = textMatches(text, state.doi, state.title) || textMatches(latin1(bytes), state.doi);
    if (!sane) {
      await this.deps.bucket.put(unverifiedPdfKey(state.doi), bytes, pdf);
      state.pdf_key = unverifiedPdfKey(state.doi);
      state.status = "needs_owner";
      state.last_error =
        "sanity check failed: DOI/title not found in the PDF text; left unverified";
      await this.save(state);
      return true;
    }

    await this.deps.bucket.put(pdfKey(state.doi), bytes, pdf);
    state.pdf_key = pdfKey(state.doi);
    if (text.trim() !== "") {
      await this.deps.bucket.put(textKey(state.doi), text, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
      state.text_key = textKey(state.doi);
    }
    state.status = "ready";
    state.ready_at = this.iso();
    delete state.last_error;
    await this.save(state);
    return true;
  }
}
