# doily

MCP server for unpaywalled access to research papers (biomed first) on
Cloudflare Workers, locked to one owner. The locked spec from the planning
interview is `.claude/doily-spec.md`; read it before changing tool behavior.

## Commands

- `npm run check` - the only definition of done: lint, typecheck, format,
  ASCII check, tests, dry-run build
- `npm test` / `npm run test:unit` / `npm run test:integration`
- `npm run test:live` - LIVE=1 suite against real upstream APIs (never in CI)
- `npm run test:coverage` - vitest with text, json-summary and cobertura reports
- `npm run dev` - wrangler dev on :8787 (needs .dev.vars)
- `npm run typecheck` / `npm run lint` / `npm run format` / `npm run check:ascii`
- `npm run migrate:local` / `npm run migrate:remote` - D1 migrations
- `npm run snapshots:upload` - push `data/sjr.json` to R2 (`doily-pdfs/data/sjr.json`)
- `npm run deploy` - remote D1 migrations, snapshot upload, then wrangler deploy
  (Workers Builds runs this on every push to main once connected)

## Layout

- `src/index.ts` - Worker entry: static bearer check, then the OAuth provider
  wrapping the MCP handler; `/healthz` and `/authorize` as the default handler
- `src/auth/` - Cloudflare Access JWT check, static bearer, OAuth provider config
- `src/consent/` - the `/authorize` consent page, CSRF checks
- `src/mcp/` - stateless MCP handler, server setup, `doily://pdf/{+doi}` resource
- `src/tools/` - one module per tool group (`search`, `paper`, `author`,
  `journal`, `request`), the shared `ToolDef`/`ToolError` types, and the registry
  in `index.ts`
- `src/providers/` - one client per upstream API (PubMed, Europe PMC, OpenAlex,
  Semantic Scholar, Crossref, Unpaywall, bioRxiv, CORE), fetch injected
- `src/search/` - query translation and the fan-out merge/dedup
- `src/fulltext/` - JATS and PDF to markdown, text paging, R2 cache, signed
  download links
- `src/scihub/` - mirror list, page parsing, resolution, optional fetch proxy
- `src/scinet/` - Sci-Net client and state machine, the SciNetRequest Durable
  Object, request tokens, daily spend ledger
- `src/lib/` - shared HTTP helper with polite headers, rate limiting, snapshot
  lookups, text utilities
- `src/ids.ts`, `src/env.ts`, `src/healthz.ts` - identifier resolution, the Env
  type, the public health report
- `migrations/` - D1 schema
- `data/` - committed snapshots (SJR, predatory lists); `scripts/` refreshes them
- `docs/` - `setup.md` (self-hosting) and `tools.md` (tool reference)
- `test/unit`, `test/integration` (workerd), `test/live` (LIVE=1 only),
  `test/fixtures` (recorded upstream responses)

## Conventions

- ASCII only. Conventional Commits. ESM with `.ts` relative imports.
- Secrets live in Worker secrets or `.dev.vars`; the repo is public.
- Pin `agents`, `@modelcontextprotocol/*` and `@cloudflare/workers-oauth-provider`
  exactly; bump them on purpose.
- No eslint-disable without a comment explaining why.
- Every push to main deploys; run `npm run check` first.

<!-- stack:begin (managed by the stack plugin; edit via /stack:remember or by hand, keep the markers) -->

## Stack

- scope: pmaxhogan
- mode: auth.web.extra-password=no
- mode: deploy.target=workers
- mode: deps.dependabot-mechanism=native
- mode: stack.type=node-ts
- mode: test.coverage-ratchet=ruleset

<!-- stack:end -->
