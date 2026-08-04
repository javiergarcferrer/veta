/**
 * Meta ad attribution capture — the browser half.
 *
 * When someone clicks an Instagram ad, Meta appends `?fbclid=…` to the landing
 * URL. That click id is the ONLY thing that connects the ad spend to what
 * happens next, and it is available for exactly one page load: the visitor
 * navigates, the param is gone, and by the time they accept a RD$400,000 quote
 * six weeks later there is nothing left to attribute it to.
 *
 * So: grab it on the first paint of every PUBLIC surface, park it in
 * localStorage for the rest of the visit, and hand it to whatever lead the
 * visitor eventually submits (the storefront form, the Togo configurator). The
 * server stores it on the CONTACT — first touch wins — and replays it on every
 * later conversion. See supabase/functions/meta-capi/events.ts.
 *
 * Also reads `_fbp`, the browser id cookie Meta's own pixel writes. We never
 * fabricate one: an invented fbp is a browser that doesn't exist and matches
 * nobody. If the pixel isn't on the page, the field is simply absent.
 *
 * THE `_fbc` COOKIE — Meta's "parameter builder" contract. The pixel writes a
 * `_fbc` cookie when it sees `fbclid` in `location.search`, and Events Manager
 * scores fbc coverage by whether server events carry it. Two failure modes made
 * our coverage read as zero: the pixel never sees a hash-routed fbclid
 * (`/#/tienda?fbclid=…`) so it never writes the cookie, and our own capture
 * never READ the cookie, so a click id living only there (an earlier visit,
 * localStorage blocked or expired) was invisible to every event we sent. So the
 * capture now works both directions: a URL fbclid is built AND written to
 * `_fbc` (Meta's own 90-day expiry — the pixel's browser events pick it up from
 * there), and when the URL has none, the remembered value is the NEWER of
 * localStorage and the cookie, by the click timestamp embedded in the value.
 *
 * Browser-only by nature (URL + cookies + localStorage) and defensive
 * throughout: a blocked storage API or a hostile query string must never break
 * a storefront page. Everything here degrades to '' .
 */

const CLICK_KEY = 'rs.fbclid';
const SESSION_KEY = 'rs.sid';
const FBC_COOKIE = '_fbc';
/** Meta's own expiry for the `_fbc` cookie its pixel writes. */
const FBC_COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60;
/** Meta attributes a click for up to 90 days, but a click id sitting in
 *  localStorage for three months is almost certainly a different visit — and a
 *  stale id attributes a fresh organic lead to an old ad. 30 days matches the
 *  dealer's sales cycle without over-claiming. */
const CLICK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A raw fbclid → the `fb.<subdomainIndex>.<clickTimeMs>.<fbclid>` form the
 *  Conversions API matches on. Mirrors buildFbc in meta-capi/events.ts (the
 *  Deno↔Vite wall forbids sharing the module; the shape is pinned by
 *  tests/metaCapi.test.js on the server side). */
export function buildFbc(fbclid, clickTimeMs) {
  const raw = String(fbclid ?? '').trim();
  if (!raw) return '';
  if (/^fb\.\d+\.\d+\./.test(raw)) return raw; // already built
  if (!/^[\w.-]{6,400}$/.test(raw)) return ''; // junk in a public query param
  const ts = Number(clickTimeMs);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return `fb.1.${Math.floor(ts)}.${raw}`;
}

/** Read a cookie by name, '' when absent or unreadable. */
function cookie(name) {
  try {
    const m = String(document.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  } catch { return ''; }
}

/** The `_fbc` cookie, but only when it holds a well-formed built value — a
 *  cookie is writable by anything on the page, and this value ends up in query
 *  params and JSON bodies, so shape + charset are enforced on the way in. */
function readFbcCookie() {
  const v = cookie(FBC_COOKIE).trim();
  return /^fb\.\d+\.\d+\.[\w.-]{6,400}$/.test(v) ? v : '';
}

/** Persist a built fbc as the `_fbc` cookie (no-op when already there). The
 *  charset is pre-validated by buildFbc/readFbcCookie, so the value is
 *  cookie-safe verbatim — written raw, exactly as Meta's pixel writes it. */
function writeFbcCookie(fbc) {
  try {
    if (!fbc || cookie(FBC_COOKIE) === fbc) return;
    document.cookie = `${FBC_COOKIE}=${fbc}; max-age=${FBC_COOKIE_MAX_AGE_S}; path=/; SameSite=Lax`;
  } catch { /* a blocked cookie jar never breaks a public page */ }
}

/** The click-time ms embedded in a built value (`fb.<i>.<ms>.<id>`), 0 when
 *  unparsable — the tiebreak between two remembered click ids. */
function fbcClickTime(fbc) {
  const m = /^fb\.\d+\.(\d+)\./.exec(String(fbc || ''));
  return m ? Number(m[1]) : 0;
}

function readStore() {
  try {
    const raw = window.localStorage.getItem(CLICK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v?.fbc || !Number.isFinite(v?.at)) return null;
    return Date.now() - v.at > CLICK_TTL_MS ? null : v;
  } catch { return null; }
}

/**
 * Capture the click id from the CURRENT url, if there is one, and remember it.
 * Idempotent and cheap — safe to call on every public page mount.
 *
 * The param can arrive on the query string OR inside the hash (this app is
 * hash-routed: `/#/tienda?fbclid=…` puts it in `location.hash`, where
 * `URLSearchParams(location.search)` will never see it). Both are checked, which
 * is the difference between attribution working and silently not.
 *
 * @returns {string} the stored `fbc` value ('' when there has never been one)
 */
export function captureMetaClickId() {
  if (typeof window === 'undefined') return '';
  let fbclid = '';
  try {
    fbclid = new URLSearchParams(window.location.search).get('fbclid') || '';
    if (!fbclid) {
      const hash = String(window.location.hash || '');
      const q = hash.indexOf('?');
      if (q >= 0) fbclid = new URLSearchParams(hash.slice(q + 1)).get('fbclid') || '';
    }
  } catch { fbclid = ''; }

  if (fbclid) {
    const fbc = buildFbc(fbclid, Date.now());
    // A NEW click always wins over a remembered one — the visitor just clicked
    // an ad, and that is the ad that should get the credit for this visit.
    if (fbc) {
      try { window.localStorage.setItem(CLICK_KEY, JSON.stringify({ fbc, at: Date.now() })); } catch { /* private mode */ }
      // The parameter-builder half: the pixel reads `_fbc` for its own browser
      // events but can't see a hash-routed fbclid, so the cookie is written
      // here or not at all.
      writeFbcCookie(fbc);
      return fbc;
    }
  }
  // No click on this URL — replay a remembered one. Two independent stores can
  // disagree (our capture vs Meta's pixel, different visits): the NEWER click
  // wins, same rule as above, decided by the timestamp inside the value. The
  // winner is re-written to the cookie so both stores converge and the pixel's
  // browser events carry the same id the server events do.
  const stored = readStore()?.fbc || '';
  const fromCookie = readFbcCookie();
  const winner = fbcClickTime(fromCookie) > fbcClickTime(stored) ? fromCookie : stored || fromCookie;
  if (winner) writeFbcCookie(winner);
  return winner;
}

/**
 * The attribution block to send with a lead. Spread it into the POST body:
 * `{ ...lead, ...metaAttribution() }`.
 *
 * @returns {{fbclid: string, fbp: string, sourceUrl: string}} empty strings when
 *          nothing is known — the server drops empty fields.
 */
export function metaAttribution() {
  if (typeof window === 'undefined') return { fbclid: '', fbp: '', sourceUrl: '' };
  return {
    // Already in `fb.1.…` form; the server passes a built value through.
    fbclid: captureMetaClickId(),
    fbp: cookie('_fbp'),
    sourceUrl: (() => { try { return String(window.location.href || '').slice(0, 500); } catch { return ''; } })(),
  };
}

/**
 * Is this browser one of OURS? The team signs into the back office in the same
 * browser they use to preview the Tienda, the configurator and client quote
 * links — and every one of those previews was reported to Meta as a real
 * shopper, polluting the very data the ad accounts optimize on (a dealer
 * preview even burned a quote's one first-open ViewContent). Supabase persists
 * the session under `sb-<ref>-auth-token` in localStorage, so the key's
 * presence — even expired — marks a team device. Every Meta send path checks
 * this and stays silent on a team browser; blocked storage reads as a shopper
 * (public visitors are the ones with strict privacy modes, and they ARE the
 * audience).
 */
export function isTeamBrowser() {
  try {
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i) || '';
      if (/^sb-.+-auth-token$/.test(k) && ls.getItem(k)) return true;
    }
  } catch { /* no storage = not signed in here */ }
  return false;
}

/**
 * A per-visit id used only to DEDUPE product views.
 *
 * Not a person and not a tracker: it is random, lives in sessionStorage, and
 * dies with the tab. Its whole job is so that browsing back and forth over the
 * same piece reports one view instead of twenty.
 */
export function viewSessionId() {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = `s${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch { return ''; } // private mode → the server falls back to the IP
}
