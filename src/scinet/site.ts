/**
 * Every sci-net.xyz specific detail lives here, in one `SITE` object, so the
 * capture in docs/scinet-capture.md can correct it in one place.
 *
 * Known (captured 2026-10-16, logged out): login is `POST https://sci-net.xyz/`
 * with form-urlencoded `user`, `pass`, `action=login`, no CSRF token,
 * server-rendered pages and a cookie session.
 *
 * Everything marked `TODO(capture)` is a best guess that has NOT been observed
 * yet. Parsers are plain string/regex functions (no HTMLRewriter) so they run
 * under Node in unit tests as well as in workerd.
 */

export type RemoteStatus = "open" | "solved" | "unknown";

export interface ParsedRequestPage {
  status: RemoteStatus;
  /** Absolute or site-relative URL of the uploaded PDF, when solved. */
  pdfUrl?: string;
  /** ISO timestamp of the upload, when the page shows one. */
  uploadedAt?: string;
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

// TODO(capture): the real request URL shape. Guess: /request/<id>.
const REQUEST_PATH_RE = /\/request\/([A-Za-z0-9_-]+)/;

function requestIdIn(s: string): string | undefined {
  return REQUEST_PATH_RE.exec(s)?.[1];
}

export const SITE = {
  base: "https://sci-net.xyz",

  /** Browser-like UA; the site is a normal server-rendered web app. */
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",

  login: {
    // Known: captured logged out on 2026-10-16.
    path: "/",
    userField: "user",
    passField: "pass",
    extraFields: { action: "login" } as Record<string, string>,
  },

  /**
   * How long a stored session cookie is trusted before we log in again
   * proactively. TODO(capture): the real cookie lifetime.
   */
  sessionTtlSeconds: 12 * 60 * 60,

  /**
   * True when the HTML is the login form, i.e. we are not logged in. The login
   * form carries a `pass` input and the `action=login` field.
   */
  isLoginPage(html: string): boolean {
    // TODO(capture): confirm against a real logged-out page.
    return (
      /<input\b[^>]*\bname\s*=\s*["']?pass["'\s/>]/i.test(html) &&
      /\bvalue\s*=\s*["']?login["'\s/>]/i.test(html)
    );
  },

  /** True when a redirect Location points at the login page. */
  isLoginRedirect(location: string | null): boolean {
    if (location === null) return false;
    // TODO(capture): where protected pages send a logged-out visitor. "/" and
    // anything mentioning login are the plausible answers.
    let path: string;
    try {
      path = new URL(location, SITE.base).pathname;
    } catch {
      return false;
    }
    return path === "/" || /login|signin/i.test(path);
  },

  existing: {
    /** Page that shows whether a DOI already has a request. */
    path(doi: string): string {
      // TODO(capture): the "already requested" lookup. Guess: the DOI page.
      return `/${doi.split("/").map(encodeURIComponent).join("/")}`;
    },
    /** Request id of an existing request for the DOI, if the page shows one. */
    parse(html: string): string | undefined {
      // TODO(capture): guess: the DOI page links to the request page.
      for (const href of hrefs(html)) {
        const id = requestIdIn(href);
        if (id !== undefined) return id;
      }
      return undefined;
    },
  },

  request: {
    // TODO(capture): the request form endpoint and field names.
    path: "/request",
    doiField: "doi",
    bountyField: "reward",
    extraFields: { action: "request" } as Record<string, string>,
    /**
     * Request id from the POST response: the redirect Location when the server
     * redirects to the new request page, otherwise a request link in the body.
     */
    parseId(location: string | null, html: string): string | undefined {
      // TODO(capture): how the new request id is returned.
      if (location !== null) {
        const id = requestIdIn(location);
        if (id !== undefined) return id;
      }
      return SITE.existing.parse(html);
    },
  },

  requestPage: {
    path(id: string): string {
      // TODO(capture): request page URL.
      return `/request/${encodeURIComponent(id)}`;
    },
    /** Status of a request page. */
    parse(html: string): ParsedRequestPage {
      // TODO(capture): how fulfilment is shown. Guess: a link to a .pdf (or a
      // /download/ link) plus a "solved"/"fulfilled" marker; open requests say
      // "open", "waiting" or "pending".
      const pdfUrl = hrefs(html).find(
        (h) => /\.pdf(?:$|[?#])/i.test(h) || /\/(?:download|file|pdf)\//i.test(h),
      );
      const text = htmlToText(html).toLowerCase();
      const solvedWord = /\b(?:solved|fulfilled|uploaded|completed)\b/.test(text);
      const openWord = /\b(?:open|waiting|pending|unsolved)\b/.test(text);
      const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
      const uploadedAt =
        time !== undefined && !Number.isNaN(Date.parse(time))
          ? new Date(time).toISOString()
          : undefined;
      if (pdfUrl !== undefined && (solvedWord || !openWord)) {
        return uploadedAt !== undefined
          ? { status: "solved", pdfUrl, uploadedAt }
          : { status: "solved", pdfUrl };
      }
      if (openWord) return { status: "open" };
      return { status: "unknown" };
    },
  },

  verify: {
    // TODO(capture): the verify / accept control on a solved request page.
    path(id: string): string {
      return `/request/${encodeURIComponent(id)}`;
    },
    fields(id: string): Record<string, string> {
      return { action: "verify", id };
    },
    /** True when the response confirms the verification. */
    parseOk(status: number, html: string): boolean {
      // TODO(capture): what a successful verify returns. Guess: any non-error
      // status that is not the login page and does not mention an error.
      if (status >= 400) return false;
      if (SITE.isLoginPage(html)) return false;
      return !/\berror\b|\bfailed\b/i.test(htmlToText(html));
    },
  },
};
