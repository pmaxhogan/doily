import predatoryData from "../../data/predatory.json";
import { normalizeIssn, normalizeTitle } from "./text.ts";

/**
 * Committed data snapshots (spec section 8), produced by the snapshot
 * workstream and refreshed by hand once a year.
 *
 * data/sjr.json - trimmed SCImago Journal Rank export:
 *   {
 *     "generated": "2026-10-16",          // ISO date of the export
 *     "year": 2025,                        // optional: SJR edition year
 *     "entries": {
 *       "00280836": {                      // key: ISSN without the hyphen, NNNNNNNX
 *         "title": "Nature",               //   (every ISSN of the journal gets its own
 *                                          //   key; lookups also accept NNNN-NNNX keys)
 *         "sjr": 18.509,                   // SJR indicator
 *         "quartile": "Q1",                // best quartile across categories
 *         "h_index": 1331,                 // optional
 *         "year": 2025                     // optional: per-entry edition year
 *       }
 *     }
 *   }
 *
 * data/predatory.json - journals and publishers on predatory watch lists:
 *   {
 *     "generated": "2026-10-16",
 *     "journals":   [{ "name": "...", "issn": "1234-5678"?, "source": "beallslist.net",
 *                      "url": "..."?, "scraped": "2026-10-16"? }],
 *     "publishers": [{ "name": "...", "source": "predatoryjournals.org",
 *                      "url": "..."?, "scraped": "2026-10-16"? }]
 *   }
 *
 * Matches are evidence (`listed_on`), never a verdict.
 */

export interface SjrEntry {
  title?: string;
  sjr?: number;
  quartile?: string | null;
  h_index?: number;
  year?: number;
}

export interface SjrSnapshot {
  generated: string;
  year?: number;
  entries: Record<string, SjrEntry>;
}

export interface PredatoryEntry {
  name: string;
  issn?: string | null;
  source: string;
  url?: string;
  scraped?: string;
}

export interface PredatorySnapshot {
  generated: string;
  journals: PredatoryEntry[];
  publishers: PredatoryEntry[];
}

export interface ListedOn {
  source: string;
  list: "journals" | "publishers";
  matched_on: "issn" | "name" | "publisher";
  entry: string;
  url?: string;
  scraped?: string;
}

const predatory = predatoryData as unknown as PredatorySnapshot;

/**
 * Where the SJR snapshot lives at runtime. It is 6 MB of JSON, too big to
 * bundle into the Worker (workerd refuses to start the module), so
 * `npm run deploy` uploads data/sjr.json to R2 and the Worker reads it once
 * per isolate.
 */
export const SJR_R2_KEY = "data/sjr.json";

export const EMPTY_SJR: SjrSnapshot = { generated: "", entries: {} };

let sjrCache: SjrSnapshot | null = null;

/** For tests: forget the isolate-level cache. */
export function clearSjrCache(): void {
  sjrCache = null;
}

/**
 * The SJR snapshot from R2, cached per isolate. A missing object yields the
 * empty snapshot (uncached, so an upload is picked up on the next call) and
 * get_journal reports no SJR data rather than failing.
 */
export async function loadSjr(bucket: R2Bucket | undefined): Promise<SjrSnapshot> {
  if (sjrCache) return sjrCache;
  if (!bucket) return EMPTY_SJR;
  const object = await bucket.get(SJR_R2_KEY);
  if (!object) return EMPTY_SJR;
  const parsed = (await object.json()) as SjrSnapshot;
  if (!parsed || typeof parsed !== "object" || !parsed.entries) return EMPTY_SJR;
  sjrCache = parsed;
  return parsed;
}

export function sjrGenerated(snapshot: SjrSnapshot): string | undefined {
  return snapshot.generated || undefined;
}

/** SJR entry for the first ISSN that has one, with the snapshot year. */
export function lookupSjr(
  issns: (string | undefined)[],
  snapshot: SjrSnapshot,
): (SjrEntry & { issn: string; snapshot: string }) | null {
  for (const raw of issns) {
    const issn = normalizeIssn(raw);
    if (!issn) continue;
    // data/sjr.json keys ISSNs without the hyphen (NNNNNNNX); accept both.
    const entry = snapshot.entries[issn] ?? snapshot.entries[issn.replace("-", "")];
    if (entry) {
      return { ...entry, year: entry.year ?? snapshot.year, issn, snapshot: snapshot.generated };
    }
  }
  return null;
}

/**
 * Every predatory-list entry that matches the journal by ISSN or exact
 * normalized name, or its publisher by exact normalized name.
 */
export function lookupPredatory(
  journal: { issns?: (string | undefined)[]; name?: string; publisher?: string },
  snapshot: PredatorySnapshot = predatory,
): ListedOn[] {
  const issns = new Set((journal.issns ?? []).map(normalizeIssn).filter(Boolean));
  const name = normalizeTitle(journal.name);
  const publisher = normalizeTitle(journal.publisher);
  const out: ListedOn[] = [];
  for (const j of snapshot.journals) {
    const issn = normalizeIssn(j.issn);
    let matched: ListedOn["matched_on"] | undefined;
    if (issn && issns.has(issn)) matched = "issn";
    else if (name && normalizeTitle(j.name) === name) matched = "name";
    if (matched) {
      out.push({
        source: j.source,
        list: "journals",
        matched_on: matched,
        entry: j.name,
        url: j.url,
        scraped: j.scraped,
      });
    }
  }
  if (publisher) {
    for (const p of snapshot.publishers) {
      if (normalizeTitle(p.name) === publisher) {
        out.push({
          source: p.source,
          list: "publishers",
          matched_on: "publisher",
          entry: p.name,
          url: p.url,
          scraped: p.scraped,
        });
      }
    }
  }
  return out;
}
