#!/usr/bin/env node
// Regenerates data/sjr.json and data/predatory.json from raw sources.
//
// Usage:
//   node scripts/refresh-snapshots.mjs --csv "C:/Users/me/Downloads/scimagojr 2025.csv" [options]
//
// Options (each source may be a local file path or an http(s) URL):
//   --csv <path>               SCImago journalrank CSV (semicolon-separated, decimal commas). Required
//                              unless --skip-sjr is given. Download it in a browser (Cloudflare blocks fetch).
//   --beall-publishers <src>   default https://beallslist.net/
//   --beall-journals <src>     default https://beallslist.net/standalone-journals/
//   --pj-publishers <src>      default: CSV export of the Google Sheet embedded in
//                              https://www.predatoryjournals.org/the-list/publishers
//   --pj-journals <src>        default: CSV export of the Google Sheet embedded in
//                              https://www.predatoryjournals.org/the-list/journals
//   --date <YYYY-MM-DD>        value for "generated" (default: today, UTC). Pass it to reproduce a snapshot.
//   --year <int>               SJR year (default: parsed from the "Total Docs. (YYYY)" header, else the file name)
//   --out <dir>                output directory (default: data)
//   --skip-sjr / --skip-predatory
//
// Output is deterministic for the same inputs and --date: keys and arrays are sorted, all text is
// folded to ASCII.

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";

const SJR_SOURCE = "https://www.scimagojr.com/journalrank.php?out=xls";
const PJ_PUBLISHERS_SHEET = "1BHM4aJljhbOAzSpkX1kXDUEvy6vxREZu5WJaDH6M1Vk";
const PJ_JOURNALS_SHEET = "1Qa1lAlSbl7iiKddYINNsDB4wxI7uUA4IVseeLnCc5U4";
const sheetCsv = (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
const MAX_SJR_BYTES = 8 * 1024 * 1024;

const { values: args } = parseArgs({
  options: {
    csv: { type: "string" },
    "beall-publishers": { type: "string", default: "https://beallslist.net/" },
    "beall-journals": { type: "string", default: "https://beallslist.net/standalone-journals/" },
    "pj-publishers": { type: "string", default: sheetCsv(PJ_PUBLISHERS_SHEET) },
    "pj-journals": { type: "string", default: sheetCsv(PJ_JOURNALS_SHEET) },
    date: { type: "string", default: new Date().toISOString().slice(0, 10) },
    year: { type: "string" },
    out: { type: "string", default: "data" },
    "skip-sjr": { type: "boolean", default: false },
    "skip-predatory": { type: "boolean", default: false },
  },
});

// ---------- text helpers ----------

const SPECIAL = {
  "\u00df": "ss",
  "\u00e6": "ae",
  "\u00c6": "AE",
  "\u0153": "oe",
  "\u0152": "OE",
  "\u00f8": "o",
  "\u00d8": "O",
  "\u0142": "l",
  "\u0141": "L",
  "\u0111": "d",
  "\u0110": "D",
  "\u00f0": "d",
  "\u00d0": "D",
  "\u00fe": "th",
  "\u00de": "Th",
  "\u0131": "i",
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u2032": "'",
  "\u00b4": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2033": '"',
  "\u00ab": '"',
  "\u00bb": '"',
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2026": "...",
  "\u00a0": " ",
  "\u2009": " ",
  "\u200a": " ",
  "\u202f": " ",
  "\u00b7": "-",
  "\u2022": "-",
  "\u00ae": "",
  "\u2122": "",
  "\u00a9": "",
};

/** Fold to printable ASCII deterministically: map known specials, strip diacritics, drop the rest. */
export function toAscii(s) {
  let out = "";
  for (const ch of String(s).normalize("NFKD")) {
    if (ch.charCodeAt(0) < 0x80) out += ch;
    else if (ch in SPECIAL) out += SPECIAL[ch];
    // combining marks and anything unknown are dropped
  }
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return out.replace(/[\u0000-\u001f\u007f]/g, " ");
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function cleanName(s) {
  return toAscii(decodeEntities(s).replace(/[\u200b-\u200d\ufeff]/g, ""))
    .replace(/\s*\([^()]*\bhere\b[^()]*\)/gi, "") // "(also here)", "(new website here)" link notes
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,;:-]+$/, "");
}

// ---------- CSV ----------

/** RFC 4180-style parser with a configurable delimiter. Returns an array of rows (arrays of strings). */
export function parseCsv(text, delim = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const num = (s) => {
  const v = Number(
    String(s ?? "")
      .trim()
      .replace(/\./g, "")
      .replace(",", "."),
  );
  return Number.isFinite(v) ? v : 0;
};

// ---------- sources ----------

async function load(src) {
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, {
      headers: { "user-agent": "Mozilla/5.0 (doily refresh-snapshots)" },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`fetch ${src}: HTTP ${r.status}`);
    return r.text();
  }
  return readFileSync(src, "utf8");
}

// ---------- SJR ----------

function buildSjr(csvPath) {
  const text = readFileSync(csvPath, "utf8").replace(/^\ufeff/, "");
  const rows = parseCsv(text, ";");
  const header = rows[0];
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`SJR CSV: missing column "${name}"`);
    return i;
  };
  const iRank = col("Rank"),
    iTitle = col("Title"),
    iIssn = col("Issn"),
    iSjr = col("SJR");
  const iQ = col("SJR Best Quartile"),
    iH = col("H index"),
    iCpd = col("Citations / Doc. (2years)");

  let year = args.year ? Number(args.year) : NaN;
  if (!Number.isInteger(year)) {
    const m =
      header.join(";").match(/Total Docs\. \((\d{4})\)/) || basename(csvPath).match(/(\d{4})/);
    year = m ? Number(m[1]) : NaN;
  }
  if (!Number.isInteger(year)) throw new Error("SJR year not found; pass --year");

  // Rows arrive in rank order; when two journals share an ISSN the higher-ranked one wins.
  const body = rows.slice(1).filter((r) => r.length >= header.length - 1 && r[iRank] !== "");
  body.sort((a, b) => num(a[iRank]) - num(b[iRank]));
  const entries = {};
  let journals = 0;
  for (const r of body) {
    const issns = r[iIssn]
      .split(",")
      .map((s) =>
        s
          .trim()
          .toUpperCase()
          .replace(/[^0-9X]/g, ""),
      )
      .filter((s) => /^\d{7}[\dX]$/.test(s));
    if (!issns.length) continue;
    journals++;
    const q = r[iQ].trim();
    const entry = {
      title: cleanName(r[iTitle]),
      sjr: num(r[iSjr]),
      quartile: /^Q[1-4]$/.test(q) ? q : null,
      h_index: num(r[iH]),
      cites_per_doc_2y: num(r[iCpd]),
    };
    for (const issn of issns) if (!(issn in entries)) entries[issn] = entry;
  }
  const sorted = {};
  for (const k of Object.keys(entries).sort()) sorted[k] = entries[k];
  const doc = { generated: args.date, source: SJR_SOURCE, year, entries: sorted };
  let json = JSON.stringify(doc) + "\n";
  let droppedTitle = false;
  if (Buffer.byteLength(json) > MAX_SJR_BYTES) {
    for (const e of Object.values(sorted)) delete e.title;
    json = JSON.stringify(doc) + "\n";
    droppedTitle = true;
  }
  return { json, rows: body.length, journals, issns: Object.keys(sorted).length, droppedTitle };
}

// ---------- predatory ----------

const ISSN_RE = /\b(\d{4})-?(\d{3}[\dX])\b/i;

/** Names from the "Original list" and "Update" <ul> blocks of a beallslist.net page. */
function parseBeall(html) {
  const out = [];
  const start = html.search(/<h2[^>]*>\s*Original list\s*<\/h2>/i);
  if (start < 0) throw new Error("beallslist: 'Original list' heading not found");
  const content = html.slice(start);
  const lists = [];
  const ul1 = content.indexOf("<ul");
  lists.push(content.slice(ul1, content.indexOf("</ul>", ul1)));
  const upd = content.search(/<h2[^>]*>\s*Update\s*<\/h2>/i);
  if (upd >= 0) {
    const ul2 = content.indexOf("<ul", upd);
    lists.push(content.slice(ul2, content.indexOf("</ul>", ul2)));
  }
  for (const ul of lists) {
    for (const m of ul.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      const li = m[1];
      const a = li.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
      const raw = (a ? a[1] : li).replace(/<[^>]+>/g, "");
      let name = cleanName(raw);
      // A hijacked entry names the LEGITIMATE journal; tag it the way predatoryjournals.org does so a
      // bare-name match never flags the real journal.
      if (name && a && /hijack/i.test(li.replace(a[0], "")) && !/hijack/i.test(name)) {
        name += " (hijacker of a legitimate journal)";
      }
      const issn = decodeEntities(li.replace(/<[^>]+>/g, " ")).match(ISSN_RE);
      if (name) out.push({ name, issn: issn ? `${issn[1]}-${issn[2].toUpperCase()}` : null });
    }
  }
  return out;
}

/** Names from the predatoryjournals.org Google Sheet CSV export (columns: index, name). */
function parsePjSheet(csv) {
  return parseCsv(csv.replace(/^\ufeff/, ""))
    .map((r) => {
      const raw = r.length > 1 && /^\d+$/.test(r[0].trim()) ? r[1] : r[0];
      const name = cleanName(raw);
      const issn = (raw || "").match(ISSN_RE);
      return { name, issn: issn ? `${issn[1]}-${issn[2].toUpperCase()}` : null };
    })
    .filter((e) => e.name);
}

function finalize(items, withIssn) {
  const seen = new Map();
  for (const it of items) {
    const key = `${it.name.toLowerCase()}\u0000${it.source}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, it);
    else if (withIssn && !prev.issn && it.issn) prev.issn = it.issn;
  }
  return [...seen.values()]
    .map((e) =>
      withIssn
        ? { name: e.name, issn: e.issn ?? null, source: e.source }
        : { name: e.name, source: e.source },
    )
    .sort((a, b) => {
      const x = a.name.toLowerCase(),
        y = b.name.toLowerCase();
      if (x !== y) return x < y ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
    });
}

async function buildPredatory() {
  const [bp, bj, pp, pj] = await Promise.all([
    load(args["beall-publishers"]),
    load(args["beall-journals"]),
    load(args["pj-publishers"]),
    load(args["pj-journals"]),
  ]);
  const B = "beallslist.net",
    P = "predatoryjournals.org";
  const publishers = finalize(
    [
      ...parseBeall(bp).map((e) => ({ ...e, source: B })),
      ...parsePjSheet(pp).map((e) => ({ ...e, source: P })),
    ],
    false,
  );
  const journals = finalize(
    [
      ...parseBeall(bj).map((e) => ({ ...e, source: B })),
      ...parsePjSheet(pj).map((e) => ({ ...e, source: P })),
    ],
    true,
  );
  const json = JSON.stringify({ generated: args.date, journals, publishers }, null, 1) + "\n";
  return { json, journals: journals.length, publishers: publishers.length };
}

// ---------- main ----------

function assertAscii(name, s) {
  // eslint-disable-next-line no-control-regex -- the ASCII range is the check itself
  const i = s.search(/[^\x00-\x7f]/);
  if (i >= 0) throw new Error(`${name}: non-ASCII at offset ${i}`);
}

mkdirSync(args.out, { recursive: true });
if (!args["skip-sjr"]) {
  if (!args.csv)
    throw new Error("--csv <path to scimagojr YYYY.csv> is required (or pass --skip-sjr)");
  const r = buildSjr(args.csv);
  assertAscii("sjr.json", r.json);
  const p = join(args.out, "sjr.json");
  writeFileSync(p, r.json);
  console.log(
    `${p}: ${r.rows} rows, ${r.journals} journals with ISSN, ${r.issns} ISSN keys, ${statSync(p).size} bytes${r.droppedTitle ? " (titles dropped, over 8 MB)" : ""}`,
  );
}
if (!args["skip-predatory"]) {
  const r = await buildPredatory();
  assertAscii("predatory.json", r.json);
  const p = join(args.out, "predatory.json");
  writeFileSync(p, r.json);
  console.log(
    `${p}: ${r.journals} journals, ${r.publishers} publishers, ${statSync(p).size} bytes`,
  );
}
