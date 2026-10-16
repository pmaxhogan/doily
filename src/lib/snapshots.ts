import predatoryData from "../../data/predatory.json";
import sjrData from "../../data/sjr.json";
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
 *       "0028-0836": {                     // key: ISSN as NNNN-NNNX (every ISSN of
 *         "title": "Nature",               //   the journal gets its own key)
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
  quartile?: string;
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
  issn?: string;
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

const sjr = sjrData as SjrSnapshot;
const predatory = predatoryData as PredatorySnapshot;

export function sjrGenerated(snapshot: SjrSnapshot = sjr): string | undefined {
  return snapshot.generated || undefined;
}

/** SJR entry for the first ISSN that has one, with the snapshot year. */
export function lookupSjr(
  issns: (string | undefined)[],
  snapshot: SjrSnapshot = sjr,
): (SjrEntry & { issn: string; snapshot: string }) | null {
  for (const raw of issns) {
    const issn = normalizeIssn(raw);
    if (!issn) continue;
    const entry = snapshot.entries[issn];
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
