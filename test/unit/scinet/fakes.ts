import { scinetHooks } from "../../../src/scinet/hooks.ts";
import { RequestMachine } from "../../../src/scinet/machine.ts";
import { SPEND_SQL } from "../../../src/scinet/spend.ts";

import type { Env } from "../../../src/env.ts";
import type { BlobStore, MachineStorage, ScinetClientLike } from "../../../src/scinet/machine.ts";
import type { TextOf } from "../../../src/scinet/hooks.ts";
import type { ToolDeps } from "../../../src/tools/types.ts";

// Fixtures are inlined by Vite's `?raw` glob import (this repo has no node:fs types).
const fixtures = import.meta.glob("../../fixtures/scinet/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export function fixture(name: string): string {
  const body = fixtures[`../../fixtures/scinet/${name}`];
  if (body === undefined) throw new Error(`missing fixture ${name}`);
  return body;
}

/** A controllable clock; `sleep` advances it instead of waiting. */
export class FakeClock {
  constructor(public t = Date.parse("2026-10-16T12:00:00Z")) {}
  now = (): number => this.t;
  date = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
  sleep = async (ms: number): Promise<void> => {
    this.t += ms;
  };
}

export class FakeKV {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export class FakeR2 implements BlobStore {
  readonly objects = new Map<string, { value: Uint8Array | string; contentType?: string }>();
  async put(
    key: string,
    value: Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown> {
    const contentType = options?.httpMetadata?.contentType;
    this.objects.set(key, contentType === undefined ? { value } : { value, contentType });
    return {};
  }
  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const obj = this.objects.get(key);
    if (obj === undefined) return null;
    const value = obj.value;
    return {
      text: async () => (typeof value === "string" ? value : new TextDecoder().decode(value)),
    };
  }
}

/** Just enough D1 for spend.ts: dispatches on the exported SQL constants. */
export class FakeD1 {
  readonly rows = new Map<string, { requests: number; tokens: number }>();
  prepare(sql: string) {
    const rows = this.rows;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const day = params[0] as string;
            const row = rows.get(day);
            if (sql === SPEND_SQL.reserve) {
              const tokens = params[1] as number;
              const cap = params[2] as number;
              if (row === undefined) {
                rows.set(day, { requests: 1, tokens });
                return { meta: { changes: 1 } };
              }
              if (row.requests < cap) {
                row.requests += 1;
                row.tokens += tokens;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            if (sql === SPEND_SQL.release) {
              const tokens = params[1] as number;
              if (row === undefined) return { meta: { changes: 0 } };
              row.requests = Math.max(row.requests - 1, 0);
              row.tokens = Math.max(row.tokens - tokens, 0);
              return { meta: { changes: 1 } };
            }
            throw new Error(`FakeD1: unexpected run() SQL: ${sql}`);
          },
          async first<T>(): Promise<T | null> {
            if (sql !== SPEND_SQL.usage) throw new Error(`FakeD1: unexpected first() SQL: ${sql}`);
            const row = rows.get(params[0] as string);
            return row === undefined ? null : ({ ...row } as T);
          },
        };
      },
    };
  }
}

export class FakeStorage implements MachineStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  alarmsSet = 0;
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    // Durable Object storage returns a structured clone, not the stored object.
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
    this.alarmsSet += 1;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
}

export const PDF_DOI = "10.1234/example.5678";

/** A minimal "PDF" whose bytes contain the DOI, as an uncompressed PDF would. */
export function pdfBytes(body = `/Subject (doi:${PDF_DOI})`): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF\n`);
}

/** Scriptable Sci-Net client with call counters. */
export class FakeClient implements ScinetClientLike {
  existing: string | undefined = undefined;
  remote: Awaited<ReturnType<ScinetClientLike["getRequestStatus"]>> = { status: "open" };
  pdf: Uint8Array = pdfBytes();
  /** What the request page shows right after a post. */
  postRemote: Awaited<ReturnType<ScinetClientLike["getRequestStatus"]>> = {
    status: "open",
    reward: 2,
  };
  view: Awaited<ReturnType<ScinetClientLike["viewSolution"]>> = {
    pdfUrl: "https://sci-net.xyz/storage/0123456789abcdef0123456789abcdef/Example.pdf",
    canAccept: true,
  };
  acceptOk = true;
  /** When set, a successful accept also flips `remote` to this (the accepted page). */
  remoteAfterAccept: Awaited<ReturnType<ScinetClientLike["getRequestStatus"]>> | null = null;
  failPost: Error | null = null;
  failStatus: Error | null = null;
  failAccept: Error | null = null;
  calls = { find: 0, post: 0, status: 0, view: 0, download: 0, accept: 0 };

  async findExistingRequest(_doi: string): Promise<string | undefined> {
    this.calls.find += 1;
    return this.existing;
  }
  async postRequest(
    doi: string,
    _bounty: number,
  ): Promise<Awaited<ReturnType<ScinetClientLike["postRequest"]>>> {
    this.calls.post += 1;
    if (this.failPost !== null) throw this.failPost;
    // Sci-Net addresses a request by its DOI.
    return { id: doi, url: `https://sci-net.xyz/${doi}`, remote: this.postRemote };
  }
  async viewSolution(_doi: string): Promise<Awaited<ReturnType<ScinetClientLike["viewSolution"]>>> {
    this.calls.view += 1;
    return this.view;
  }
  async acceptSolution(_doi: string): Promise<{ ok: boolean }> {
    this.calls.accept += 1;
    if (this.failAccept !== null) throw this.failAccept;
    if (this.acceptOk && this.remoteAfterAccept !== null) this.remote = this.remoteAfterAccept;
    return { ok: this.acceptOk };
  }
  async getRequestStatus(
    _id: string,
  ): Promise<Awaited<ReturnType<ScinetClientLike["getRequestStatus"]>>> {
    this.calls.status += 1;
    if (this.failStatus !== null) throw this.failStatus;
    return this.remote;
  }
  async downloadPdf(_url: string): Promise<Uint8Array> {
    this.calls.download += 1;
    return this.pdf;
  }
}

export interface Rig {
  clock: FakeClock;
  storage: FakeStorage;
  client: FakeClient;
  bucket: FakeR2;
  machine: RequestMachine;
}

export function machineRig(textOf: TextOf = async () => ""): Rig {
  const clock = new FakeClock();
  const storage = new FakeStorage();
  const client = new FakeClient();
  const bucket = new FakeR2();
  const machine = new RequestMachine({
    storage,
    client: () => client,
    bucket,
    now: clock.now,
    textOf,
    sleep: clock.sleep,
  });
  return { clock, storage, client, bucket, machine };
}

/** A Durable Object namespace whose stubs are RequestMachines sharing one client and bucket. */
export class FakeNamespace {
  readonly rigs = new Map<string, { storage: FakeStorage; machine: RequestMachine }>();
  constructor(
    readonly clock: FakeClock,
    readonly client: FakeClient,
    readonly bucket: FakeR2,
  ) {}
  idFromName(name: string): { name: string } {
    return { name };
  }
  get(id: { name: string }): RequestMachine {
    return this.rig(id.name).machine;
  }
  rig(name: string): { storage: FakeStorage; machine: RequestMachine } {
    let rig = this.rigs.get(name);
    if (rig === undefined) {
      const storage = new FakeStorage();
      const machine = new RequestMachine({
        storage,
        client: () => this.client,
        bucket: this.bucket,
        now: this.clock.now,
        // Read the hook at call time, as the real DO does.
        textOf: (bytes) => scinetHooks.textOf(bytes),
        sleep: this.clock.sleep,
      });
      rig = { storage, machine };
      this.rigs.set(name, rig);
    }
    return rig;
  }
}

export interface ToolRig {
  deps: ToolDeps;
  clock: FakeClock;
  kv: FakeKV;
  db: FakeD1;
  bucket: FakeR2;
  client: FakeClient;
  ns: FakeNamespace;
}

export function toolRig(envOverrides: Partial<Env> = {}): ToolRig {
  const clock = new FakeClock();
  const kv = new FakeKV();
  const db = new FakeD1();
  const bucket = new FakeR2();
  const client = new FakeClient();
  const ns = new FakeNamespace(clock, client, bucket);
  const env = {
    DB: db,
    PDFS: bucket,
    DOILY_KV: kv,
    SCINET_REQUEST: ns,
    SCINET_USER: "user",
    SCINET_PASS: "pass",
    REQUEST_TOKEN_SECRET: "test-secret",
    // The site flow is verified, so this opt-in is not needed; it stays set so
    // the posting tests keep passing if SITE_VERIFIED is ever flipped back.
    SCINET_ALLOW_UNVERIFIED: "1",
    ...envOverrides,
  } as unknown as Env;
  const deps: ToolDeps = {
    env,
    fetch: (() => {
      throw new Error("tool tests must not fetch");
    }) as unknown as typeof fetch,
    now: clock.date,
    origin: "https://doily.test",
  };
  return { deps, clock, kv, db, bucket, client, ns };
}
