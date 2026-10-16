# Refreshing the data snapshots

`data/sjr.json` and `data/predatory.json` are committed snapshots. Refresh them about once a year
(SCImago publishes a new ranking year in spring), or when the predatory lists change.

## 1. Download the SCImago CSV (manual, in a browser)

SCImago sits behind a Cloudflare challenge, so a plain `fetch`/`curl` gets a challenge page instead of
data. Open this in a normal browser:

    https://www.scimagojr.com/journalrank.php?out=xls

It downloads `scimagojr <year>.csv` (semicolon-separated, decimal commas, about 11 MB, about 32k rows).
If the direct link does not download, open https://www.scimagojr.com/journalrank.php and use the
"Download" button (no filters, latest year).

## 2. Run the script

    node scripts/refresh-snapshots.mjs --csv "C:/Users/<you>/Downloads/scimagojr 2026.csv"

By default the predatory lists are fetched live:

- https://beallslist.net/ (publishers) and https://beallslist.net/standalone-journals/ (journals):
  both the "Original list" and the "Update" sections.
- predatoryjournals.org: its list pages (`/the-list/publishers`, `/the-list/journals`) embed two
  public Google Sheets; the script reads their CSV exports. If the site moves to new sheets, take the
  new ids from the `docs.google.com/spreadsheets/d/<id>/htmlembed` URLs in the page HTML and pass
  `--pj-publishers <url-or-file>` / `--pj-journals <url-or-file>`.

Every source can be a saved file instead of a URL (`--beall-publishers page.html`, etc.), and
`--date YYYY-MM-DD` pins the `generated` field, so a run is reproducible from saved inputs.
`--skip-sjr` / `--skip-predatory` refresh one file only. The year is read from the CSV header
(`Total Docs. (YYYY)`); override with `--year`.

## 3. Check and commit

    node scripts/check-ascii.mjs

The script itself refuses to write a non-ASCII byte. Update the dates and counts in `data/README.md`,
then delete the downloaded CSV (it is not committed).
