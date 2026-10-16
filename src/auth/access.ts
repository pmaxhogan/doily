// The Cloudflare Access gate in front of /authorize (the consent page).
//
// Adapted from pmaxhogan/healthy (MIT). Access terminates SSO in front of the
// Worker and injects a signed JWT. Verifying that JWT here, rather than trusting
// that the request could only have arrived through Access, is what makes the
// gate real: a misconfigured Access policy or path bypass would otherwise hand
// out OAuth grants to anyone.
//
// Two things are checked beyond the signature:
//   * `aud` must be this Access application's AUD, so no other application in
//     the same team is a valid issuer for this one.
//   * `email` must be the single allowed identity. A policy can be widened by
//     accident in the dashboard; this check cannot.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { readCookie } from "./primitives.ts";

/** The slice of Env this module reads. Narrow so it is unit-testable. */
export interface AccessEnv {
  DEV_MODE?: string | undefined;
  CF_ACCESS_TEAM_DOMAIN?: string | undefined;
  CF_ACCESS_AUD?: string | undefined;
  CF_ACCESS_ALLOWED_EMAIL?: string | undefined;
}

/** Access puts the assertion here on every proxied request. */
const ACCESS_HEADER = "cf-access-jwt-assertion";

/** ...and in this cookie, which is what a browser navigation carries. */
const ACCESS_COOKIE = "CF_Authorization";

/** Hostnames `wrangler dev` serves on. URL.hostname keeps IPv6 brackets. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * One remote JWKS per team domain, cached for the life of the isolate.
 * `createRemoteJWKSet` caches keys and rate-limits refetches itself, so
 * re-creating it per request would issue a certificate fetch on every hit.
 */
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function jwksFor(team: string): JWTVerifyGetKey {
  const cached = jwksByTeam.get(team);
  if (cached) return cached;
  const created = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
  jwksByTeam.set(team, created);
  return created;
}

/** Overrides for the tests. Production never passes this. */
export interface VerifyAccessOptions {
  /** Replaces the remote JWKS, e.g. with `jose`'s `createLocalJWKSet`. */
  getKey?: JWTVerifyGetKey;
}

/**
 * True when the request is a local `wrangler dev` request with DEV_MODE on.
 * Both are required: DEV_MODE alone must not open the gate on the real
 * hostname if the var is ever flipped by mistake in production.
 */
export function isLocalDevRequest(request: Request, env: AccessEnv): boolean {
  return env.DEV_MODE === "true" && LOCAL_HOSTNAMES.has(new URL(request.url).hostname);
}

/**
 * True when the request carries a valid Access assertion for the one allowed
 * identity, or is a local dev request (see `isLocalDevRequest`).
 */
export async function verifyAccess(
  request: Request,
  env: AccessEnv,
  options: VerifyAccessOptions = {},
): Promise<boolean> {
  if (isLocalDevRequest(request, env)) return true;

  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  const allowedEmail = env.CF_ACCESS_ALLOWED_EMAIL;
  // Fail closed. An unset secret is a misconfiguration, never a bypass.
  if (!team || !audience || !allowedEmail) return false;

  const token = request.headers.get(ACCESS_HEADER) ?? readCookie(request, ACCESS_COOKIE);
  if (!token) return false;

  try {
    const { payload } = await jwtVerify(token, options.getKey ?? jwksFor(team), {
      audience,
      issuer: `https://${team}`,
      algorithms: ["RS256"],
      // Access tokens are short-lived; a little tolerance covers clock skew
      // between Cloudflare's signer and the edge running this Worker.
      clockTolerance: 30,
    });
    const email = payload["email"];
    return (
      typeof email === "string" && email.trim().toLowerCase() === allowedEmail.trim().toLowerCase()
    );
  } catch {
    // Signature, expiry, audience, issuer and algorithm failures all mean the
    // same thing to the caller: not authenticated.
    return false;
  }
}
