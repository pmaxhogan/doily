/**
 * Small text helpers shared by the provider parsers and the merge logic.
 * Upstream metadata arrives with inline markup (Europe PMC titles carry
 * `<b>`/`<i>`, Crossref abstracts carry `<jats:p>`), HTML entities and
 * irregular whitespace; everything an agent sees goes through `cleanText`.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the handful of HTML entities upstream APIs actually emit. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Strips XML/HTML tags, decodes entities and collapses whitespace. */
export function cleanText(input: string | null | undefined): string | undefined {
  if (input == null) return undefined;
  const text = decodeEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** Cuts text at a word boundary near `max` characters and appends "...". */
export function truncate(input: string | undefined, max: number): string | undefined {
  if (input === undefined || input.length <= max) return input;
  const cut = input.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/**
 * Title key for dedup: lowercase, letters and digits only (any script), so
 * "Nanometre-scale thermometry in a living cell." and "Nanometre-scale
 * Thermometry in a Living Cell" collide.
 */
export function normalizeTitle(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const key = (cleanText(input) ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return key.length > 0 ? key : undefined;
}

/** Reconstructs an OpenAlex `abstract_inverted_index` into plain text. */
export function invertAbstract(
  index: Record<string, number[]> | null | undefined,
): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  return cleanText(words.filter((w) => w !== undefined).join(" "));
}

/** Parses "2013", "2013-07-30", "2013 Aug" into a year number. */
export function yearOf(input: string | number | null | undefined): number | undefined {
  if (input == null) return undefined;
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  const match = /\b(1[5-9]\d\d|2\d\d\d)\b/.exec(input);
  return match ? Number(match[1]) : undefined;
}

/** Crossref `date-parts` ([[2013, 7, 31]]) to an ISO-ish date string. */
export function dateFromParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const [y, m, d] = parts[0] as (number | null)[];
  if (typeof y !== "number") return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (typeof m !== "number") return String(y);
  if (typeof d !== "number") return `${y}-${pad(m)}`;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Normalizes an ISSN to "1234-567X", or undefined when it is not one. */
export function normalizeIssn(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const compact = input.replace(/[^0-9xX]/g, "").toUpperCase();
  if (!/^\d{7}[\dX]$/.test(compact)) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** Returns the unique, defined values of a list, preserving order. */
export function uniq<T>(values: (T | undefined | null)[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (v == null || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Removes keys whose value is undefined, so JSON output stays compact. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}
