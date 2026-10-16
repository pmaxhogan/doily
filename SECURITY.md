# Security

## Reporting a vulnerability

Please report security issues privately through GitHub security advisories:
https://github.com/pmaxhogan/doily/security/advisories/new

Do not open a public issue for a vulnerability. Include the affected route or
file, what an attacker can do, and steps to reproduce. This is a single-owner
project maintained on a best-effort basis; expect an acknowledgement within a
week or so.

## Threat model

doily is a personal server. One owner deploys it and is the only intended user.
The repository is public, so nothing secret is ever committed: credentials live
in Worker secrets (or an untracked `.dev.vars` locally).

## Authentication

`/mcp` accepts two credentials:

1. **OAuth 2.1 with PKCE (S256 only) and dynamic client registration**, provided
   by `@cloudflare/workers-oauth-provider`. There is one scope, `papers`. Access
   tokens last one hour, refresh tokens 30 days, client registrations one year.
   Tokens are bound to the resource `<origin>/mcp`. The implicit flow and plain
   PKCE are disabled.
2. **A static bearer** (the `DOILY_BEARER` secret) for curl and scripts. It is
   compared in constant time after hashing both sides with SHA-256, so neither the
   value nor its length leaks through timing. An unset or empty secret matches
   nothing. A wrong bearer is not an error of its own: it falls through to the
   OAuth provider, which answers the 401 challenge.

The OAuth consent page, `/authorize`, sits behind **Cloudflare Access**. The
Worker does not trust that the request came through Access: it verifies the
`Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie) itself, checking
the RS256 signature against the team's JWKS, the issuer, the application AUD tag
and that the `email` claim equals `CF_ACCESS_ALLOWED_EMAIL`. If any of the three
settings is missing, the check fails closed. The consent form is protected against
CSRF twice: a single-use, cookie-bound handle held in KV, and a same-origin proof
(`Origin` or `Sec-Fetch-Site`). The consent page is served with a strict CSP and
`frame-ancestors 'none'`.

`DEV_MODE=true` relaxes the Access check only for requests to `localhost`,
`127.0.0.1` or `[::1]`; on any other hostname it has no effect.

## What is public

Access bypasses these paths, so anyone can reach them:

- `/healthz`: booleans only (whether the server is up and whether Sci-Hub, Sci-Net
  and the bearer are configured). Never URLs, mirror names or secret-derived
  values.
- `/download/<doi>`: serves a cached PDF, but only with a valid HMAC signature and
  an unexpired timestamp. Links are minted by `get_pdf` and are valid for one hour.
  The signature covers a `download` prefix, the lowercased DOI and the expiry, so
  it cannot be reused for other DOIs and is not interchangeable with a
  `request_token`.
- `/mcp`, `/oauth/token`, `/oauth/register` and `/.well-known/*`: these carry their
  own authentication or are public by protocol design (OAuth metadata, token and
  registration endpoints).

`workers_dev` and preview URLs are disabled so no hostname exists outside Access.

## Secrets handling

- Secrets are Worker secrets set with `wrangler secret put`. `.dev.vars` is
  ignored by git; only `.dev.vars.example`, with placeholders, is committed.
- Tool errors are verbose for the agent (upstream status and a body excerpt) but
  scrubbed: configured secrets and URLs that embed them are removed before an
  error leaves the Worker. Secrets are never logged.
- `REQUEST_TOKEN_SECRET` signs both request tokens and download links. Rotating it
  invalidates outstanding ones, which is harmless.

## Upstream access

- **No scraping of PMC.** PubMed Central content is fetched only through the NCBI
  and Europe PMC APIs. HTML pages on pmc.ncbi.nlm.nih.gov are never scraped.
- **Polite identification.** Requests carry a `User-Agent` naming the project and
  the owner's `CONTACT_EMAIL`, and per-provider token buckets keep traffic inside
  each service's published limits.
- **SSRF guard on PDF candidates.** Open-access metadata supplies URLs that the
  Worker will fetch. Candidate PDF URLs must be `https` and must not point at
  private, loopback or link-local addresses or other internal hosts. Every fetched
  file must start with the `%PDF` magic bytes, and PDFs over 50 MB are refused.
- **Sci-Hub and Sci-Net.** Both are enabled by default and their lawfulness depends
  on your jurisdiction. Sci-Net spending is bounded: a fixed bounty (default 2
  tokens, never auto-raised), a daily cap on new requests (default 5), one request
  per DOI, and a 72 hour expiry. The optional Sci-Hub proxy is bearer-authenticated
  and should restrict its upstream hosts to an allowlist.

## Supported versions

Only the latest commit on `main` is supported.
