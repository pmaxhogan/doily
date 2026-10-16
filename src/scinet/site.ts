/**
 * Every sci-net.xyz specific detail lives here, in one `SITE` object, so a
 * change on the site is corrected in one place.
 *
 * Captured 2026-10-16, logged out and logged in (docs/scinet-capture.md):
 * login is `POST /` with form-urlencoded `user`, `pass`, `action=login`, no
 * CSRF token, server-rendered pages and a cookie session. The only XHR calls
 * are `POST /search` and `POST /request`, both JSON. A request is addressed by
 * its DOI: the request page is `/<doi>`, there is no separate request id. A
 * solution is previewed at `/view/<doi>` and accepted with `/accept/<doi>`.
 *
 * Parsers are plain string/regex functions (no HTMLRewriter) so they run under
 * Node in unit tests as well as in workerd.
 */

/**
 * True once the logged-in flow has been captured and the parsers below reflect
 * the real site. While false, request_paper refuses to post unless the owner
 * sets SCINET_ALLOW_UNVERIFIED=1; flip it back if the site changes shape.
 */
export const SITE_VERIFIED = true;

/**
 * `solved_unaccepted`: a solver uploaded a file but the requester has not
 * accepted it yet (the bounty moves on accept). `solved`: accepted, the page
 * embeds the storage PDF.
 */
export type RemoteStatus = "open" | "solved_unaccepted" | "solved" | "unknown";

export interface ParsedRequestPage {
  status: RemoteStatus;
  /** Absolute or site-relative URL of the uploaded PDF, when solved. */
  pdfUrl?: string;
  /** ISO timestamp of the upload. Sci-Net shows none, so this stays unset. */
  uploadedAt?: string;
  /** The bounty from `Reward: N token`, when an open page shows it. */
  reward?: number;
  /** True when a solver took the open request ("This member is working ..."). */
  taken?: boolean;
  /** The uploaded file name a solved-unaccepted page lists, e.g. `Title.pdf`. */
  fileName?: string;
  /** True while a solved-unaccepted page says the solution was not viewed yet. */
  unviewed?: boolean;
}

/** What the preview page `GET /view/<doi>` offers. */
export interface ParsedViewPage {
  /** Site-relative or absolute URL of the uploaded PDF in the preview. */
  pdfUrl?: string;
  /** True when the page carries the requester's `/accept/<doi>` link. */
  canAccept: boolean;
}

/** What `POST /search` said about a DOI. */
export type LookupResult =
  { kind: "existing" } | { kind: "not_found" } | { kind: "new" } | { kind: "unknown" };

export interface LibraryRow {
  doi: string;
  status: "solved" | "open";
}

/** Decode the handful of entities that show up in attribute values and text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;|&#47;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Visible text of an HTML page, tags stripped and whitespace collapsed. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** All anchor `href` values in document order, entity-decoded. */
export function hrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    if (m[2] !== undefined) out.push(decodeEntities(m[2]));
  }
  return out;
}

/** Site path of a DOI (the request page), each segment percent-encoded. */
export function doiPath(doi: string): string {
  return `/${doi.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The DOI a site-relative or absolute sci-net.xyz href points at, lowercased.
 * `prefix` selects a control path such as `cancel/` or `take/`.
 */
export function doiOfHref(href: string, prefix = ""): string | undefined {
  const m = new RegExp(
    `^(?:(?:https:)?//sci-net\\.xyz)?/${prefix}(10\\.\\d{4,9}/[^?#]+)(?:[?#].*)?$`,
    "i",
  ).exec(href.trim());
  if (m?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return undefined;
  }
}

/** A sci-net.xyz storage PDF URL, absolute or site-relative. */
const STORAGE_PDF_RE =
  /^(?:(?:https:)?\/\/sci-net\.xyz)?\/storage\/[^"'<>]+?\.pdf(?:[?#][^"'<>]*)?$/i;

/**
 * The uploaded PDF's URL on a solved page: an embed/iframe/object/link whose
 * `src`, `data` or `href` is a `/storage/...pdf` URL, or a viewer URL that
 * carries one in its `file=` parameter.
 */
export function storagePdfUrl(html: string): string | undefined {
  for (const m of html.matchAll(/\b(?:src|href|data)\s*=\s*(["'])(.*?)\1/gi)) {
    const value = decodeEntities(m[2] ?? "").trim();
    if (STORAGE_PDF_RE.test(value)) return value;
    const file = /[?&]file=([^&#]+)/.exec(value)?.[1];
    if (file === undefined) continue;
    try {
      const inner = decodeURIComponent(file);
      if (STORAGE_PDF_RE.test(inner)) return inner;
    } catch {
      // A malformed escape is just not a storage URL.
    }
  }
  return undefined;
}

/**
 * The uploaded file name on a solved-unaccepted page: an element whose whole
 * text is one `name.pdf` token. Text is matched, not attributes, so storage
 * URLs in `src`/`href` never count.
 */
export function uploadedFileName(html: string): string | undefined {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  for (const m of body.matchAll(/>\s*([^<>\s]+\.pdf)\s*</gi)) {
    const name = decodeEntities(m[1] ?? "");
    if (!name.includes("/")) return name;
  }
  return undefined;
}

/** True when some anchor points at `/<prefix><doi>`, for `doi` when given. */
function hasControl(html: string, prefix: string, doi?: string): boolean {
  const want = doi?.trim().toLowerCase();
  return hrefs(html).some((h) => {
    const got = doiOfHref(h, prefix);
    return got !== undefined && (want === undefined || got === want);
  });
}

export const SITE = {
  base: "https://sci-net.xyz",

  /** Browser-like UA; the site is a normal server-rendered web app. */
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",

  login: {
    path: "/",
    userField: "user",
    passField: "pass",
    extraFields: { action: "login" } as Record<string, string>,
  },

  /**
   * How long a stored session cookie is trusted before we log in again
   * proactively. The cookie lifetime was not observed; 12 hours is a cautious
   * choice, and a logged-out response triggers a re-login anyway.
   */
  sessionTtlSeconds: 12 * 60 * 60,

  /**
   * True when the HTML is the login form, i.e. we are not logged in. A
   * logged-out visitor gets the home page with the login form: a `pass` input
   * next to the `user` input or the `action=login` field.
   */
  isLoginPage(html: string): boolean {
    return (
      /<input\b[^>]*\bname\s*=\s*["']?pass["'\s/>]/i.test(html) &&
      (/<input\b[^>]*\bname\s*=\s*["']?user["'\s/>]/i.test(html) ||
        /\bvalue\s*=\s*["']?login["'\s/>]/i.test(html))
    );
  },

  /** True when a redirect Location points at the login page (the home page). */
  isLoginRedirect(location: string | null): boolean {
    if (location === null) return false;
    let path: string;
    try {
      path = new URL(location, SITE.base).pathname;
    } catch {
      return false;
    }
    return path === "/" || /login|signin/i.test(path);
  },

  /** `POST /search` with JSON `{doi}`: does Sci-Net already have a request? */
  lookup: {
    path: "/search",
    body(doi: string): { doi: string } {
      return { doi };
    },
    /**
     * Read the HTML fragment `/search` returns. "already posted on Sci-Net"
     * means join; "not found in Crossref" means the DOI is unknown; the paper
     * card with the reward form (or, to stay resilient, any fragment that
     * names the DOI) means a new request can be posted.
     */
    parse(html: string, doi: string): LookupResult {
      const text = htmlToText(html);
      if (/already posted on sci-net/i.test(text)) return { kind: "existing" };
      if (/not found in crossref/i.test(text)) return { kind: "not_found" };
      // The card ends in "Reward [number input] tokens [request] [cancel]".
      const rewardForm =
        /\breward\b/i.test(text) &&
        (/\btokens?\b/i.test(text) || /<input\b[^>]*\btype\s*=\s*["']?number/i.test(html));
      if (rewardForm || text.toLowerCase().includes(doi.toLowerCase())) return { kind: "new" };
      return { kind: "unknown" };
    },
  },

  /** `POST /request` with JSON `{doi, reward}`; success is HTTP 200. */
  request: {
    path: "/request",
    body(doi: string, reward: number): { doi: string; reward: number } {
      return { doi, reward };
    },
  },

  /** `GET /<doi>`: the request page, open, solved-unaccepted or solved. */
  requestPage: {
    path(doi: string): string {
      return doiPath(doi);
    },
    /**
     * Checked in this order, because a solved-unaccepted page still shows
     * `Reward: N token` (and a `/reward/<doi>` form to raise it):
     *
     * 1. SOLVED_UNACCEPTED: a `/view/<doi>` link, or the phrase "The solution
     *    has not been viewed yet".
     * 2. SOLVED: a storage PDF URL, or the words `requested` and `uploaded`.
     * 3. SOLVED_UNACCEPTED: an uploaded file name (`name.pdf` as an element's
     *    whole text) with no cancel/take link.
     * 4. OPEN: a `/cancel/<doi>` (ours) or `/take/<doi>` (anyone else's) link,
     *    or `Reward: N token`.
     * 5. UNKNOWN otherwise.
     *
     * The machine's sanity check guards whatever gets downloaded.
     */
    parse(html: string): ParsedRequestPage {
      const text = htmlToText(html);
      const pdfUrl = storagePdfUrl(html);
      const rewardMatch = /\bReward:\s*(\d+)\s*tokens?\b/i.exec(text);
      const reward = rewardMatch?.[1] === undefined ? undefined : Number(rewardMatch[1]);
      const control = hasControl(html, "cancel/") || hasControl(html, "take/");
      const viewLink = hasControl(html, "view/");
      const unviewed = /the solution has not been viewed yet/i.test(text);
      const fileName = uploadedFileName(html);
      const solvedWords = /\brequested\b/i.test(text) && /\buploaded\b/i.test(text);

      const unaccepted = (): ParsedRequestPage => {
        const out: ParsedRequestPage = { status: "solved_unaccepted" };
        if (pdfUrl !== undefined) out.pdfUrl = pdfUrl;
        if (fileName !== undefined) out.fileName = fileName;
        if (unviewed) out.unviewed = true;
        if (reward !== undefined) out.reward = reward;
        return out;
      };

      if (viewLink || unviewed) return unaccepted();
      if (pdfUrl !== undefined || solvedWords) {
        return pdfUrl === undefined ? { status: "solved" } : { status: "solved", pdfUrl };
      }
      if (fileName !== undefined && !control) return unaccepted();
      if (control || reward !== undefined) {
        const out: ParsedRequestPage = { status: "open" };
        if (reward !== undefined) out.reward = reward;
        if (/this member is working on solving the request/i.test(text)) out.taken = true;
        return out;
      }
      return { status: "unknown" };
    },
  },

  /** `GET /view/<doi>`: the solution preview; viewing marks it seen. */
  view: {
    path(doi: string): string {
      return `/view${doiPath(doi)}`;
    },
    /**
     * The preview embeds the PDF as `<iframe src="/storage/<32-hex>/<t>.pdf">`
     * (older solutions use `/storage/<y>/<n>/<64-hex>/<t>.pdf`; both match),
     * and the requester gets `<a class="accept" href="/accept/<doi>">`. With
     * `doi` given, only an accept link for that DOI counts.
     */
    parse(html: string, doi?: string): ParsedViewPage {
      const out: ParsedViewPage = { canAccept: hasControl(html, "accept/", doi) };
      const pdfUrl = storagePdfUrl(html);
      if (pdfUrl !== undefined) out.pdfUrl = pdfUrl;
      return out;
    },
  },

  /** `GET /accept/<doi>`: the requester accepts the solution (a plain link). */
  accept: {
    path(doi: string): string {
      return `/accept${doiPath(doi)}`;
    },
    /** Success: a non-error status and a page that is not the login form. */
    ok(status: number, html: string): boolean {
      return status < 400 && !SITE.isLoginPage(html);
    },
  },

  /** `GET /papers/requests`: the owner's requests, newest first. */
  library: {
    path: "/papers/requests",
    /**
     * Rows read `<date time> <status> <year> <title>`, the title linking to
     * `/<doi>`. The status word sits between the previous title link and this
     * one: `solved`, otherwise the request is open.
     */
    parse(html: string): LibraryRow[] {
      const rows: LibraryRow[] = [];
      const seen = new Set<string>();
      let from = 0;
      for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
        const doi = doiOfHref(decodeEntities(m[2] ?? ""));
        if (doi === undefined) continue;
        const before = htmlToText(html.slice(from, m.index));
        const close = html.indexOf("</a>", m.index);
        from = close === -1 ? m.index + m[0].length : close + 4;
        if (seen.has(doi)) continue;
        seen.add(doi);
        rows.push({ doi, status: /\bsolved\b/i.test(before) ? "solved" : "open" });
      }
      return rows;
    },
  },
};
