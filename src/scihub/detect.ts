import { hasPdfMarkup } from "./parse.ts";

/**
 * Bot walls that mean "this mirror will not serve us right now". Title-level
 * markers are unambiguous and count even if the page somehow carries PDF
 * markup. Body-level markers are only trusted when there is no PDF markup,
 * because legitimate article pages embed captcha widgets (sci-hub.ru ships an
 * altcha widget for its request form) and CDN scripts.
 */
const TITLE_MARKERS: RegExp[] = [
  /<title>\s*DDoS-Guard/i,
  /<title>\s*Just a moment/i,
  /<title>\s*Checking your browser/i,
  /<title>\s*Attention Required!\s*\|\s*Cloudflare/i,
];

const BODY_MARKERS: RegExp[] = [
  /ddos-guard/i,
  /checking your browser/i,
  /\/cdn-cgi\/challenge-platform\//i,
  /cf-turnstile|challenges\.cloudflare\.com\/turnstile/i,
  /<form\b[^>]*captcha/i,
  /\bname\s*=\s*["']?captcha/i,
  /\bclass\s*=\s*["'][^"']*\b(?:g-recaptcha|h-captcha)\b/i,
];

/** True when the page is a challenge/interstitial rather than a mirror answer. */
export function isChallengePage(html: string): boolean {
  if (TITLE_MARKERS.some((re) => re.test(html))) return true;
  if (hasPdfMarkup(html)) return false;
  return BODY_MARKERS.some((re) => re.test(html));
}

/**
 * Pages third-party mirrors (and sci-hub.ru, via a 404 status) return when
 * they do not hold the DOI. The Russian 404 text on sci-hub.ru cannot appear in
 * this ASCII-only source; that mirror answers 404, which the resolver checks
 * first.
 */
const NOT_FOUND_MARKERS: RegExp[] = [
  /search proxy to download article/i,
  /no matching proxies found/i,
  /article not found/i,
];

export function isNotFoundPage(html: string): boolean {
  return NOT_FOUND_MARKERS.some((re) => re.test(html));
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * `%PDF-` magic. Readers accept the header anywhere in the first 1024 bytes
 * (some servers prepend whitespace or a BOM), so this does too.
 */
export function isPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let i = 0; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (bytes[i + j] !== PDF_MAGIC[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
