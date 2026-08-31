// Clickjacking guard for the hash-routed app document — the CLIENT half of the
// pentest M1 remediation. The server half CANNOT be response headers: the
// dealer-distributable embeds (#/embed/configurador — the iframe snippet pasted into
// alcover.do and any Ligne Roset dealer's site — and #/tienda, framed in the
// dealer's Shopify page) are FRAGMENT routes, so the server sees every one of
// them as a request for `/`, the same document as the whole back-office. A
// `frame-ancestors`/`X-Frame-Options` header on `/` therefore blocks the money
// app and the public widgets ALIKE — shipping `frame-ancestors 'none'` is
// exactly how every pasted embed broke on 2026-08-05 ("soft.alcover.do refused
// to connect"), and no allow-list can work either: dealer sites are data (a
// slug row), unknown at deploy time. Framing is decided HERE, per hash route,
// at render time: a framed document renders NOTHING but the embeddable public
// surfaces. An attacker's iframe sandbox can neutralize frame-busting
// NAVIGATION, but it cannot force this gate to mount the app — refusing to
// render is the control. Pinned by tests/frameGuard.test.js (which also pins
// vercel.json free of frame-blocking headers).

/** True when this document runs inside ANY frame. A cross-origin `top` can
 *  throw on access in exotic hosts — that only happens framed, so it counts. */
export function isFramed(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return false;
  try {
    return w.self !== w.top;
  } catch {
    return true;
  }
}

/**
 * The hash-router routes allowed to render inside a host page's iframe — the
 * public, logged-out widgets DESIGNED to be framed, and nothing else:
 *   /embed/*   the Togo configurator widget (configuratorEmbedSnippet, per-dealer)
 *   /tienda    the public storefront (framed in the dealer's Shopify site)
 * Everything else framed — login, the whole back-office, the token'd client
 * links — is a clickjacking canvas and must refuse to render. `routePath` is
 * the router's `location.pathname` (the HASH path), never `window.location`.
 */
export function isEmbeddableRoute(routePath) {
  const p = String(routePath || '');
  return p === '/tienda' || p.startsWith('/tienda/') || p.startsWith('/embed/');
}
