import { DurableObject } from "cloudflare:workers";

import { clientFromEnv } from "./factory.ts";
import { scinetHooks } from "./hooks.ts";
import { RequestMachine } from "./machine.ts";

import type { Env } from "../env.ts";
import type { RequestState, StartResult } from "./machine.ts";

/**
 * One Durable Object per requested DOI (named by the normalized DOI): posts the
 * Sci-Net request, polls on an alarm every five minutes, downloads the
 * fulfilled PDF to R2, sanity checks it, verifies the upload and expires after
 * 72 hours. All logic is in RequestMachine (machine.ts) so it is unit-testable
 * in Node; this class only adapts ctx.storage and env to it.
 *
 * The class name and binding are fixed by migration tag v1 in wrangler.jsonc.
 */
export class SciNetRequest extends DurableObject<Env> {
  private readonly machine: RequestMachine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.machine = new RequestMachine({
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        setAlarm: (at) => storage.setAlarm(at),
        deleteAlarm: () => storage.deleteAlarm(),
      },
      client: () => clientFromEnv(env, globalThis.fetch.bind(globalThis)),
      bucket: env.PDFS,
      now: () => Date.now(),
      textOf: (bytes) => scinetHooks.textOf(bytes),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  }

  async start(doi: string, bounty: number, title?: string): Promise<StartResult> {
    return this.machine.start(doi, bounty, title);
  }

  async status(): Promise<RequestState | null> {
    return this.machine.status();
  }

  async waitFor(maxMs: number): Promise<RequestState | null> {
    return this.machine.waitFor(maxMs);
  }

  override async alarm(): Promise<void> {
    await this.machine.alarm();
  }
}
