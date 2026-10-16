import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";

/**
 * One Durable Object per requested DOI (wave 2 fills this in): posts the Sci-Net
 * request, polls on an alarm every five minutes, downloads the fulfilled PDF to
 * R2, extracts text, verifies the upload, and expires after 72 hours.
 *
 * The class name and binding are fixed by migration tag v1 in wrangler.jsonc.
 */
export class SciNetRequest extends DurableObject<Env> {
  async status(): Promise<{ status: "unimplemented" }> {
    return { status: "unimplemented" };
  }
}
