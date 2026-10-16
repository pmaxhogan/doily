// Server-rendered HTML for the consent flow: the consent form, the hand-off page
// that sends the browser back to the client, and a plain error page.
//
// No framework, no script, no external asset. Every value that came from the
// client (name, redirect URI, scopes) is escaped; the provider's own docs say
// all of it is client-controlled.

const BASE_STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .warn { border-left: 4px solid #c60; padding-left: 0.75rem; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: 0.5rem 1.25rem; cursor: pointer; }
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 128 random bits, base64url. Fresh per response: a reused nonce is no nonce. */
export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Strict hardening headers for every HTML response here. The CSP allows one
 * nonce'd inline <style> and nothing else: no script at all, forms may only
 * post to this origin, and the page cannot be framed (so it cannot be
 * clickjacked into approving a grant).
 */
export function securityHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      "img-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };
}

function layout(nonce: string, title: string, body: string, head = ""): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    head,
    `<title>${escapeHtml(title)}</title>`,
    `<style nonce="${nonce}">${BASE_STYLE}</style>`,
    "</head>",
    `<body>${body}</body>`,
    "</html>",
  ].join("\n");
}

export interface ConsentView {
  clientName: string;
  clientDomain?: string | undefined;
  redirectUri: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scopes: string[];
  handle: string;
}

export function consentPage(nonce: string, view: ConsentView): string {
  const scopes = view.scopes.length > 0 ? view.scopes.join(" ") : "papers";
  const domain = view.clientDomain
    ? `<dt>Verified domain</dt><dd>${escapeHtml(view.clientDomain)}</dd>`
    : "";
  const loopback = view.redirectIsLoopback
    ? '<p class="warn">The redirect goes to an app on this computer. Any local program could be ' +
      "listening, whatever name the client claims.</p>"
    : "";
  const body = `
<h1>Allow ${escapeHtml(view.clientName)} to use doily?</h1>
<p>This grants access to doily's paper search and full-text tools.</p>
<dl>
  <dt>Client</dt><dd>${escapeHtml(view.clientName)}</dd>
  ${domain}
  <dt>Sends tokens to</dt><dd>${escapeHtml(view.redirectHost)}</dd>
  <dt>Redirect URI</dt><dd>${escapeHtml(view.redirectUri)}</dd>
  <dt>Scope</dt><dd>${escapeHtml(scopes)}</dd>
</dl>
${loopback}
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(view.handle)}">
  <div class="actions">
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`;
  return layout(nonce, "Authorize doily", body);
}

/**
 * Sends the browser to `target` with a meta refresh, plus a link as the
 * no-refresh fallback. A 302 answering the form POST would be blocked by the
 * consent page's own `form-action 'self'` in Chrome, which applies the
 * directive to redirects after submission; a 200 page that then navigates is
 * not subject to it.
 */
export function handOffPage(nonce: string, target: string): string {
  const href = escapeHtml(target);
  return layout(
    nonce,
    "Returning to the app",
    `<p>Returning to the app. <a href="${href}">Continue</a> if nothing happens.</p>`,
    `<meta http-equiv="refresh" content="0;url=${href}">`,
  );
}

export function errorPage(nonce: string, title: string, message: string): string {
  return layout(nonce, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
