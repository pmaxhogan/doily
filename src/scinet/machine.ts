import { isPdf as hasPdfMagic } from "../scihub/detect.ts";
import { pdfKey, textKey, unverifiedPdfKey } from "./doi.ts";
import { bytesContainDoi } from "./hooks.ts";

import type { SciNetClient } from "./client.ts";
import type { TextOf } from "./hooks.ts";

/**
 * The per-DOI request state machine behind the SciNetRequest Durable Object.
 * It is a plain class over injected storage, alarm, client, bucket and clock so
 * it runs in Node unit tests; request-object.ts is the thin workerd shell.
 *
 *   start --> pending --(solved_unaccepted: view, %PDF, DOI/title found)-->
 *                        ready + accept_pending --(GET /accept/<doi>)--> ready, verified
 *                     --(solved: storage PDF on the page, sanity ok)----> ready
 *                     --(sanity check fails; never accepted)------------> needs_owner
 *                     --(72h since created_at)--------------------------> expired
 *   start --(lookup/post error)--> failed   (a later start retries)
 *
 * Every alarm re-reads storage and only advances, so repeated or overlapping
 * alarms are safe. The PDF is downloaded only while `pending`, and the accept
 * is sent only while `accept_pending`; once one was sent and not confirmed,
 * the request page is re-read before anything is sent again.
 */

/** verify_note once the solution was accepted on Sci-Net by us. */
export const ACCEPTED_NOTE = "accepted on sci-net";
/** verify_note when the page already showed an accepted solution. */
export const ALREADY_ACCEPTED_NOTE = "already accepted on sci-net";
/** verify_note when the preview offered this account no accept link. */
export const NO_ACCEPT_NOTE = "the sci-net preview offered no accept link; nothing was accepted";

export type RequestStatusName = "pending" | "ready" | "expired" | "failed" | "needs_owner";

export interface RequestState {
  doi: string;
  title?: string;
  request_id?: string;
  request_url?: string;
  /**
   * True when this run did not create the Sci-Net request: the lookup said it
   * was already posted, or the post landed on this account's own earlier
   * request that was already taken or solved. A joined request spends no slot.
   */
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
  /**
   * Whether the request is confirmed complete on Sci-Net: the solution was
   * accepted (by us, or earlier). Unset for someone else's request.
   */
  verified?: boolean;
  /** How completion was confirmed, e.g. "accepted on sci-net". */
  verify_note?: string;
  /** The PDF passed the sanity check and is stored; the accept is still to send. */
  accept_pending?: boolean;
  /** An accept was sent and not confirmed; re-read the page before re-sending. */
  accept_tried?: boolean;
  accepted_at?: string;
}

export type StartResult =
  | { ok: true; state: RequestState; posted: boolean; existing: boolean }
  | { ok: false; error: string; details: Record<string, unknown>; state: RequestState };

export interface MachineStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  /** The scheduled alarm time, or null when none is armed. */
  getAlarm(): Promise<number | null>;
}

export type ScinetClientLike = Pick<
  SciNetClient,
  | "findExistingRequest"
  | "listOwnRequests"
  | "postRequest"
  | "getRequestStatus"
  | "viewSolution"
  | "acceptSolution"
  | "downloadPdf"
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

/** `%PDF-` magic in the first 1024 bytes, the same rule Sci-Hub results use. */
export function isPdf(bytes: Uint8Array): boolean {
  return hasPdfMagic(bytes);
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

  /** True when this account already requested the DOI (any state). A library read failing counts as "no", so a post still happens. */
  private async inOwnLibrary(client: ScinetClientLike, doi: string): Promise<boolean> {
    try {
      const rows = await client.listOwnRequests();
      const wanted = doi.trim().toLowerCase();
      return rows.some((row) => row.doi.trim().toLowerCase() === wanted);
    } catch {
      return false;
    }
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
      } else if (await this.inOwnLibrary(client, doi)) {
        // Sci-Net does not answer "already posted" for this account's own
        // earlier request; the library page is the only place it shows.
        state.request_id = doi;
        state.joined = true;
      } else {
        // A fresh post is a spend, full stop. Seen live on 2026-10-16: a
        // solver can take a new request within seconds, so the request page
        // read right after posting proves nothing about whether we paid.
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
    } else if (state.status === "pending" && (await this.deps.storage.getAlarm()) === null) {
      // Seen live on 2026-10-16: a restarted request sat pending with no
      // alarm armed while its solution waited on Sci-Net. Any read of a
      // pending request re-arms the poll, so a lost alarm costs one read.
      state.last_error = "poll alarm was missing; re-armed";
      await this.save(state);
      await this.schedule();
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
    const needsAccept =
      state.status === "ready" && state.accept_pending === true && state.verified !== true;
    if (state.status !== "pending" && !needsAccept) return;

    if (this.expired(state)) {
      if (state.status === "pending") state.status = "expired";
      else state.last_error = "the accept on Sci-Net was never confirmed";
      await this.save(state);
      return;
    }

    state.attempts += 1;
    console.log(`scinet alarm ${state.doi} attempt ${state.attempts} status ${state.status}`);
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
        if ((state.status as RequestStatusName) !== "ready" || state.accept_pending !== true) {
          return;
        }
      }
      await this.accept(client, state);
    } catch (e) {
      state.last_error = message(e);
      await this.save(state);
      await this.schedule();
    }
  }

  /**
   * Accept the stored solution on Sci-Net, at most once: `accept_tried` is
   * saved before the accept is sent, and once set, the request page is
   * re-read first; an accepted (`solved`) page completes without sending.
   */
  private async accept(client: ScinetClientLike, state: RequestState): Promise<void> {
    const id = state.request_id ?? state.doi;
    if (state.accept_tried === true) {
      const page = await client.getRequestStatus(id);
      if (page.status === "solved") {
        await this.markAccepted(state);
        return;
      }
      if (page.status !== "solved_unaccepted") {
        state.last_error = `request page reads ${page.status}; the accept was not re-sent`;
        await this.save(state);
        await this.schedule();
        return;
      }
    }
    state.accept_tried = true;
    await this.save(state);
    const res = await client.acceptSolution(id);
    if (res.ok) {
      await this.markAccepted(state);
      return;
    }
    state.last_error = "Sci-Net did not confirm the accept; the page is re-checked next time";
    await this.save(state);
    await this.schedule();
  }

  private async markAccepted(state: RequestState): Promise<void> {
    state.verified = true;
    state.verify_note = ACCEPTED_NOTE;
    state.accepted_at = this.iso();
    delete state.accept_pending;
    delete state.accept_tried;
    delete state.last_error;
    await this.save(state);
  }

  /**
   * Poll Sci-Net; on fulfilment download, sanity check and store. Returns false
   * when nothing is downloadable yet (nothing changed but attempts). An
   * unaccepted solution is fetched through its preview, which also says
   * whether we may accept it. Saves the state itself whenever it advances so a
   * crash before the accept never repeats the download.
   */
  private async collect(client: ScinetClientLike, state: RequestState): Promise<boolean> {
    const id = state.request_id ?? state.doi;
    const remote = await client.getRequestStatus(id);
    let pdfUrl: string | undefined;
    let canAccept = false;
    const unaccepted = remote.status === "solved_unaccepted";
    if (unaccepted || (remote.status === "solved" && remote.pdfUrl === undefined)) {
      const view = await client.viewSolution(id);
      pdfUrl = view.pdfUrl;
      canAccept = view.canAccept;
      if (pdfUrl === undefined) {
        state.last_error = "the Sci-Net preview shows no PDF yet; will retry";
        return false;
      }
    } else if (remote.status === "solved") {
      pdfUrl = remote.pdfUrl;
    }
    if (pdfUrl === undefined) {
      delete state.last_error;
      return false;
    }
    if (remote.uploadedAt !== undefined) state.uploaded_at = remote.uploadedAt;
    const bytes = await client.downloadPdf(pdfUrl);
    const pdf = { httpMetadata: { contentType: "application/pdf" } };
    const notAccepted = unaccepted ? "; not accepted on Sci-Net" : "";

    if (!isPdf(bytes)) {
      await this.deps.bucket.put(unverifiedPdfKey(state.doi), bytes);
      state.pdf_key = unverifiedPdfKey(state.doi);
      state.status = "needs_owner";
      state.last_error = `fulfilment is not a PDF (no %PDF magic); left unverified${notAccepted}`;
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
    const sane = textMatches(text, state.doi, state.title) || bytesContainDoi(bytes, state.doi);
    if (!sane) {
      await this.deps.bucket.put(unverifiedPdfKey(state.doi), bytes, pdf);
      state.pdf_key = unverifiedPdfKey(state.doi);
      state.status = "needs_owner";
      state.last_error = `sanity check failed: DOI/title not found in the PDF text; left unverified${notAccepted}`;
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
    if (canAccept) {
      // Saved before any accept is sent: a crash here never re-downloads.
      state.accept_pending = true;
      state.verified = false;
    } else if (unaccepted) {
      state.verify_note = NO_ACCEPT_NOTE;
      if (state.joined !== true) state.verified = false;
    } else if (state.joined !== true) {
      // Accepted earlier (by us or by hand); someone else's stays unset.
      state.verified = true;
      state.verify_note = ALREADY_ACCEPTED_NOTE;
    }
    await this.save(state);
    return true;
  }
}
