# doily

An MCP server that gives an AI agent unpaywalled access to research papers,
biomedical sciences first. It runs on Cloudflare Workers, is locked to a single
owner, and is MIT licensed.

An agent can search the literature, pull merged metadata, judge a journal or an
author, and read the full text of a paper through a fallback chain that tries
every open-access route before it reaches Sci-Hub and, as a last resort, posts a
Sci-Net bounty request and waits for it to be fulfilled.

## Tools

Nine tools, all returning JSON text. Arguments, return shapes and errors are in
[docs/tools.md](docs/tools.md).

| Tool               | Purpose                                                                                      | Example call                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `search_papers`    | Search Europe PMC, OpenAlex and Semantic Scholar in parallel; merged and deduplicated        | `{"query": "CRISPR AND malaria", "from_year": 2020, "sort": "citations"}` |
| `get_paper`        | Merged metadata for one paper: abstract, authors, OA links, MeSH, retraction status, journal | `{"id": "10.1038/nature12373"}`                                           |
| `get_author`       | OpenAlex author profile: works, citations, h-index, topics, affiliations, ORCID              | `{"id_or_name": "Mikhail Lukin"}`                                         |
| `get_journal`      | Journal signals: OpenAlex stats, SJR snapshot, predatory-list evidence                       | `{"issn_or_name_or_doi": "0028-0836"}`                                    |
| `get_full_text`    | Full text as markdown through the fallback chain, paged at 60000 characters                  | `{"id": "10.1038/nature12373", "offset": 0}`                              |
| `get_pdf`          | The same chain, returning a one-hour download link and a `doily://pdf/<doi>` resource        | `{"id": "10.1038/nature12373"}`                                           |
| `request_paper`    | Post (or join) a Sci-Net bounty request for a paper nothing else can deliver                 | `{"id": "10.1038/nature12373"}`                                           |
| `wait_for_request` | Long-poll a Sci-Net request; on success returns the first page of text                       | `{"request_id": "10.1038/nature12373", "max_wait_seconds": 60}`           |
| `list_requests`    | Every Sci-Net request with state and timestamps, plus today's spend against the daily cap    | `{"status": "pending"}`                                                   |

Every tool except `request_paper` is read-only and says so in its annotations.

## Full-text fallback chain

`get_full_text` and `get_pdf` walk these sources in order and stop at the first
that delivers. Every hop is short-circuited by an R2 cache, and anything fetched
is cached indefinitely.

1. PMC / Europe PMC JATS XML (Europe PMC full-text XML, NCBI efetch from
   `db=pmc`, BioC JSON). Only NCBI and Europe PMC APIs are used; PMC HTML is
   never scraped.
2. Unpaywall: the best open-access location, then the others.
3. OpenAlex and Semantic Scholar open-access links.
4. bioRxiv / medRxiv.
5. CORE (skipped when no `CORE_API_KEY` is set).
6. Sci-Hub.
7. A Sci-Net request token. `get_full_text` never posts a request by itself; it
   returns a `request_token` and the agent decides whether to call
   `request_paper`.

Any PDF is checked for the `%PDF` magic bytes. PDF text comes from `unpdf`, with
Workers AI `toMarkdown()` as the fallback for failures and scanned pages.

## Legal note

Sci-Hub and Sci-Net are enabled by default. Whether retrieving a paper through
them is lawful depends on where you are and what you do with it, and both are
blocked in some countries. You are responsible for your own use. Everything
above them in the chain (steps 1 to 5) is open access.

## Journal signals

`get_journal`, and the `journal` block inside `get_paper`, report evidence and
leave the judgement to the reader:

- **Impact proxy.** OpenAlex's `2yr_mean_citedness` (the mean citations that the
  last two years of the journal's works have received) stands in for an impact
  factor, alongside h-index, DOAJ membership, `is_core`, `listed_in` and the APC.
- **SJR.** A committed snapshot of the SCImago Journal Rank (`sjr`, quartile,
  year), credited to SCImago. Refreshed by hand about once a year.
- **Predatory lists.** Matches against snapshots of Beall's list and
  predatoryjournals.org are returned as `listed_on: [...]` with the source named.
  This is evidence, never a verdict: the lists are opinions, include stale and
  disputed entries, and miss newer journals. Absence proves nothing.
- **Retractions.** `get_paper` reports Crossref update-to relations, which carry
  Retraction Watch data, as retracted, corrected or concern notices.

## Quick start: Claude Code

Once doily is deployed (see [Self-hosting](#self-hosting)):

```sh
claude mcp add --transport http -s user doily https://<your-host>/mcp
```

Then run `/mcp` inside a session and finish the OAuth consent in the browser tab
it opens. The consent page sits behind Cloudflare Access, so sign in as the owner
when asked.

To skip OAuth and use the static bearer instead:

```sh
claude mcp add --transport http -s user doily https://<your-host>/mcp \
  --header "Authorization: Bearer <your DOILY_BEARER value>"
```

## Quick start: claude.ai

1. In claude.ai, open **Settings > Connectors > Add custom connector**.
2. Enter the server URL `https://<your-host>/mcp` (no trailing slash).
3. Leave the OAuth client ID and secret fields empty. claude.ai registers itself
   through dynamic client registration, then sends your browser to the consent
   page. Sign in through Cloudflare Access and approve.

Alternatively, paste `Authorization: Bearer <your DOILY_BEARER value>` under
**Request headers** and skip OAuth entirely.

Other MCP clients that speak streamable HTTP and OAuth 2.1 with PKCE work the
same way.

## Self-hosting

doily is built to be deployed by its owner onto their own Cloudflare account:
one Worker, one D1 database, one R2 bucket, two KV namespaces, one Durable
Object class, and a Cloudflare Access application in front of the consent page.
The full walk-through, including every secret and the optional Sci-Hub proxy, is
in [docs/setup.md](docs/setup.md).

Upstream API keys (NCBI, OpenAlex, Semantic Scholar, CORE) are all optional;
every path works without them, only slower or with fewer sources.

## Development

```sh
npm ci
npm run check        # lint, typecheck, format, ASCII, tests, dry-run build
npm test             # unit and integration suites
npm run test:unit
npm run test:integration
npm run test:live    # LIVE=1, hits real upstream APIs, never in CI
npm run dev          # wrangler dev on :8787 (needs .dev.vars)
```

Copy `.dev.vars.example` to `.dev.vars` for local runs. See
[CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [SECURITY.md](SECURITY.md)
for the auth model and how to report a vulnerability. The locked design spec is
`.claude/doily-spec.md`.

## License

MIT. See [LICENSE](LICENSE). SJR data is credited to SCImago Journal & Country
Rank; see [data/README.md](data/README.md) for the terms of each snapshot.
