import { describe, expect, it } from "vitest";

import { bearerToken, hasStaticBearer } from "../../../src/auth/bearer.ts";
import { timingSafeEqual, utf8 } from "../../../src/auth/primitives.ts";

const SECRET = "s3cret-static-bearer-value";

function withAuth(value?: string): Request {
  return new Request("https://doily.test/mcp", {
    method: "POST",
    headers: value === undefined ? {} : { authorization: value },
  });
}

describe("bearerToken", () => {
  it("reads the token after a case-insensitive Bearer scheme", () => {
    expect(bearerToken(withAuth(`Bearer ${SECRET}`))).toBe(SECRET);
    expect(bearerToken(withAuth(`bearer ${SECRET}`))).toBe(SECRET);
    expect(bearerToken(withAuth(`BEARER   ${SECRET}`))).toBe(SECRET);
  });

  it("is null for other schemes, a missing token, or extra words", () => {
    expect(bearerToken(withAuth())).toBeNull();
    expect(bearerToken(withAuth(`Basic ${SECRET}`))).toBeNull();
    expect(bearerToken(withAuth("Bearer"))).toBeNull();
    expect(bearerToken(withAuth("Bearer "))).toBeNull();
    expect(bearerToken(withAuth(`Bearer ${SECRET} extra`))).toBeNull();
    expect(bearerToken(withAuth(SECRET))).toBeNull();
  });
});

describe("hasStaticBearer", () => {
  it("accepts exactly the configured secret", async () => {
    await expect(hasStaticBearer(withAuth(`Bearer ${SECRET}`), SECRET)).resolves.toBe(true);
  });

  it("rejects a wrong, longer, shorter, or differently cased token", async () => {
    for (const token of [`${SECRET}x`, SECRET.slice(0, -1), SECRET.toUpperCase(), "x"]) {
      await expect(hasStaticBearer(withAuth(`Bearer ${token}`), SECRET), token).resolves.toBe(
        false,
      );
    }
  });

  it("rejects a request without an Authorization header", async () => {
    await expect(hasStaticBearer(withAuth(), SECRET)).resolves.toBe(false);
  });

  it("never matches when the secret is unset or empty", async () => {
    // An unset secret is a misconfiguration, never a bypass: not even a
    // request presenting an empty-looking token gets in.
    await expect(hasStaticBearer(withAuth("Bearer undefined"), undefined)).resolves.toBe(false);
    await expect(hasStaticBearer(withAuth("Bearer x"), "")).resolves.toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("compares content for equal lengths", () => {
    expect(timingSafeEqual(utf8("abc"), utf8("abc"))).toBe(true);
    expect(timingSafeEqual(utf8("abc"), utf8("abd"))).toBe(false);
  });

  it("is false for different lengths", () => {
    expect(timingSafeEqual(utf8("abc"), utf8("abcd"))).toBe(false);
  });
});
