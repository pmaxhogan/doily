import { describe, expect, it } from "vitest";

import { normalizeDoi } from "../../../src/scinet/doi.ts";
import {
  SITE,
  SITE_VERIFIED,
  doiOfHref,
  doiPath,
  htmlToText,
  storagePdfUrl,
} from "../../../src/scinet/site.ts";
import { fixture } from "./fakes.ts";

const OPEN_DOI = "10.1080/03630269.2026.2729189";
const SOLVED_PDF =
  "https://sci-net.xyz/storage/2026/7/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0/Title-With-Dashes.pdf";
const VIEW_PDF =
  "/storage/9f8e7d6c5b4a39281706f5e4d3c2b1a0/CRISPR-Based-Mediated-Reactivation-of-Fetal-Hemoglobin-as-a-Therapeutic-Strategy-for-Hemoglobinopathies.pdf";

describe("SITE (captured flow)", () => {
  it("is marked verified", () => {
    expect(SITE_VERIFIED).toBe(true);
  });

  it("recognizes the login form and nothing else", () => {
    expect(SITE.isLoginPage(fixture("captured-login-page.html"))).toBe(true);
    expect(SITE.isLoginPage('<form><input name="user"><input name="pass"></form>')).toBe(true);
    expect(SITE.isLoginPage(fixture("captured-home-logged-in.html"))).toBe(false);
    expect(SITE.isLoginPage(fixture("captured-request-open.html"))).toBe(false);
    expect(SITE.isLoginPage(fixture("captured-search-card.html"))).toBe(false);
  });

  it("treats redirects to / or a login path as logged out", () => {
    expect(SITE.isLoginRedirect("/")).toBe(true);
    expect(SITE.isLoginRedirect("https://sci-net.xyz/")).toBe(true);
    expect(SITE.isLoginRedirect("/login?next=/request")).toBe(true);
    expect(SITE.isLoginRedirect(`/${OPEN_DOI}`)).toBe(false);
    expect(SITE.isLoginRedirect(null)).toBe(false);
  });

  it("builds the request page path from the DOI", () => {
    expect(doiPath(OPEN_DOI)).toBe(`/${OPEN_DOI}`);
    expect(doiPath("10.1002/(sici)1097<x>")).toBe("/10.1002/(sici)1097%3Cx%3E");
    expect(SITE.requestPage.path(OPEN_DOI)).toBe(`/${OPEN_DOI}`);
  });

  it("reads DOIs out of site links", () => {
    expect(doiOfHref(`/${OPEN_DOI}`)).toBe(OPEN_DOI);
    expect(doiOfHref(`https://sci-net.xyz/cancel/${OPEN_DOI}`, "cancel/")).toBe(OPEN_DOI);
    expect(doiOfHref("/10.1002/%28SICI%29abc")).toBe("10.1002/(sici)abc");
    expect(doiOfHref(`https://evil.example/${OPEN_DOI}`)).toBeUndefined();
    expect(doiOfHref("/papers/requests")).toBeUndefined();
  });
});

describe("SITE.lookup (POST /search fragment)", () => {
  it("sends the DOI as JSON to /search", () => {
    expect(SITE.lookup.path).toBe("/search");
    expect(SITE.lookup.body(OPEN_DOI)).toEqual({ doi: OPEN_DOI });
  });

  it("joins when the article was already posted", () => {
    expect(SITE.lookup.parse(fixture("captured-search-existing.html"), OPEN_DOI)).toEqual({
      kind: "existing",
    });
  });

  it("reports a DOI Crossref does not know", () => {
    expect(SITE.lookup.parse(fixture("captured-search-not-found.html"), OPEN_DOI)).toEqual({
      kind: "not_found",
    });
  });

  it("can post when the fragment is the paper card with the reward form", () => {
    expect(SITE.lookup.parse(fixture("captured-search-card.html"), OPEN_DOI)).toEqual({
      kind: "new",
    });
  });

  it("stays resilient: any other fragment naming the DOI can post, anything else is unknown", () => {
    expect(
      SITE.lookup.parse(`<div>${OPEN_DOI.toUpperCase()} - Hemoglobin</div>`, OPEN_DOI),
    ).toEqual({ kind: "new" });
    expect(SITE.lookup.parse("<div>maintenance</div>", OPEN_DOI)).toEqual({ kind: "unknown" });
  });

  it("recognizes the card by its visible reward text, whatever the input type", () => {
    const card =
      '<div class="paper">2026 Hemoglobin</div>Reward <input type="text" value="1"> tokens' +
      "<button>request</button><button>cancel</button>";
    expect(SITE.lookup.parse(card, OPEN_DOI)).toEqual({ kind: "new" });
  });
});

describe("htmlToText and comments", () => {
  it("drops HTML comments, including ones with angle brackets inside", () => {
    expect(htmlToText("<!-- GET /<doi> already posted on Sci-Net --><p>hi</p>")).toBe("hi");
  });
});

describe("SITE.request", () => {
  it("posts JSON {doi, reward} to /request", () => {
    expect(SITE.request.path).toBe("/request");
    expect(SITE.request.body(OPEN_DOI, 2)).toEqual({ doi: OPEN_DOI, reward: 2 });
  });
});

describe("SITE.requestPage (GET /<doi>)", () => {
  it("parses an open request taken by a solver, with its reward", () => {
    expect(SITE.requestPage.parse(fixture("captured-request-open.html"))).toEqual({
      status: "open",
      reward: 2,
      taken: true,
    });
  });

  it("parses an open request seen by another member (take link only)", () => {
    expect(SITE.requestPage.parse(fixture("captured-request-open-take.html"))).toEqual({
      status: "open",
    });
  });

  it("treats a bare Reward line as open", () => {
    expect(SITE.requestPage.parse("<p>Reward: 5 tokens</p>")).toEqual({
      status: "open",
      reward: 5,
    });
  });

  it("parses a solved request with the embedded storage PDF and no upload time", () => {
    expect(SITE.requestPage.parse(fixture("captured-request-solved.html"))).toEqual({
      status: "solved",
      pdfUrl: SOLVED_PDF,
    });
  });

  it("is solved but has no pdfUrl when the page shows no PDF yet", () => {
    const page = '<p>requested <a href="/a">a</a></p><p>uploaded <a href="/b">b</a></p>';
    expect(SITE.requestPage.parse(page)).toEqual({ status: "solved" });
  });

  it("parses a solved-but-unaccepted request (view link, file name, not viewed)", () => {
    expect(SITE.requestPage.parse(fixture("captured-request-solved-unaccepted.html"))).toEqual({
      status: "solved_unaccepted",
      fileName:
        "CRISPR-Based-Mediated-Reactivation-of-Fetal-Hemoglobin-as-a-Therapeutic-Strategy-for-Hemoglobinopathies.pdf",
      unviewed: true,
      reward: 2,
    });
  });

  it("stays solved_unaccepted once viewed, and on any single unaccepted marker", () => {
    const viewed = fixture("captured-request-solved-unaccepted.html").replace(
      "The solution has not been viewed yet",
      "",
    );
    expect(SITE.requestPage.parse(viewed)).toMatchObject({ status: "solved_unaccepted" });
    expect(SITE.requestPage.parse(`<a href="/view/${OPEN_DOI}">view</a>`)).toMatchObject({
      status: "solved_unaccepted",
    });
    expect(
      SITE.requestPage.parse("<p>Reward: 2 token</p><p>The solution has not been viewed yet</p>"),
    ).toMatchObject({ status: "solved_unaccepted" });
    expect(SITE.requestPage.parse("<p>Reward: 2 token</p><span>Some-Paper.pdf</span>")).toEqual({
      status: "solved_unaccepted",
      fileName: "Some-Paper.pdf",
      reward: 2,
    });
  });

  it("does not read the /reward/ form or a cancel link next to a .pdf name as solved", () => {
    const open = `<p>Reward: 2 token</p><form method="POST" action="/reward/${OPEN_DOI}"></form>`;
    expect(SITE.requestPage.parse(open)).toEqual({ status: "open", reward: 2 });
    const cancel = `<a href="/cancel/${OPEN_DOI}">cancel</a><span>notes.pdf</span>`;
    expect(SITE.requestPage.parse(cancel)).toEqual({ status: "open" });
  });

  it("reads the accepted page (assumed shape) as solved with the 32-hex storage PDF", () => {
    expect(SITE.requestPage.parse(fixture("captured-accept-ok.html"))).toEqual({
      status: "solved",
      pdfUrl: VIEW_PDF,
    });
  });

  it("an embedded storage PDF wins over a lingering view link", () => {
    const page = `<a href="/view/${OPEN_DOI}">view</a><iframe src="/storage/2026/1/ab/X.pdf">`;
    expect(SITE.requestPage.parse(page)).toEqual({
      status: "solved",
      pdfUrl: "/storage/2026/1/ab/X.pdf",
    });
  });

  it("reports unknown for a page it cannot read", () => {
    expect(SITE.requestPage.parse("<html><body>maintenance</body></html>")).toEqual({
      status: "unknown",
    });
  });
});

describe("SITE.view and SITE.accept", () => {
  it("builds percent-encoded /view/ and /accept/ paths", () => {
    expect(SITE.view.path(OPEN_DOI)).toBe(`/view/${OPEN_DOI}`);
    expect(SITE.accept.path(OPEN_DOI)).toBe(`/accept/${OPEN_DOI}`);
    expect(SITE.view.path("10.1002/(sici)1097<x>")).toBe("/view/10.1002/(sici)1097%3Cx%3E");
    expect(SITE.accept.path("10.1002/a#b")).toBe("/accept/10.1002/a%23b");
  });

  it("reads the preview's iframe PDF and its accept link", () => {
    expect(SITE.view.parse(fixture("captured-view.html"), OPEN_DOI)).toEqual({
      pdfUrl: VIEW_PDF,
      canAccept: true,
    });
  });

  it("only counts an accept link for the requested DOI", () => {
    expect(SITE.view.parse(fixture("captured-view.html"), "10.1/other")).toEqual({
      pdfUrl: VIEW_PDF,
      canAccept: false,
    });
    expect(SITE.view.parse('<embed src="/storage/2026/1/ab/X.pdf">')).toEqual({
      pdfUrl: "/storage/2026/1/ab/X.pdf",
      canAccept: false,
    });
  });

  it("treats a non-error, non-login accept response as success", () => {
    expect(SITE.accept.ok(200, fixture("captured-accept-ok.html"))).toBe(true);
    expect(SITE.accept.ok(302, "")).toBe(true);
    expect(SITE.accept.ok(200, fixture("captured-login-page.html"))).toBe(false);
    expect(SITE.accept.ok(404, "<p>not found</p>")).toBe(false);
  });
});

describe("storagePdfUrl", () => {
  it("finds the storage PDF in embed, object, iframe and link markup", () => {
    expect(storagePdfUrl('<embed src="/storage/2026/1/ab/X.pdf">')).toBe(
      "/storage/2026/1/ab/X.pdf",
    );
    expect(storagePdfUrl("<object data='/storage/2026/1/ab/X.pdf'></object>")).toBe(
      "/storage/2026/1/ab/X.pdf",
    );
    expect(
      storagePdfUrl('<a href="https://sci-net.xyz/storage/2026/1/ab/X.pdf?dl=1&amp;v=2">'),
    ).toBe("https://sci-net.xyz/storage/2026/1/ab/X.pdf?dl=1&v=2");
  });

  it("unwraps a viewer URL carrying the PDF in file=", () => {
    expect(
      storagePdfUrl('<iframe src="/viewer.html?file=%2Fstorage%2F2026%2F1%2Fab%2FX.pdf"></iframe>'),
    ).toBe("/storage/2026/1/ab/X.pdf");
  });

  it("ignores PDFs off sci-net.xyz and non-storage paths", () => {
    expect(storagePdfUrl('<iframe src="https://cdn.example.org/storage/x.pdf">')).toBeUndefined();
    expect(storagePdfUrl('<a href="/files/x.pdf">')).toBeUndefined();
  });
});

describe("SITE.library (GET /papers/requests)", () => {
  it("parses rows into {doi, status}", () => {
    expect(SITE.library.parse(fixture("captured-papers-requests.html"))).toEqual([
      { doi: OPEN_DOI, status: "open" },
      { doi: "10.1177/26345161261465536", status: "solved" },
    ]);
  });
});

describe("htmlToText", () => {
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
