import { describe, expect, it } from "vitest";

import { doiFromVariable, pdfKey, toBase64 } from "../../../src/mcp/resources.ts";

describe("doiFromVariable", () => {
  it("accepts a DOI as matched, or percent-encoded", () => {
    expect(doiFromVariable("10.1038/nature12373")).toBe("10.1038/nature12373");
    expect(doiFromVariable("10.1038%2Fnature12373")).toBe("10.1038/nature12373");
    expect(doiFromVariable("10.1101/2020.03.22.002386")).toBe("10.1101/2020.03.22.002386");
  });

  it("rejects anything that is not DOI-shaped, so no other R2 key is reachable", () => {
    for (const raw of [
      undefined,
      "",
      "nature12373",
      "../text/10.1038/x",
      "10.1038/../../text/x",
      "10.12/short-prefix",
      "%E0%A4%A",
    ]) {
      expect(doiFromVariable(raw), String(raw)).toBeNull();
    }
  });

  it("re-joins an exploded value", () => {
    expect(doiFromVariable(["10.1000/a", "b"])).toBe("10.1000/a,b");
  });
});

describe("pdfKey", () => {
  it("is the cache layout the full-text chain writes", () => {
    expect(pdfKey("10.1038/nature12373")).toBe("pdf/10.1038/nature12373.pdf");
  });
});

describe("toBase64", () => {
  it("matches a byte-at-a-time encoding, including across chunk boundaries", () => {
    const big = new Uint8Array(0x8000 * 2 + 17).map((_, i) => (i * 31) % 256);
    const expected = btoa(Array.from(big, (byte) => String.fromCharCode(byte)).join(""));
    expect(toBase64(big)).toBe(expected);
    expect(toBase64(new Uint8Array())).toBe("");
  });
});
