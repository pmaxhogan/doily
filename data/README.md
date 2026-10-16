# data/

Committed reference snapshots. Regenerate with `scripts/refresh-snapshots.mjs` (steps in
`scripts/refresh-snapshots.md`). All text is folded to ASCII (diacritics stripped).

## sjr.json

- Source: SCImago Journal & Country Rank, https://www.scimagojr.com/journalrank.php?out=xls
  (the full journal ranking CSV, ranking year 2025).
- Retrieved: 2026-10-16, downloaded through a real browser session (the site is behind a Cloudflare
  challenge). 32,193 journal rows; 32,186 have at least one ISSN.
- Shape: `entries` is keyed by ISSN as 8 characters with no hyphen (`15424863`). A journal with
  several ISSNs (print and electronic) appears once per ISSN, 53,404 keys in total. If two journals
  share an ISSN, the higher-ranked one is kept. Fields: `title`, `sjr`, `quartile` (SJR best quartile,
  `null` when SCImago gives none), `h_index`, `cites_per_doc_2y`.
- Terms: the data comes from SCImago, which builds it from Scopus (Elsevier). Any user-facing use
  must credit "SCImago Journal & Country Rank" (SJR), with a link to https://www.scimagojr.com. The
  numbers are SCImago's; we only change the format.

## predatory.json

- Sources, retrieved 2026-10-16:
  - beallslist.net: an archived copy of Jeffrey Beall's lists (last updated by Beall in Dec 2016 / Jan
    2017), plus that site's "Update" sections. Publishers: https://beallslist.net/ ; journals:
    https://beallslist.net/standalone-journals/ .
  - predatoryjournals.org: the publisher and journal lists linked from
    https://www.predatoryjournals.org/the-list (served as embedded public Google Sheets).
- Counts: 4,295 journal entries and 2,704 publisher entries. One entry per name per source: a name
  on both lists appears twice, once per `source`. Names are trimmed, spaces collapsed, entities
  decoded, link notes like "(also here)" removed, and entries deduplicated case-insensitively within
  each source. `issn` is filled only when the source text includes one; neither source currently
  does, so it is `null` everywhere.
- Hijacked journals: a name ending in "(hijacker of a legitimate journal)" (or similar) is a fake
  site that copies a REAL journal's name. Never match such an entry against the bare name, or the
  legitimate journal gets flagged.
- These lists are evidence, never a verdict. They are opinions compiled by individuals, include
  stale and disputed entries, and do not cover journals that started after they were made. Being on
  a list is a reason to look closer, not proof; not being on a list proves nothing. Say where a flag
  came from when you show it ("listed on beallslist.net") instead of calling a journal predatory.
- Terms: both sites publish the lists for public reference. We store names only, not their
  commentary, and credit each entry by `source`.
