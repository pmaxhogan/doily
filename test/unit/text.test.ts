import { describe, expect, it } from "vitest";

import {
  cleanText,
  compact,
  dateFromParts,
  decodeEntities,
  invertAbstract,
  normalizeIssn,
  normalizeTitle,
  truncate,
  uniq,
  yearOf,
} from "../../src/lib/text.ts";

describe("text helpers", () => {
  it("strips markup and entities", () => {
    expect(cleanText("The biology<b>,</b> function<b>,</b> and use")).toBe(
      "The biology, function, and use",
    );
    expect(cleanText("<jats:p>Abstract &amp; more</jats:p>")).toBe("Abstract & more");
    expect(cleanText("   ")).toBeUndefined();
    expect(cleanText(null)).toBeUndefined();
    expect(decodeEntities("&#x3b1;-&#946; &lt;x&gt; &bogus;")).toBe(
      `${String.fromCodePoint(0x3b1)}-${String.fromCodePoint(0x3b2)} <x> &bogus;`,
    );
  });

  it("truncates at a word boundary", () => {
    const text = "alpha beta gamma delta epsilon";
    expect(truncate(text, 100)).toBe(text);
    expect(truncate(text, 14)).toBe("alpha beta...");
    expect(truncate(undefined, 5)).toBeUndefined();
  });

  it("normalizes titles for dedup", () => {
    expect(normalizeTitle("Nanometre-scale thermometry in a living cell.")).toBe(
      normalizeTitle("Nanometre-scale Thermometry in a Living Cell"),
    );
    expect(normalizeTitle(`Caf${String.fromCodePoint(0xe9)} <i>au</i> lait`)).toBe("cafeaulait");
    expect(normalizeTitle("")).toBeUndefined();
  });

  it("inverts OpenAlex abstracts", () => {
    expect(invertAbstract({ cells: [1], Living: [0], glow: [2] })).toBe("Living cells glow");
    expect(invertAbstract(null)).toBeUndefined();
  });

  it("parses years, dates and ISSNs", () => {
    expect(yearOf("2013 Aug")).toBe(2013);
    expect(yearOf(2020)).toBe(2020);
    expect(yearOf("n/a")).toBeUndefined();
    expect(dateFromParts([[2013, 7, 31]])).toBe("2013-07-31");
    expect(dateFromParts([[2013, 7]])).toBe("2013-07");
    expect(dateFromParts([[2013]])).toBe("2013");
    expect(dateFromParts(undefined)).toBeUndefined();
    expect(normalizeIssn("0028-0836")).toBe("0028-0836");
    expect(normalizeIssn("1476468x")).toBe("1476-468X");
    expect(normalizeIssn("12345")).toBeUndefined();
  });

  it("uniq and compact", () => {
    expect(uniq(["a", undefined, "a", null, "b"])).toEqual(["a", "b"]);
    expect(compact({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});
