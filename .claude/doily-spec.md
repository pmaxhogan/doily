# doily - locked spec (ultraquest interview, 2026-10-16)

doily is an MIT-licensed MCP server on Cloudflare Workers that gives an AI
agent unpaywalled access to research papers, biomed first: search, metadata,
journal and author signals, and full text through a fallback chain that ends
at Sci-Hub and a Sci-Net bounty request. It is locked to one owner.

Every decision below is LOCKED by the owner's interview answers. Implementers
must NOT re-ask any of them. Gaps are the orchestrator's call; record such
calls in the final report, never ask the owner.

## 1. Platform and shape

- Repo: github.com/pmaxhogan/doily, public, MIT, scaffolded by /stack:new
  (stack scope pmaxhogan, node-ts on Cloudflare Workers). Standards: TypeScript
  ESM, Node 26, npm with lockfile, ESLint flat + Prettier (2-space, double
  quotes, semicolons), vitest with json-summary + cobertura coverage, ASCII
  only (no em dashes, no smart quotes), LF endings, Conventional Commits.
- Hostname: doily.maxhogan.dev (custom domain on the maxhogan.dev zone),
  workers_dev false, preview_urls false.
- Runtime: stateless `createMcpHandler` from `agents/mcp/server` with
  `@modelcontextprotocol/server` 2.x and zod. No McpAgent. Streamable HTTP at
  POST /mcp. Pin `agents` and the MCP packages exactly (healthy convention).
- Bindings (wrangler.jsonc, nodejs_compat): D1 `DB` (database doily), R2
  `PDFS` (bucket doily-pdfs), KV `DOILY_KV`, KV `OAUTH_KV` (required name for
  workers-oauth-provider), Durable Object `SCINET_REQUEST` (class
  SciNetRequest, SQLite-backed, migration v1), Workers AI `AI`, cron
  `0 6 1 1 *` (yearly snapshot reminder, logs only), `limits.cpu_ms` 300000,
  observability enabled.
- Clients: Claude Code (`claude mcp add --transport http -s user doily
https://doily.maxhogan.dev/mcp`) and claude.ai custom connectors (OAuth or
  a static Request header). Keep the server spec-plain so other clients work.

## 2. Auth (locked)

- Primary: `@cloudflare/workers-oauth-provider` (OAuth 2.1, PKCE, dynamic
  client registration) exactly as pmaxhogan/healthy does it
  (`worker/src/index.ts` header comment there explains the layering).
  `/authorize` (the consent page) sits behind Cloudflare Access; `/mcp`,
  `/oauth/token`, `/oauth/register`, `/.well-known/*` bypass Access. One
  scope: `papers`. No extra password page.
- Secondary: a static bearer token (Worker secret `DOILY_BEARER`) accepted on
  /mcp with a constant-time compare, for curl verification and scripts.
- /healthz is unauthenticated and returns booleans only (mirror reachable,
  sci-net login ok, upstream api ok), never URLs or secrets.

## 3. Tool surface (9 tools, snake_case)

All tools return JSON text content. Read-only tools carry
`annotations.readOnlyHint: true`. Every tool description includes one example
call. Errors are verbose to the agent (upstream status plus a body excerpt,
never secrets) and structured: `{ error, source?, attempts? }`.

1. `search_papers(query, from_year?, to_year?, sort? = relevance|date|
citations, sources?: string[], limit? = 20 (max 100), offset?)`
   - Fan-out in parallel to Europe PMC, OpenAlex and Semantic Scholar (and
     PubMed esearch when the query looks like PubMed syntax), dedup by
     DOI then PMID then normalized title, merge.
   - Free text works everywhere; AND/OR/NOT, quoted phrases and fielded
     terms are passed through to providers that support them (Europe PMC,
     OpenAlex, S2 bulk) and stripped for the rest.
   - Each hit: doi, title, authors (first 3 + author_count), journal, year,
     pmid, pmcid, citation_count, oa_status, abstract (first ~300 chars),
     sources (which providers returned it).
2. `get_paper(id)` - id is a DOI, PMID, PMCID, arXiv id, or a URL containing
   one; a bare title falls back to Semantic Scholar /paper/search/match.
   Returns ids, title, full abstract, all authors with affiliations, venue,
   publication date, type, OA status and links, citation count, MeSH terms,
   retraction/correction status (Crossref update-to, Retraction Watch), and
   an inline `journal` block identical to get_journal. Each field notes its
   source. Metadata merged from OpenAlex (by DOI, free), Crossref (polite
   pool, mailto), Europe PMC.
3. `get_author(id_or_name)` - OpenAlex author: works count, cited by count,
   h-index, i10, top topics, affiliations, ORCID.
4. `get_journal(issn_or_name_or_doi)` - OpenAlex source stats
   (2yr_mean_citedness as the impact proxy, h_index, is_in_doaj, is_core,
   listed_in, is_oa, apc_usd), SJR snapshot (sjr, quartile, year) from
   data/sjr.json, predatory heuristic from data/predatory.json reported as
   `listed_on: [...]` evidence, never a verdict.
5. `get_full_text(id, offset? = 0, include_references? = false)` - walks the
   chain (section 4). Returns `{ source, format: "jats"|"pdf", text,
total_chars, offset, next_offset?, attempts: [{source, outcome, ms}] }`.
   Text is markdown: section headings, tables as markdown tables, figures as
   captions, references stripped unless include_references. Capped at 60000
   chars per call with offset paging. On total failure: `{ status:
"unavailable", attempts, request_token }` where request_token is an HMAC
   of the DOI (no state created) usable by request_paper.
6. `get_pdf(id)` - same chain; returns `{ source, url (R2 presigned, ~1h),
resource_uri: "doily://pdf/<doi>", size_bytes, pages? }`. Also registered
   as an MCP resource template `doily://pdf/{doi}` served from R2 (auth
   required). PDFs over 50 MB are refused.
7. `request_paper(id_or_request_token, bounty? = 2)` - Sci-Net request.
   Re-runs the OA chain first and refuses if the paper is obtainable. One
   open request per DOI. If Sci-Net already has an open request for the DOI,
   join it instead of posting. Bounty fixed at 2 tokens, never auto-raised;
   hard cap 5 new requests per UTC day (env SCINET_DAILY_CAP). Creates a
   SciNetRequest DO keyed by DOI. Returns `{ request_id, status: "pending",
eta_hint: "usually hours, sometimes under 30 minutes" }`.
8. `wait_for_request(request_id, max_wait_seconds? = 60 (max 120))` - long
   polls the DO; returns `{ status: ready|pending|expired|failed, ... }` and
   on ready the same payload as get_full_text (first page) plus pdf url.
9. `list_requests(status?)` - all requests with state and timestamps.

## 4. Full-text chain (locked order)

1. PMC / Europe PMC JATS XML (Europe PMC `/{PMCID}/fullTextXML`, NCBI efetch
   db=pmc, BioC JSON). Only NCBI APIs; scraping pmc.ncbi.nlm.nih.gov HTML is
   prohibited.
2. Unpaywall `https://api.unpaywall.org/v2/{doi}?email=` ->
   best_oa_location.url_for_pdf, then other oa_locations.
3. OpenAlex `open_access.oa_url` / best_oa_location; Semantic Scholar
   `openAccessPdf.url`.
4. bioRxiv / medRxiv (api.biorxiv.org details -> JATS path or .full.pdf).
5. CORE v3 downloadUrl / fullText (needs CORE_API_KEY; skip if unset).
6. Sci-Hub (section 5).
7. Sci-Net request token (never auto-posted by get_full_text).

Every hop is short-circuited by the cache: R2 object `pdf/<doi>.pdf` and
`text/<doi>.md`, KV metadata with a 7-day TTL. Cache everything, including
Sci-Hub and Sci-Net PDFs, indefinitely. Any PDF is validated by the `%PDF`
magic bytes. PDF text: unpdf (`getDocumentProxy` + `extractText`) first,
Workers AI `env.AI.toMarkdown()` as fallback for failures or scanned PDFs.

## 5. Sci-Hub resolver (enabled by default)

- Mirror list, env-overridable (SCIHUB_MIRRORS): sci-hub.ru, sci-hub.ee,
  sci-hub.ren, sci-hub.al; plus auto-discovery from a mirror-list page
  (SciDownl style, e.g. the sci-hub.ru front page links and a configurable
  SCIHUB_MIRROR_LIST_URL), merged and health-checked, working mirror cached
  in KV for one hour.
- Resolution: GET https://<mirror>/<doi>; detect DDoS-Guard / "Checking
  your browser" / captcha pages and move on; parse in order:
  `<meta name="citation_pdf_url">`, `object[data]`, `embed[src]`,
  `iframe#pdf[src]`, `onclick="location.href='...'"`; unescape `\/`, resolve
  relative URLs, strip `#fragment`, fetch, verify `%PDF`.
- Third-party mirrors (.ee/.ren/.al) serve `https://sci.bban.top/pdf/<DOI>.pdf`;
  try that direct pattern too.
- Workers egress may be challenged. After the first deploy, probe from the
  live Worker. If blocked: build a bearer-gated fetch proxy Custom App on
  mnmserver (pattern: tracked-fetch-proxy; `sudo midclt call app.create`),
  env SCIHUB_PROXY_URL + SCIHUB_PROXY_TOKEN, and route Sci-Hub (and Sci-Net
  if needed) through it. Only if blocked.

## 6. Sci-Net (enabled by default)

- No public API. Login is `POST /` with `action=login`, `user`, `pass`
  (cookie session). Everything else is behind login and must be captured by
  a browser subagent using the owner's real Chrome (claude-in-chrome, owner
  already logged in): the /request form POST (fields, endpoint), the
  requests list page, how fulfilment is shown, the verify action, and the
  "existing request for this DOI" check.
- Secrets: SCINET_USER, SCINET_PASS (owner sets them with `npx wrangler
secret put`; the run pushes the exact commands).
- SciNetRequest DO per DOI: alarm every 5 minutes, on fulfilment download
  the PDF to R2, extract text, sanity check (`%PDF` and the DOI or title
  found in the text), then mark the request ready. Capture note (2026-10-16):
  Sci-Net shows no verify control on solved requests, so there is nothing to
  confirm; `verifyUpload` is a no-op. If the sanity check fails, mark
  `needs_owner`.
  Expire after 72 hours.
- During the build run at most ONE real request is posted, for verification.

## 7. Providers and keys

- Polite headers everywhere: `User-Agent: doily/<version>
(https://github.com/pmaxhogan/doily; mailto:pmaxhogan@gmail.com)`,
  `mailto=` on Crossref, `email=` on Unpaywall.
- Per-provider token buckets in KV: Crossref 3/s lists 10/s singles, NCBI
  10/s with key else 3/s, OpenAlex 30/s with key, S2 1/s with key, Europe
  PMC 5/s, DOAJ 2/s. OpenAlex spend tracked from `meta.cost_usd` per day in
  KV; stop keyword searches at 90% of the daily budget and fall back to
  Europe PMC + S2.
- Keys (Worker secrets, optional, all paths work unkeyed): NCBI_API_KEY,
  OPENALEX_API_KEY, S2_API_KEY, CORE_API_KEY. Signups happen in the owner's
  Chrome during wave 3.
- Google Scholar: not used.

## 8. Data snapshots (data/)

- data/sjr.json: trimmed SCImago CSV (issn -> sjr, quartile, h_index, year),
  fetched once via the owner's Chrome (Cloudflare challenge blocks curl).
- data/predatory.json: journals and publishers scraped from beallslist.net
  and predatoryjournals.org with the source and the scrape date.
- Yearly cron only logs a reminder; refresh is `scripts/refresh-snapshots.md`
  as a manual step.

## 9. Tests and CI

- Unit (vitest, node): every provider parser and the merge/dedup/markdown
  logic against committed fixtures in test/fixtures (trimmed real responses
  for 10.1038/nature12373, one OA PMC article picked by the fixture
  recorder, one bioRxiv DOI; Sci-Hub HTML fixtures from the research probes
  under C:\Users\pmaxh\AppData\Local\Temp\claude\scires\). fetch is injected
  (deps object), never global.
- Integration (vitest project `integration`, @cloudflare/vitest-plugin,
  reads wrangler.jsonc, dummy secrets): exercises POST /mcp end to end with
  stubbed upstreams, auth paths (bearer ok, bearer wrong = 401, no auth =
  401), /healthz, resource read.
- LIVE=1 suite hits real APIs locally; skipped in CI.
- CI: stack ci/node-ts (tsc, eslint, prettier --check, check-ascii, vitest
  coverage) plus gitleaks. Coverage ratchet per repo detect. Workers Builds
  deploys on push to main (dashboard connect is on the owner checklist;
  until then `npx wrangler deploy` from the run).
- Main unprotected during the build; one protect flip at the end.

## 10. Process rules for implementers

- Work in your own git worktree; commit with Conventional Commits; never
  push - the orchestrator rebases and pushes main.
- `npm run check` (lint, typecheck, test, build) must pass before you report.
- Never log secrets. No eslint-disable without a comment.
- ASCII only in every file.
- Do not ask the owner anything. Decide, note the decision in your report.
