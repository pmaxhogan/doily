/**
 * The Worker's environment: bindings from wrangler.jsonc plus secrets set with
 * `wrangler secret put` (or `.dev.vars` locally). Every secret is optional at
 * the type level because the Worker must boot and answer /healthz before any of
 * them are configured; each consumer checks for its own.
 */
export interface Env {
  DB: D1Database;
  PDFS: R2Bucket;
  DOILY_KV: KVNamespace;
  OAUTH_KV: KVNamespace;
  AI: Ai;
  SCINET_REQUEST: DurableObjectNamespace;

  DEV_MODE?: string;

  /** Static bearer accepted on /mcp as a second credential (curl, scripts). */
  DOILY_BEARER?: string;

  /** Cloudflare Access application that guards /authorize. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAIL?: string;

  /** Polite-pool contact for Crossref, Unpaywall and the User-Agent. */
  CONTACT_EMAIL?: string;

  /** Optional upstream API keys; every path works unkeyed. */
  NCBI_API_KEY?: string;
  OPENALEX_API_KEY?: string;
  S2_API_KEY?: string;
  CORE_API_KEY?: string;

  /** Sci-Hub: comma-separated mirror hosts and an optional fetch proxy. */
  SCIHUB_MIRRORS?: string;
  SCIHUB_MIRROR_LIST_URL?: string;
  SCIHUB_PROXY_URL?: string;
  SCIHUB_PROXY_TOKEN?: string;

  /** Sci-Net account and spend caps. */
  SCINET_USER?: string;
  SCINET_PASS?: string;
  SCINET_BOUNTY?: string;
  SCINET_DAILY_CAP?: string;
  /** "1" lets request_paper post before the site flow is captured (SITE_VERIFIED). */
  SCINET_ALLOW_UNVERIFIED?: string;

  /** HMAC key for request tokens handed out by get_full_text. */
  REQUEST_TOKEN_SECRET?: string;
}
