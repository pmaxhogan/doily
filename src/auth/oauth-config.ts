/**
 * The OAuth provider's configuration, free of handlers. Mirrors
 * pmaxhogan/healthy's `worker/src/mcp/oauth-config.ts`.
 *
 *  - `resourceMetadata.resource` is what every access token's audience is bound
 *    to, and the provider checks it exactly. It is derived from the request
 *    (`resourceFor`) rather than pinned to the production hostname, so tokens
 *    minted through `wrangler dev` or a test origin validate against that same
 *    origin. That is why the provider is constructed per request.
 *  - It is `<origin>/mcp`, not the bare origin: MCP clients bind their grant to
 *    the server URL they connected to (claude.ai's tokens carry
 *    `https://<host>/mcp`). The protected-resource metadata is then served at
 *    `/.well-known/oauth-protected-resource/mcp` (RFC 9728 path form).
 *  - `disallowPublicClientRegistration: false` (the default, stated anyway):
 *    claude.ai registers through DCR as a public client.
 *  - `allowPlainPKCE: false` requires S256, per OAuth 2.1.
 *  - `clientRegistrationTTL` of one year: a registration expiring forces
 *    claude.ai to re-run DCR and the owner back through consent. Refresh tokens
 *    rotate and expire on their own schedule.
 */

export const MCP_API_ROUTE = "/mcp";

/** The only scope this server issues. */
export const MCP_SCOPE = "papers";

/** The single user of this single-owner deployment. Every grant is theirs. */
export const OWNER_USER_ID = "owner";

export const AUTHORIZE_PATH = "/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTER_PATH = "/oauth/register";

const ACCESS_TOKEN_TTL = 3600;
const REFRESH_TOKEN_TTL = 30 * 24 * 3600;
const CLIENT_REGISTRATION_TTL = 365 * 24 * 3600;

/** The canonical resource (RFC 8707) for the origin `request` arrived on. */
export function resourceFor(request: Request): string {
  return `${new URL(request.url).origin}${MCP_API_ROUTE}`;
}

/** Everything but the handlers and the resource. `src/index.ts` adds those. */
export const OAUTH_CORE = {
  authorizeEndpoint: AUTHORIZE_PATH,
  tokenEndpoint: TOKEN_PATH,
  clientRegistrationEndpoint: REGISTER_PATH,
  scopesSupported: [MCP_SCOPE],
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  disallowPublicClientRegistration: false,
  accessTokenTTL: ACCESS_TOKEN_TTL,
  refreshTokenTTL: REFRESH_TOKEN_TTL,
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL,
};

export function oauthCoreFor(resource: string): typeof OAUTH_CORE & {
  resourceMetadata: { resource: string; resource_name: string; scopes_supported: string[] };
} {
  return {
    ...OAUTH_CORE,
    resourceMetadata: {
      resource,
      resource_name: "doily",
      scopes_supported: [MCP_SCOPE],
    },
  };
}
