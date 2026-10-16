/**
 * In-memory stand-in for the slice of R2Bucket the full-text cache and the
 * download route use: put (string or bytes, with http and custom metadata),
 * get (text, arrayBuffer, body stream), head and delete.
 */

export interface StoredObject {
  body: Uint8Array;
  options: R2PutOptions | undefined;
}

export interface FakeR2 {
  bucket: R2Bucket;
  store: Map<string, StoredObject>;
  /** Every key read with get(), in order. */
  gets: string[];
}

export function fakeR2(): FakeR2 {
  const store = new Map<string, StoredObject>();
  const gets: string[] = [];
  const meta = (key: string, s: StoredObject) => ({
    key,
    size: s.body.byteLength,
    customMetadata: s.options?.customMetadata as Record<string, string> | undefined,
    httpMetadata: s.options?.httpMetadata,
  });
  const bucket = {
    async put(key: string, value: string | Uint8Array, options?: R2PutOptions) {
      const body =
        typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, { body, options });
      return null;
    },
    async get(key: string) {
      gets.push(key);
      const s = store.get(key);
      if (!s) return null;
      return {
        ...meta(key, s),
        get body() {
          return new Response(s.body.slice()).body;
        },
        arrayBuffer: async () => s.body.slice().buffer,
        text: async () => new TextDecoder().decode(s.body),
      };
    },
    async head(key: string) {
      const s = store.get(key);
      return s ? meta(key, s) : null;
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store, gets };
}
