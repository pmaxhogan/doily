# doily

An MCP server that gives an AI agent unpaywalled access to research papers,
biomedical sciences first. It runs on Cloudflare Workers and is locked to a
single owner.

Status: scaffold. The tool surface, fallback chain and setup guide are
specified in `.claude/doily-spec.md` and land over the next commits.

## What it does

- `search_papers` across Europe PMC, OpenAlex and Semantic Scholar, merged and
  deduplicated, with boolean pass-through where the provider supports it.
- `get_paper`, `get_author`, `get_journal`: metadata, citation counts, MeSH
  terms, retraction status, and journal quality signals (OpenAlex stats, SJR
  snapshot, predatory-list evidence).
- `get_full_text` and `get_pdf` walk a chain: PMC / Europe PMC JATS, Unpaywall,
  OpenAlex and Semantic Scholar open-access links, bioRxiv, CORE, Sci-Hub, and
  finally a Sci-Net bounty request (`request_paper`, `wait_for_request`,
  `list_requests`).

## Legal note

Sci-Hub and Sci-Net are enabled by default. Whether retrieving a paper through
them is lawful depends on where you are and what you do with it; both are
blocked in some jurisdictions. You are responsible for your own use. Everything
upstream of them in the chain is open access by license.

## Development

```
npm ci
npm run check     # lint, typecheck, format, ascii, tests, dry-run build
npm run dev       # wrangler dev on :8787 (needs .dev.vars, see .dev.vars.example)
```

## License

MIT
