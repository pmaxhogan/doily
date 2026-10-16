import { describe, expect, it } from "vitest";

import { normalizeDoi } from "../../../src/scinet/doi.ts";
import { SITE, htmlToText } from "../../../src/scinet/site.ts";
import { fixture } from "./fakes.ts";

describe("SITE parsers (synthetic fixtures)", () => {
  it("recognizes the login form and nothing else", () => {
    expect(SITE.isLoginPage(fixture("synthetic-login-page.html"))).toBe(true);
    expect(SITE.isLoginPage(fixture("synthetic-home-logged-in.html"))).toBe(false);
    expect(SITE.isLoginPage(fixture("synthetic-request-open.html"))).toBe(false);
  });

  it("treats redirects to / or a login path as logged out", () => {
    expect(SITE.isLoginRedirect("/")).toBe(true);
    expect(SITE.isLoginRedirect("https://sci-net.xyz/")).toBe(true);
    expect(SITE.isLoginRedirect("/login?next=/request")).toBe(true);
    expect(SITE.isLoginRedirect("/request/abc")).toBe(false);
    expect(SITE.isLoginRedirect(null)).toBe(false);
  });

  it("finds an existing request on the DOI page", () => {
    expect(SITE.existing.parse(fixture("synthetic-doi-page-existing.html"))).toBe("a1B2c3");
    expect(SITE.existing.parse(fixture("synthetic-doi-page-none.html"))).toBeUndefined();
  });

  it("takes the new request id from the Location header first", () => {
    expect(SITE.request.parseId("/request/zz9", "")).toBe("zz9");
    expect(SITE.request.parseId(null, fixture("synthetic-doi-page-existing.html"))).toBe("a1B2c3");
    expect(SITE.request.parseId(null, "<p>thanks</p>")).toBeUndefined();
  });

  it("parses an open request page", () => {
    expect(SITE.requestPage.parse(fixture("synthetic-request-open.html"))).toEqual({
      status: "open",
    });
  });

  it("parses a solved request page with the PDF link and upload time", () => {
    expect(SITE.requestPage.parse(fixture("synthetic-request-solved.html"))).toEqual({
      status: "solved",
      pdfUrl: "/files/a1B2c3/example.5678.pdf?dl=1&v=2",
      uploadedAt: "2026-10-16T13:45:00.000Z",
    });
  });

  it("reports unknown for a page it cannot read", () => {
    expect(SITE.requestPage.parse("<html><body>maintenance</body></html>")).toEqual({
      status: "unknown",
    });
  });

  it("judges a verify response", () => {
    expect(SITE.verify.parseOk(200, "<p>Thank you, confirmed.</p>")).toBe(true);
    expect(SITE.verify.parseOk(302, "")).toBe(true);
    expect(SITE.verify.parseOk(500, "")).toBe(false);
    expect(SITE.verify.parseOk(200, "<p>Error: not allowed</p>")).toBe(false);
    expect(SITE.verify.parseOk(200, fixture("synthetic-login-page.html"))).toBe(false);
  });

  it("strips tags, scripts and entities to text", () => {
    expect(htmlToText("<p>a&amp;b</p><script>x()</script>  <b>c</b>")).toBe("a&b c");
  });
});

describe("normalizeDoi", () => {
  it("strips prefixes and lowercases", () => {
    expect(normalizeDoi("10.1038/NATURE12373")).toBe("10.1038/nature12373");
    expect(normalizeDoi("doi: 10.1038/nature12373")).toBe("10.1038/nature12373");
    expect(normalizeDoi("https://doi.org/10.1038/nature12373")).toBe("10.1038/nature12373");
    expect(normalizeDoi("10.1038%2Fnature12373")).toBe("10.1038/nature12373");
  });

  it("rejects non-DOIs", () => {
    expect(normalizeDoi("PMC12345")).toBeNull();
    expect(normalizeDoi("abc.def")).toBeNull();
  });
});
