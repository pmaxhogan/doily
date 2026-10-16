import { describe, expect, it } from "vitest";
import { pageText } from "../../../src/fulltext/page.ts";

function allPages(text: string, limit: number): string[] {
  const out: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const p = pageText(text, offset, limit);
    out.push(p.text);
    expect(p.total_chars).toBe(text.length);
    if (p.next_offset === undefined) return out;
    expect(p.next_offset).toBeGreaterThan(offset);
    offset = p.next_offset;
  }
  throw new Error("pager did not terminate");
}

describe("pageText", () => {
  it("returns everything when it fits", () => {
    expect(pageText("short", 0)).toEqual({ text: "short", total_chars: 5, offset: 0 });
  });

  it("returns an empty page past the end", () => {
    expect(pageText("abc", 3, 2)).toEqual({ text: "", total_chars: 3, offset: 3 });
    expect(pageText("abc", 99, 2)).toEqual({ text: "", total_chars: 3, offset: 99 });
  });

  it("treats negative or non-finite offsets as 0", () => {
    expect(pageText("abc", -5).offset).toBe(0);
    expect(pageText("abc", Number.NaN).offset).toBe(0);
  });

  it("cuts at a paragraph break in the second half of the window", () => {
    const text = `${"a".repeat(70)}\n\n${"b".repeat(50)}`;
    const p = pageText(text, 0, 100);
    expect(p.text).toBe(`${"a".repeat(70)}\n\n`);
    expect(p.next_offset).toBe(72);
  });

  it("ignores a paragraph break too early in the window and cuts at a sentence end", () => {
    const text = `${"a".repeat(10)}\n\n${"b".repeat(50)}. ${"c".repeat(30)}. ${"d".repeat(40)}`;
    const p = pageText(text, 0, 100);
    expect(p.text.endsWith(`${"c".repeat(30)}. `)).toBe(true);
  });

  it("falls back to whitespace, then to a hard cut", () => {
    const words = `${"x".repeat(60)} ${"y".repeat(60)}`;
    expect(pageText(words, 0, 100).text).toBe(`${"x".repeat(60)} `);
    const solid = "z".repeat(250);
    const p = pageText(solid, 0, 100);
    expect(p.text).toHaveLength(100);
    expect(p.next_offset).toBe(100);
  });

  it("never splits a surrogate pair on a hard cut", () => {
    const text = `${"z".repeat(99)}\u{1f600}${"z".repeat(50)}`;
    const p = pageText(text, 0, 100);
    expect(p.text).toHaveLength(99);
    expect(pageText(text, p.next_offset ?? 0, 100).text.startsWith("\u{1f600}")).toBe(true);
  });

  it("reassembles to the original text with no gap or overlap", () => {
    const para = (i: number): string =>
      `Paragraph ${i}. ${"Some sentence here. ".repeat((i % 7) + 1)}`;
    const text = Array.from({ length: 200 }, (_, i) => para(i)).join("\n\n");
    for (const limit of [50, 137, 1000, 60_000]) {
      const pages = allPages(text, limit);
      expect(pages.join("")).toBe(text);
      for (const p of pages) expect(p.length).toBeLessThanOrEqual(limit);
    }
  });

  it("defaults to 60000-char pages", () => {
    const text = "word ".repeat(30_000);
    const p = pageText(text, 0);
    expect(p.text.length).toBeLessThanOrEqual(60_000);
    expect(p.text.length).toBeGreaterThan(59_000);
    expect(p.next_offset).toBe(p.text.length);
  });
});
