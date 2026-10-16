# Self-hosting doily

This guide deploys doily to your own Cloudflare account. Expect about thirty
minutes. Every upstream API key is optional; the only mandatory secrets are the
ones that protect the server itself.

## 1. Prerequisites

- A Cloudflare account on the **Workers Paid** plan. PDF text extraction is
  CPU-bound and `wrangler.jsonc` sets `limits.cpu_ms` to 300000 (five minutes),
  which the free plan does not allow.
- A DNS zone on that account, and a hostname in it for doily (for example
  `doily.example.com`). The Worker is served only from that custom domain;
  `workers_dev` and preview URLs are off on purpose, because a `workers.dev`
  hostname would be a second front door outside Cloudflare Access.
- Cloudflare Zero Trust enabled (the free tier is enough) for Access.
- Node.js 26 or newer (see `.node-version`), and this repository cloned.

```sh
npm ci
npx wrangler login
```

## 2. Create the storage

doily uses one D1 database, one R2 bucket and two KV namespaces. The names below
are the ones in `wrangler.jsonc`.

```sh
npx wrangler d1 create doily
npx wrangler r2 bucket create doily-pdfs
npx wrangler kv namespace create DOILY_KV
npx wrangler kv namespace create OAUTH_KV
```

Each command prints an id. The Durable Object (`SciNetRequest`) and Workers AI
bindings need no creation step; the Durable Object is created by the `v1`
migration on the first deploy.

## 3. Edit wrangler.jsonc

Replace the owner's values with yours:

- `account_id`: your Cloudflare account id.
- `routes[0].pattern`: your hostname. Keep `"custom_domain": true`.
- `d1_databases[0].database_id`: the id from `d1 create`.
- `kv_namespaces`: paste the two ids. **The binding name `OAUTH_KV` is mandatory.**
  `@cloudflare/workers-oauth-provider` looks for exactly that name and it is not
  configurable. `DOILY_KV` holds rate-limit buckets and cached metadata.
- Leave `vars.DEV_MODE` as `"false"`.

Apply the schema once so you can verify it locally and remotely:

```sh
npm run migrate:remote
```

(`npm run deploy` runs this again; migrations are idempotent.)

## 4. Secrets

Set each with `npx wrangler secret put NAME`. Anything marked optional can be left
unset. For local development the same names go in `.dev.vars`
(see `.dev.vars.example`).

| Secret                    | Required    | Purpose and where to get it                                                                                                                                                                                                                      |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOILY_BEARER`            | Recommended | Static bearer accepted on `/mcp` for curl and scripts. Generate a long random string, for example `openssl rand -base64 48`.                                                                                                                     |
| `REQUEST_TOKEN_SECRET`    | Yes         | HMAC key for `request_token` values and signed `/download` links. Generate a long random string. Without it, `get_full_text` cannot hand out tokens.                                                                                             |
| `CF_ACCESS_TEAM_DOMAIN`   | Yes         | Your Zero Trust team domain, `your-team.cloudflareaccess.com`. See step 5.                                                                                                                                                                       |
| `CF_ACCESS_AUD`           | Yes         | The Access application's AUD tag. See step 5.                                                                                                                                                                                                    |
| `CF_ACCESS_ALLOWED_EMAIL` | Yes         | The one email allowed to approve OAuth consent. The Worker rejects any other identity even if the Access policy is widened by mistake.                                                                                                           |
| `CONTACT_EMAIL`           | Recommended | Contact address sent to Crossref (`mailto=`), Unpaywall (`email=`) and in the `User-Agent`, so those services can reach you instead of blocking you.                                                                                             |
| `NCBI_API_KEY`            | Optional    | Raises NCBI E-utilities from 3 to 10 requests per second. Create at https://account.ncbi.nlm.nih.gov/settings/ (API Key Management).                                                                                                             |
| `OPENALEX_API_KEY`        | Optional    | OpenAlex API key, free, with a $1 per day budget. Create an account at https://openalex.org/ and copy the key from your account page. doily stops keyword searches at 90% of the day's budget and falls back to Europe PMC and Semantic Scholar. |
| `S2_API_KEY`              | Optional    | Semantic Scholar key (1 request per second). Request one at https://www.semanticscholar.org/product/api#api-key-form.                                                                                                                            |
| `CORE_API_KEY`            | Optional    | Enables the CORE hop of the full-text chain; skipped when unset. Register at https://core.ac.uk/services/api.                                                                                                                                    |
| `SCIHUB_MIRRORS`          | Optional    | Comma-separated Sci-Hub mirror hosts, overriding the built-in list (`sci-hub.ru,sci-hub.ee,sci-hub.ren,sci-hub.al`).                                                                                                                             |
| `SCIHUB_MIRROR_LIST_URL`  | Optional    | A page that lists current mirrors, scraped for extra candidates.                                                                                                                                                                                 |
| `SCIHUB_PROXY_URL`        | Optional    | Base URL of a fetch proxy for Sci-Hub traffic. See step 9.                                                                                                                                                                                       |
| `SCIHUB_PROXY_TOKEN`      | Optional    | Bearer token the proxy expects. Required whenever `SCIHUB_PROXY_URL` is set.                                                                                                                                                                     |
| `SCINET_USER`             | Optional    | Sci-Net account name. See step 8. Without it, `request_paper` fails and `/healthz` reports Sci-Net as not configured.                                                                                                                            |
| `SCINET_PASS`             | Optional    | Sci-Net password.                                                                                                                                                                                                                                |
| `SCINET_BOUNTY`           | Optional    | Bounty in Sci-Net tokens per request. Default 2. It is a ceiling: `request_paper` refuses a larger bounty and never raises it on its own.                                                                                                        |
| `SCINET_DAILY_CAP`        | Optional    | Maximum new Sci-Net requests per UTC day. Default 5. Set `0` to disable posting.                                                                                                                                                                 |

`DEV_MODE` is a plain var, not a secret, and stays `"false"` in production.

## 5. Cloudflare Access

Access protects the OAuth consent page (`/authorize`). Everything an MCP client
must reach without a browser has to bypass it.

1. In Zero Trust, go to **Access > Applications > Add an application >
   Self-hosted**.
2. Application domain: your doily hostname, with no path (the whole host).
3. Add two policies, in this order:
   - **Bypass** (action: Bypass, include: Everyone) with path rules for
     `/mcp`, `/oauth/*`, `/.well-known/*`, `/healthz` and `/download/*`. These
     paths carry their own authentication: the bearer or an OAuth token for
     `/mcp`, the OAuth endpoints themselves, an unauthenticated health check,
     and HMAC-signed download links.
   - **Allow** (action: Allow, include: Emails, your email) for everything
     else. In practice that is `/authorize`.

   If your dashboard cannot scope policies by path inside one application,
   create a second self-hosted application for the bypass paths (same hostname,
   one path per destination) with the Bypass policy, and keep the first
   application on the whole host with the Allow policy. Cloudflare applies the
   most specific path match.

4. Open the application and copy the **Application Audience (AUD) Tag**.

Then store it, along with your team domain (the `*.cloudflareaccess.com` name
under **Settings > Custom pages**):

```sh
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_ALLOWED_EMAIL
```

The Worker re-verifies the Access JWT on `/authorize` (signature, audience,
issuer and the allowed email), so the consent page stays closed even if the
Access policy is misconfigured. If any of the three values is unset, the check
fails closed.

## 6. Deploy with Workers Builds

You can deploy by hand with `npm run deploy`, or connect the repository so every
push to `main` deploys:

1. In the Cloudflare dashboard, **Workers & Pages > doily > Settings > Builds >
   Connect**, and choose your GitHub fork.
2. **Build command**: none.
3. **Deploy command**: `npm run deploy`.
4. Branch: `main`.

`npm run deploy` runs `npm run migrate:remote` (D1 migrations), then
`npm run snapshots:upload` (uploads `data/sjr.json` to R2 as
`doily-pdfs/data/sjr.json`, where the Worker reads it), then `wrangler deploy`.
Run `npm run check` locally before you push.

Verify the deployment:

```sh
curl -sS https://<your-host>/healthz
curl -sS -X POST https://<your-host>/mcp \
  -H "Authorization: Bearer $DOILY_BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`/healthz` returns booleans only, for example `{"ok":true,"scihub_configured":true,
"scinet_configured":false,"bearer_configured":true}`.

Then connect a client; see the quick starts in the [README](../README.md).

## 7. Snapshot refresh

`data/sjr.json` (SCImago ranks) and `data/predatory.json` (watch-list names) are
committed snapshots, refreshed by hand about once a year. A cron trigger
(`0 6 1 1 *`) only logs a reminder on 1 January. The procedure, including the
browser step SCImago's Cloudflare challenge requires, is in
[scripts/refresh-snapshots.md](../scripts/refresh-snapshots.md). Deploying
re-uploads the SJR file to R2.

## 8. Sci-Net

Sci-Net is a bounty marketplace where other users fulfil paper requests. It has
no public API; doily logs in as you and drives the site.

1. Create an account at Sci-Net and fund it with some tokens.
2. Set `SCINET_USER` and `SCINET_PASS` as secrets.
3. Optionally tune `SCINET_BOUNTY` (default 2 tokens) and `SCINET_DAILY_CAP`
   (default 5 new requests per UTC day).

How it behaves: `request_paper` first re-runs the open-access chain and refuses
if the paper is obtainable. It joins an existing Sci-Net request for the DOI
rather than posting a duplicate, and posts at most one request per DOI. Each
request gets a Durable Object that polls Sci-Net every five minutes. When a
file is uploaded, doily downloads it to R2, extracts the text, checks that it is
a PDF containing the DOI or title, and only then verifies it on Sci-Net, which
releases the bounty. A file that fails the check is left unverified and the
request is marked `needs_owner`. Requests expire after 72 hours. The bounty is
fixed at the configured value and is never raised automatically.

## 9. Optional: Sci-Hub fetch proxy

Cloudflare's egress addresses are sometimes challenged by Sci-Hub mirrors. If
`/healthz` is fine but Sci-Hub hops keep failing, run a small proxy on a machine
with a residential address and point doily at it with `SCIHUB_PROXY_URL` and
`SCIHUB_PROXY_TOKEN`. When `SCIHUB_PROXY_URL` is set, the Worker never contacts a
mirror directly.

The contract the proxy must implement:

Request from the Worker:

```http
POST <SCIHUB_PROXY_URL>/fetch
Authorization: Bearer <SCIHUB_PROXY_TOKEN>
Content-Type: application/json

{ "url": "https://sci-hub.ru/10.1038/nature12373",
  "method": "GET",
  "headers": { "User-Agent": "...", "Accept": "text/html,...", "Referer": "..." } }
```

- `url` is an absolute http(s) URL. The proxy may restrict it to an allowlist
  (`sci-hub.*` hosts, `sci.bban.top`, the mirror-list pages).
- `method` is always `"GET"`.
- `headers` are forwarded to the upstream as given.

Response from the proxy:

- Follow redirects and return the final upstream response: its status code as the
  proxy's status, its body verbatim (raw bytes), and its `Content-Type`.
- Set `X-Upstream-Status: <upstream status code>` on every response that carries
  an upstream result, including upstream 4xx and 5xx.
- A response **without** `X-Upstream-Status` is treated as a proxy failure, so a
  wrong token never looks like a mirror's "not found": 401 for a bad token, 502
  for an unreachable upstream, 504 for an upstream timeout (reported as a
  timeout), 403 for a disallowed host.
- Apply an upstream timeout of at most 30 seconds.

## 10. Local development

```sh
cp .dev.vars.example .dev.vars    # then fill in values; never commit this file
npm run dev                       # wrangler dev on http://localhost:8787
```

Set `DEV_MODE=true` in `.dev.vars` to relax the Cloudflare Access check for the
consent page. It applies to requests whose hostname is `localhost`, `127.0.0.1`
or `[::1]` only, so flipping it by mistake in production does not open the gate
on the real hostname. Use the static bearer (`DOILY_BEARER`) to call `/mcp` from
curl locally.

Local D1 migrations: `npm run migrate:local`. Tests need no secrets; the
integration suite supplies dummy ones.
