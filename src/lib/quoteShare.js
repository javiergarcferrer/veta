// Client helpers for the public, interactive quote share link.
//
// The dealer side writes `shareToken`/`shareEnabled` on the quote through the
// normal authed db; these helpers are what the (logged-out) viewer uses to
// talk to the `quote-share` Edge Function, plus the URL builder + token mint.

import { PREVIEW_VERSION } from './previewVersion.js';
import { metaAttribution, isTeamBrowser } from './metaAttribution.js';

const VITE_ENV =
  (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

/**
 * The shareable URL a dealer hands a client. It points at the static
 * link-preview LAUNCHER `/p/cotizacion.html` (not the bare `#/q/<token>`),
 * exactly like every other shared link kind (contrato, cuenta, tienda, togo):
 * the app is a hash-routed SPA, so a crawler only reads the static head of the
 * real path it fetches — when quote links rode the bare origin, the quote card
 * had to live on index.html itself, which leaked "Su propuesta de diseño" onto
 * the app's own tab title and onto a shared bare soft.alcover.do. The launcher
 * carries the quote og:image and forwards a human into `#/q/<slug/token>` (see
 * public/p/cotizacion.html).
 *
 * The `slug/token` suffix rides in `?d=` (the launcher appends it to `#/q/`).
 * An optional `slug` (the "client-name-cotizacion-N" string from
 * lib/quoteNaming) is inserted BEFORE the token so the link a dealer sends
 * reads like the PDF it matches; the token stays the real key (the route
 * ignores the slug). Each segment is encodeURIComponent'd, so the only raw `/`
 * is the join — query-safe, and it round-trips through URLSearchParams
 * untouched. Old-format links (`/?lp=N#/q/…`) keep resolving — the SPA route
 * is untouched.
 *
 * `pv` is the LINK-PREVIEW cache buster shared by every launcher link
 * (lib/previewVersion.js): WhatsApp freezes the card per URL string for weeks,
 * so a re-rendered card ships as a new image filename + a PREVIEW_VERSION bump
 * together (the two-lever rule — see scripts/genOgCards.mjs; the old `?lp=N`
 * lever this replaces burned five bumps learning it).
 */
/**
 * The «Su propuesta de diseño» card — the SAME public jpeg the cotizacion
 * launcher serves as the link's og:image. A quote sent as a TEMPLATE message
 * never gets a crawled preview (WhatsApp shows a bare domain chip instead),
 * so sendQuoteLink attaches this card as the template's IMAGE header when
 * the picked template has one. tests/ogImage.test.js pins this filename to
 * public/p/cotizacion.html's og:image — a card bump (og-card-vN) moves both
 * references plus the PREVIEW_VERSION lever together.
 */
export const QUOTE_CARD_IMAGE = '/og-card-v3.jpg';

export function shareLinkUrl(token, slug) {
  if (!token) return '';
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const suffix = slug
    ? `${encodeURIComponent(slug)}/${encodeURIComponent(token)}`
    : encodeURIComponent(token);
  return `${origin}/p/cotizacion.html?d=${suffix}&pv=${PREVIEW_VERSION}`;
}

/**
 * The static prefix every share link starts with — the URL BASE a WhatsApp
 * template's URL button registers (Meta appends the button's {{1}} variable
 * to it, which sendQuoteLink fills with the `slug/token` suffix). Templates
 * approved before the launcher move registered `…/#/q/` — the suffix is the
 * same `slug/token` for both generations, so old templates keep composing
 * working links (quoteLinkSuffix extracts it from either format).
 */
export function shareLinkBase() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/p/cotizacion.html?d=`;
}

/**
 * The `slug/token` payload of a quote share link, whatever its generation:
 * launcher-format (`/p/cotizacion.html?d=slug/token&pv=N`) or the older
 * hash-format (`…#/q/slug/token`). '' when the URL is not a quote link.
 * This is what a WhatsApp URL button's {{1}} carries — the registered base
 * (old or new) plus this suffix always composes a working link.
 */
export function quoteLinkSuffix(url) {
  const u = String(url || '');
  const hash = u.split('#/q/')[1];
  if (hash) return hash;
  const m = /\/p\/cotizacion\.html\?(?:[^#]*&)?d=([^&#]*)/.exec(u);
  if (m && m[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return '';
}

// The function endpoint, with the public anon key as a query param (not a
// header) so the request stays gateway-acceptable without forcing a custom
// header on every call. The anon key is already public in the bundle.
function endpoint(token) {
  const base = `${SUPABASE_URL}/functions/v1/quote-share?token=${encodeURIComponent(token)}`;
  return SUPABASE_ANON_KEY ? `${base}&apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/** Fetch the client-facing bundle for a token. Throws on invalid/disabled.
 *
 *  The open carries the browser's Meta attribution (`fbc`/`fbp`) so the
 *  server-side ViewContent event — which fires on the FIRST open, before any
 *  form could identify the visitor — goes out with the click id this device
 *  already holds (an earlier ad click into the storefront, or the launcher
 *  forwarding an fbclid), instead of only the click id a past lead stored on
 *  the customer row. The server also first-touch-stores it on the customer so
 *  the eventual Purchase replays it.
 *
 *  The bundle comes back VERBATIM — nothing here projects or whitelists it — so
 *  the Meta fields the server adds ride straight through to the page:
 *  `metaMatch` (the customer's identifiers as SHA-256 digests, for the pixel's
 *  advanced matching — never raw, this is a public surface) and `metaView`
 *  ({eventId, contentName}, present ONLY on the open that fired the server-side
 *  ViewContent, so the page can mirror it browser-side under the same id). Both
 *  are absent on a team preview and on an older server — the page treats
 *  missing as "nothing to do". */
export async function fetchSharedQuote(token) {
  let url = endpoint(token);
  if (isTeamBrowser()) {
    // The dealer previewing a client link is not the client: `internal=1`
    // makes the server skip the whole "visto" machinery — no view count, no
    // "el cliente abrió" push, no Meta event, and crucially no burning of the
    // quote's ONE first-open ViewContent before the real client ever opens it.
    url += '&internal=1';
  } else {
    const { fbclid: fbc, fbp } = metaAttribution();
    if (fbc) url += `&fbc=${encodeURIComponent(fbc)}`;
    if (fbp) url += `&fbp=${encodeURIComponent(fbp)}`;
  }
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/**
 * Apply ONE of the recipient's picks to the real quote and return the FRESH
 * bundle. The owner chose a single source of truth — picks edit the quote in
 * place, so the response is the re-read quote, not a separate selection blob.
 *
 *   pick = { alternatives: { [group]: lineId } }
 *        | { optionals:    { [lineId]: boolean } }
 *        | { materials:    { [lineOrComponentId]: grade } }
 *        | { materialPick: { [lineOrComponentId]: { grade, fabric, swatchImageId } } }
 *               (an empty grade clears the fabric → restores the model's range)
 */
export async function applyClientPick(token, pick) {
  const r = await fetch(endpoint(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pick || {}),
  });
  if (!r.ok) {
    // Surface the server's reason (a pick the share endpoint rejected), like
    // fetchSharedQuote does — a bare "HTTP 400" tells the viewer nothing.
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/** Mint an unguessable share token (122 bits via crypto.randomUUID). */
export function newShareToken() {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
