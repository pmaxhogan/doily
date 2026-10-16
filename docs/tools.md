# Tools

doily registers nine tools on its MCP endpoint. Every tool returns a single JSON
text block. Arguments are validated with zod before the handler runs.

`get_full_text` and `get_pdf` are described here as specified in
`.claude/doily-spec.md`; their handlers were not in the tool registry at the
time of writing, so their return shapes are marked "as specified" and may gain
fields.

## Errors

A failure is a tool result with `isError: true` and a JSON body:

```json
{
  "error": "Europe PMC returned HTTP 503",
  "source": "europepmc",
  "status": 503,
  "body_excerpt": "<first part of the upstream body, secrets scrubbed>"
}
```

`error` is always present. `source`, `status` and `body_excerpt` appear when the
failure came from an upstream API, and some tools add their own fields (for
example `providers` on `search_papers`, or `cap` and `day` on `request_paper`).
Secrets and URLs that embed them are never included.

## Paging and the `attempts` log

`get_full_text` returns at most 60000 characters per call. Cuts are made at a
paragraph break when one falls in the second half of the window, otherwise at a
sentence end, otherwise at whitespace. When more text remains the result has
`next_offset`; pass it back as `offset` to read the next page. Concatenating
every page in order reproduces the full text with no gap or overlap.
`wait_for_request` returns the first page only; call `get_full_text` with an
`offset` for the rest.

`attempts` is a log of every hop the chain tried, in order:

```json
[
  { "source": "europepmc", "outcome": "no_pmcid", "ms": 212 },
  { "source": "unpaywall", "outcome": "ok", "ms": 340 }
]
```

It is returned on success and on failure, so an agent can see why each source
was skipped. (The outcome strings above are illustrative.)

## The request_token flow

```text
get_full_text(id)          -> { status: "unavailable", attempts, request_token }
request_paper(token)       -> { request_id, status: "pending", eta_hint }
wait_for_request(request_id, max_wait_seconds)
                           -> { status: "ready", text, ... } or still "pending"
```

`request_token` is an HMAC of the DOI, so `get_full_text` creates no state.
`request_paper` accepts either the token or a plain DOI and re-runs the
open-access chain first, refusing if the paper is obtainable after all. Requests
expire after 72 hours.

## search_papers

Search Europe PMC, OpenAlex and Semantic Scholar in parallel, plus PubMed when
the query uses PubMed field tags such as `[mh]` or `[tiab]`. Results are
deduplicated by DOI, then PMID, then normalized title. Boolean operators, quoted
phrases and fielded terms (`AUTH:`, `MESH:`, `SRC:PPR`, `OPEN_ACCESS:y`) are
passed to providers that support them and stripped for the rest.

| Argument    | Type                                                                    | Notes                                                    |
| ----------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `query`     | string, 1-1000 chars                                                    | Free text, boolean, or PubMed syntax                     |
| `from_year` | integer 1800-2100, optional                                             | Earliest publication year, inclusive                     |
| `to_year`   | integer 1800-2100, optional                                             | Latest publication year, inclusive                       |
| `sort`      | `relevance`, `date` or `citations`, optional                            | Default `relevance`; `date` is newest first              |
| `sources`   | array of `europepmc`, `openalex`, `semanticscholar`, `pubmed`, optional | Default: all applicable                                  |
| `limit`     | integer 1-100, optional                                                 | Default 20                                               |
| `offset`    | integer 0-199, optional                                                 | Default 0; each provider contributes at most its top 200 |

Returns:

```json
{
  "query": "CRISPR AND malaria",
  "sort": "relevance",
  "offset": 0,
  "limit": 20,
  "count": 20,
  "merged_candidates": 143,
  "results": [
    {
      "doi": "10.1038/...",
      "title": "...",
      "authors": ["First A", "Second B", "Third C"],
      "author_count": 12,
      "journal": "...",
      "year": 2021,
      "pmid": "...",
      "pmcid": "PMC...",
      "citation_count": 31,
      "oa_status": "gold",
      "abstract": "first 300 characters...",
      "sources": ["europepmc", "openalex"]
    }
  ],
  "providers": { "europepmc": { "status": "ok" } }
}
```

`providers` reports per-provider status. The call fails only when every provider
failed. `from_year` after `to_year` is an error.

Example: `{"query": "CRISPR AND malaria", "from_year": 2020, "sort": "citations", "limit": 10}`

## get_paper

Merged metadata for one paper, gathered in parallel from Crossref, Europe PMC,
OpenAlex, Semantic Scholar, Unpaywall and (for preprint DOIs) bioRxiv/medRxiv.

| Argument | Type                 | Notes                                                                                                  |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`     | string, 1-1000 chars | DOI, PMID, PMCID, arXiv id, a URL containing one, or an exact title (title match via Semantic Scholar) |

Returns an object with:

- `ids`: `doi`, `pmid`, `pmcid`, `arxiv`, `openalex`, `s2` where known.
- `title`, `abstract` (the longest available), `authors` (the richest list, with
  affiliations and ORCIDs), `author_count`.
- `venue`: `name`, `issn`, `publisher`, `volume`, `issue`, `pages`.
- `publication_date`, `year`, `type`.
- `open_access`: `is_oa`, `oa_status`, `best_url`, `pdf_url`, `landing_page_url`,
  `license`, `version`, `host_type`, `in_pmc`, up to five `locations`,
  `tdm_links`.
- `citation_count` (the maximum across providers) and `citation_counts` per
  provider.
- `mesh`: MeSH terms.
- `retraction`: `status` (`none`, `retracted`, and so on), `is_notice`, `notices`,
  and `openalex_is_retracted`.
- `preprint`: bioRxiv/medRxiv details when the DOI is a preprint.
- `journal`: the same block `get_journal` returns, or `null`.
- `field_sources`: which provider each field group came from.
- `upstream`: per-provider status (`ok`, `not_found`, `skipped`, or
  `{ error, status? }`).

Fails when the identifier cannot be resolved or no provider knows the paper.

Example: `{"id": "10.1038/nature12373"}`

## get_author

An OpenAlex author profile.

| Argument     | Type                | Notes                                                     |
| ------------ | ------------------- | --------------------------------------------------------- |
| `id_or_name` | string, 1-300 chars | OpenAlex author id (`A5086778667`), ORCID, or a full name |

Returns works count, cited-by count, h-index, i10-index, top topics,
affiliations, ORCID and `source: "openalex"`. A name lookup returns the top
OpenAlex match plus `match` and `other_matches` (OpenAlex id, name, works count,
cited-by count, institution) so namesakes can be told apart. An unknown id or
name is an error with `status: 404`.

Example: `{"id_or_name": "Mikhail Lukin"}`

## get_journal

Journal quality signals.

| Argument              | Type                | Notes                                                                   |
| --------------------- | ------------------- | ----------------------------------------------------------------------- |
| `issn_or_name_or_doi` | string, 1-500 chars | ISSN, OpenAlex source id (`S137773608`), a paper DOI, or a journal name |

Returns:

- `name`, `openalex_id`, `issn_l`, `issns`, `publisher`, `type`, `homepage_url`,
  `country`.
- `impact`: `two_year_mean_citedness` (the impact proxy), `h_index`, `i10_index`,
  `works_count`, `cited_by_count`.
- `open_access`: `is_oa`, `is_in_doaj`, `apc_usd`.
- `is_core`, `listed_in`.
- `sjr`: `{ sjr, quartile, h_index, year, issn }` from `data/sjr.json`, or
  `null`.
- `predatory`: `{ listed_on: [...], note }`. Evidence from watch-list snapshots,
  matched by ISSN or exact name; never a verdict.
- `sources`: where each part came from, including the snapshot's generation date.

A name search adds `other_matches`. If OpenAlex finds no source by that name, the
snapshot evidence is still returned with a `note`.

Example: `{"issn_or_name_or_doi": "0028-0836"}`

## get_full_text

As specified. Walks the [fallback chain](../README.md#full-text-fallback-chain)
and returns markdown text: section headings, tables as markdown tables, figures
as captions, and references stripped unless requested.

| Argument             | Type    | Notes                                               |
| -------------------- | ------- | --------------------------------------------------- |
| `id`                 | string  | DOI, PMID, PMCID, arXiv id, or a URL containing one |
| `offset`             | integer | Default 0                                           |
| `include_references` | boolean | Default false                                       |

Success:

```json
{
  "source": "europepmc",
  "format": "jats",
  "text": "# Title\n...",
  "total_chars": 84210,
  "offset": 0,
  "next_offset": 59873,
  "attempts": [{ "source": "europepmc", "outcome": "ok", "ms": 412 }]
}
```

`format` is `jats` or `pdf`. Total failure:

```json
{ "status": "unavailable", "attempts": [], "request_token": "..." }
```

Pass `request_token` to `request_paper`. See
[the request_token flow](#the-request_token-flow).

## get_pdf

As specified. Runs the same chain and returns the PDF as a link and a resource.

| Argument | Type   | Notes                  |
| -------- | ------ | ---------------------- |
| `id`     | string | As for `get_full_text` |

```json
{
  "source": "unpaywall",
  "url": "https://<your-host>/download/10.1038/nature12373?exp=1760000000&sig=...",
  "resource_uri": "doily://pdf/10.1038/nature12373",
  "size_bytes": 4120331,
  "pages": 8
}
```

`url` is a signed link to the Worker's own `/download` route, valid for one
hour. PDFs over 50 MB are refused. The same file is readable as the MCP resource
`doily://pdf/{+doi}` (for example `doily://pdf/10.1038/nature12373`), served
from R2 behind the same authentication as the tools.

## request_paper

Post a Sci-Net bounty request for a paper no open source can deliver, or join
Sci-Net's existing request for it. Returns at once; poll with
`wait_for_request`. This is the only tool that is not read-only.

| Argument | Type                       | Notes                                                                |
| -------- | -------------------------- | -------------------------------------------------------------------- |
| `id`     | string                     | A DOI, or the `request_token` from `get_full_text`                   |
| `bounty` | positive integer, optional | Sci-Net tokens. Defaults to, and may not exceed, `SCINET_BOUNTY` (2) |

Behavior:

- Refuses (error `obtainable`, with `source` and a hint) when the open-access
  chain can already get the paper.
- Refuses when the bounty exceeds the configured maximum; it is never raised.
- Refuses when today's cap of new requests (`SCINET_DAILY_CAP`, default 5, UTC
  day) is used up. Joining an existing Sci-Net request does not use a slot.
- Fails when `SCINET_USER` / `SCINET_PASS` are unset.
- One request per DOI: a repeat call for a live request returns
  `existing: true`.

Returns:

```json
{
  "request_id": "10.1038/nature12373",
  "status": "pending",
  "eta_hint": "usually hours, sometimes under 30 minutes",
  "joined_existing": false
}
```

Example: `{"id": "10.1038/nature12373"}`

## wait_for_request

Long-poll a request for up to `max_wait_seconds`.

| Argument           | Type                    | Notes                          |
| ------------------ | ----------------------- | ------------------------------ |
| `request_id`       | string                  | From `request_paper` (the DOI) |
| `max_wait_seconds` | integer 0-120, optional | Default 60                     |

While the request is not ready, returns its summary: `request_id`, `doi`,
`status` (`pending`, `ready`, `expired`, `failed` or `needs_owner`),
`created_at`, `updated_at`, `attempts`, `bounty`, and when known
`scinet_request_id` (the DOI; Sci-Net addresses requests by DOI),
`joined_existing`, `ready_at`, `verified`, `verify_note`, `last_error`.
Sci-Net shows no upload time and no verify control, so `uploaded_at` is not
set and a request is `verified` once its PDF passes the sanity check. `needs_owner` means a file arrived but failed the sanity check and
was left unverified for the owner to look at.

When ready, the summary also carries `source: "sci-net"`, `format: "pdf"`,
`pdf_resource` (`doily://pdf/<doi>`), `text` (the first 60000 characters),
`total_chars`, `offset: 0` and `next_offset` when more remains.

Fails if no request exists for that DOI.

Example: `{"request_id": "10.1038/nature12373", "max_wait_seconds": 60}`

## list_requests

Every request made with `request_paper`, newest first.

| Argument | Type                                                               | Notes  |
| -------- | ------------------------------------------------------------------ | ------ |
| `status` | `pending`, `ready`, `expired`, `failed` or `needs_owner`, optional | Filter |

Returns `{ requests: [...summary], spend_today: { day, requests, tokens, cap } }`
where each summary has the fields described under `wait_for_request`.

Example: `{"status": "pending"}`
