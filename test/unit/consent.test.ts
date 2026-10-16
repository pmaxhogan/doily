import { describe, expect, it } from "vitest";

import { hasSameOriginProof } from "../../src/consent/csrf.ts";
import { consentPage, escapeHtml, handOffPage, securityHeaders } from "../../src/consent/page.ts";

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("consentPage", () => {
  const view = {
    clientName: `Evil"><script>alert(1)</script>`,
    redirectUri: "https://claude.ai/api/mcp/auth_callback?x=<y>",
    redirectHost: "claude.ai",
    redirectIsLoopback: false,
    scopes: ["papers"],
    handle: `h"andle`,
  };

  it("escapes client-controlled values and contains no script", () => {
    const html = consentPage("nonce123", view);

    expect(html).not.toContain("<script");
    expect(html).toContain("Evil&quot;&gt;&lt;script&gt;");
    expect(html).toContain('value="h&quot;andle"');
    expect(html).toContain('<style nonce="nonce123">');
  });

  it("warns when the redirect goes to a loopback address", () => {
    expect(consentPage("n", view)).not.toContain('class="warn"');
    expect(consentPage("n", { ...view, redirectIsLoopback: true })).toContain('class="warn"');
  });
});

describe("handOffPage", () => {
  it("escapes the target in both the refresh and the link", () => {
    const html = handOffPage("n", "https://claude.ai/cb?code=a&state=b");

    expect(html).toContain('content="0;url=https://claude.ai/cb?code=a&amp;state=b"');
    expect(html).toContain('href="https://claude.ai/cb?code=a&amp;state=b"');
  });
});

describe("securityHeaders", () => {
  it("allows no script, no framing, and forms only to this origin", () => {
    const headers = securityHeaders("abc");
    const csp = headers["content-security-policy"] ?? "";

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'nonce-abc'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("script-src");
    expect(headers["x-frame-options"]).toBe("DENY");
  });
});

describe("hasSameOriginProof", () => {
  const url = "https://doily.test/authorize";

  it("accepts a matching Origin or Sec-Fetch-Site: same-origin", () => {
    expect(
      hasSameOriginProof(new Request(url, { headers: { origin: "https://doily.test" } })),
    ).toBe(true);
    expect(
      hasSameOriginProof(new Request(url, { headers: { "sec-fetch-site": "same-origin" } })),
    ).toBe(true);
  });

  it("rejects a foreign Origin, a cross-site fetch, or neither header", () => {
    expect(
      hasSameOriginProof(new Request(url, { headers: { origin: "https://evil.example" } })),
    ).toBe(false);
    expect(
      hasSameOriginProof(new Request(url, { headers: { "sec-fetch-site": "cross-site" } })),
    ).toBe(false);
    expect(hasSameOriginProof(new Request(url))).toBe(false);
  });
});
