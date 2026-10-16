# doily

MCP server for unpaywalled access to research papers (biomed first) on
Cloudflare Workers, locked to one owner. The locked spec from the planning
interview is `.claude/doily-spec.md`; read it before changing tool behavior.

## Commands

- `npm run check` - the only definition of done: lint, typecheck, format,
  ASCII check, tests, dry-run build
- `npm test` / `npm run test:unit` / `npm run test:integration`
- `npm run test:live` - LIVE=1 suite against real upstream APIs (never in CI)
- `npm run dev` - wrangler dev on :8787 (needs .dev.vars)
- `npm run deploy` - remote D1 migrations then wrangler deploy (Workers Builds
  runs this on every push to main once connected)

## Layout

- `src/index.ts` - Worker entry: OAuth provider wrapping the MCP handler
- `src/mcp/` - tool registration (one file per tool group), respond helpers
- `src/providers/` - one client per upstream API, fetch injected
- `src/fulltext/` - the fallback chain, JATS and PDF to markdown, R2 cache
- `src/scihub/` - mirror discovery and PDF resolution
- `src/scinet/` - Sci-Net client and the SciNetRequest Durable Object
- `data/` - committed snapshots (SJR, predatory lists)
- `test/unit`, `test/integration`, `test/live`, `test/fixtures`

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
