// Client helpers for the PUBLIC, no-login Togo configurator widget — what the
// logged-OUT embed page (#/embed/configurador) uses to talk to the `togo-embed` Edge
// Function. The anon key rides as a query param (gateway-acceptable without a
// custom header, so the CORS preflight passes), exactly like the storefront.
//
// The widget is distributable per-dealer: an optional `dealerSlug` threads a
// `dealer=<slug>` query into the catalog/lead calls and into every shareable
// URL, so one deploy serves the Alcover storefront (no slug) AND every Ligne
// Roset dealer embedding it (their own slug → re-priced, re-branded, localized
// payload). Every helper stays back-compatible: called with no slug it behaves
// exactly as before.

import { PREVIEW_VERSION } from './previewVersion.js';
import { metaAttribution, viewSessionId, isTeamBrowser } from './metaAttribution.js';
import { safeDynamicImport } from './dynamicImport.js';
// The registry file, not the `brands/` barrel — `lib/*` deliberately pulls only
// what it needs, so a public bundle resolving a URL does not also gain the
// brand admin's view-models. Same reason `runtime.js` is imported directly.
import { configuratorForPathname } from '../brands/configurators/index.js';

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = VITE_ENV.VITE_SUPABASE_ANON_KEY || '';

// Append query params to a URL that may already carry a `?…` (the endpoint
// already has `?apikey=`), skipping empties so a no-slug call is untouched.
function withQuery(url, params) {
  const pairs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  if (!pairs.length) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${pairs.join('&')}`;
}

// The `dealer=<slug>` fragment for a hash-query URL (empty when no slug).
function dealerHashParam(dealerSlug) {
  return dealerSlug ? `dealer=${encodeURIComponent(dealerSlug)}` : '';
}

/** The embeddable widget URL (HashRouter, so `/#/embed/configurador`). Shows the launch
 *  card first (the embed route gates itself behind it). A `dealerSlug` rides as
 *  a hash-query param so the loaded widget knows which dealer it serves. */
export function configuratorEmbedUrl(dealerSlug) {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const q = dealerHashParam(dealerSlug);
  return `${origin}/#/embed/configurador${q ? `?${q}` : ''}`;
}

/**
 * The shareable configurator URL (for WhatsApp / social, NOT for the iframe).
 * It points at the static link-preview LAUNCHER `/p/togo.html` so the
 * configurator link gets its OWN card instead of the generic quote one (the app
 * is a hash-routed SPA — see public/p/togo.html). The launcher forwards straight
 * to `/configurator` (the clean public URL). The iframe embed (configuratorEmbedSnippet)
 * keeps the DIRECT
 * `configuratorEmbedUrl` — an iframe must not bounce through a redirect, and it needs
 * the height-reporting launch card, not a preview shim.
 *
 * A `dealerSlug` becomes a REAL query param on `/configurator` (before `pv`), so
 * a dealer's shared link opens their branded, localized configurator.
 */
export function configuratorShareUrl(dealerSlug) {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  // The clean public configurator URL. Vercel rewrites /configurator to
  // configurator.html, which carries the TOGO link-preview card (so a shared
  // configurator link previews correctly), then boots the app. `pv` busts
  // WhatsApp's per-URL preview cache when the card is re-rendered.
  const dealerQ = dealerSlug ? `dealer=${encodeURIComponent(dealerSlug)}&` : '';
  return `${origin}/configurator?${dealerQ}pv=${PREVIEW_VERSION}`;
}

/** Same widget, flagged as ALREADY inside a fullscreen container (a host-page
 *  overlay or the in-app modal) → it skips its own launch card and drops straight
 *  into the configurator, so there's never a card-inside-a-card. Carries the
 *  `dealerSlug` through, so the new tab the launch card opens stays on-dealer. */
export function configuratorEmbedModalUrl(dealerSlug) {
  const dealerQ = dealerSlug ? `&dealer=${encodeURIComponent(dealerSlug)}` : '';
  return `${configuratorEmbedUrl()}?ctx=modal${dealerQ}`;
}

/**
 * THE DESIGN URL — one link that carries a whole build, used by both ways a
 * design leaves the screen:
 *   • the QR the desktop AR viewer renders (the phone restores the exact layout
 *     and places it life-size — WebAR needs a camera the laptop hasn't got), and
 *   • "Compartir mi diseño": the copyable/shareable link a visitor sends to
 *     whoever else decides, and the dealer reopens to quote.
 *
 * It opens the clean standalone configurator (which drops straight into the
 * build) carrying the encoded build (see lib/configurator/buildShare). `build` is
 * already base64url (URL-safe), so it rides as-is.
 *
 * `lang` rides along so the recipient lands in the SAME language the sender was
 * reading — the widget resolves its locale from `?lang` (see resolveConfiguratorLocale),
 * so a link without it silently reverts to the dealer's default. Returns '' when
 * there's nothing to hand off.
 */
export function configuratorHandoffUrl(dealerSlug, build, { lang } = {}) {
  if (!build) return '';
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const dealerQ = dealerSlug ? `dealer=${encodeURIComponent(dealerSlug)}&` : '';
  const langQ = lang ? `lang=${encodeURIComponent(lang)}&` : '';
  return `${origin}/configurator?${dealerQ}${langQ}build=${build}`;
}

/** The token-gated dealer lead inbox page (HashRouter). The `token` is the ONLY
 *  authorization — the dealer opens this logged-out. */
export function dealerInboxUrl(token) {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/#/dealer/${token}`;
}

/**
 * Any URL as a QR data-URL (PNG) — the install kit's "print this / point a phone
 * at it" half, and the same `qrcode` path the desktop AR handoff already rides
 * (components/configurator/ConfiguratorArViewer): code-split through `safeDynamicImport`, so no
 * surface pays for the encoder until it actually renders one, and a stale-deploy
 * chunk miss recovers instead of stranding the page.
 *
 * Resolves to '' on ANY failure (no URL, encoder unavailable, engine without the
 * chunk): a QR is a convenience next to a copyable link that is already on
 * screen, and it must never be the thing that breaks the panel.
 */
export async function configuratorQrDataUrl(url, { width = 320 } = {}) {
  if (!url) return '';
  try {
    const mod = await safeDynamicImport(() => import('qrcode'));
    const QR = mod.default || mod;
    return await QR.toDataURL(url, { margin: 1, width, errorCorrectionLevel: 'M' });
  } catch { return ''; }
}

// The device-capability grants the in-widget "Ver en tu espacio" (WebAR) needs
// to reach the camera + motion sensors from inside a (cross-origin) iframe.
// Without these on the host's <iframe>, AR Quick Look / WebXR is blocked.
export const CONFIGURATOR_EMBED_ALLOW = 'xr-spatial-tracking; camera; gyroscope; accelerometer; magnetometer; fullscreen';

/**
 * The snippet the dealer pastes into their website: a SELF-SIZING iframe of the
 * launch card (the card — a live Togo turning in Festa Bleu Paon under the
 * "Ligne Roset" wordmark in Rauschen — lives in the route, our origin, so it's
 * always on-brand). The card reports its natural height and the tiny script
 * shrink-wraps the iframe to it → zero dead space. Tapping it opens the
 * configurator in a NEW TAB.
 *
 * A `dealerSlug` threads through the iframe src so the pasted widget loads that
 * dealer's catalog/branding.
 */
/**
 * Is `pathname` a CLEAN configurator URL — ANY brand's?
 *
 * It used to be a regex over two spellings of one word, because there was one
 * configurator. Now there is a registry (`brands/configurators`) and this asks
 * it, so a brand that brings its own configurator becomes reachable by being
 * REGISTERED rather than by having its slug hand-added to a pattern here and
 * in the two other places that ask the same question.
 *
 * Those two others are why this is one function at all: the entry that mounts
 * the standalone page (main.jsx), the page's own "am I standalone?" check, and
 * the forced-light public-route test each carried a copy of the regex, and
 * adding the Spanish spelling to two of them left the third behind —
 * /configurador booted the app and then showed the tap-to-open launch card
 * instead of the configurator.
 *
 * The inline anti-FOUC scripts in index.html / configurador.html carry their own
 * literal copies BY NECESSITY (they run before any module loads); they match the
 * STEM (`/configurador…`) rather than the full set, so a new brand needs no
 * change there.
 */
export function isConfiguratorPathname(pathname) {
  return configuratorForPathname(pathname) != null;
}

/**
 * The paste-into-your-site snippet. `brandName` is the MANUFACTURER whose
 * configurator this is — it becomes the iframe's accessible title, which is
 * what a screen reader announces on the host page. It used to be the literal
 * "Ligne Roset" for every dealer of every brand; unnamed it degrades to the
 * neutral "Configurador", never to somebody else's name.
 */
export function configuratorEmbedSnippet(dealerSlug, { brandName = null } = {}) {
  const cardUrl = configuratorEmbedUrl(dealerSlug);   // the launch card (it opens the configurator in a new tab itself)
  // FULL WIDTH of whatever column the dealer drops it in, inset 40px a side.
  // It used to be capped at `max-width:480px`, which on a ~1000px content column
  // left the card as a narrow strip with a third of the page empty on either
  // side of it. The card itself is responsive — it turns from a stacked layout
  // to piece-beside-type at 640px and caps its own content at 1080px — so
  // handing it the real width is what lets that work at all; the cap was
  // holding it permanently in its phone layout.
  //
  // The inset is `clamp(16px, 4vw, 40px)`: 40px is the ask and what a desktop
  // column gets, but a fixed 80px of total padding on a 375px phone would leave
  // the card 295px wide and cramp everything inside it, so it eases down on
  // small screens. `box-sizing:border-box` keeps the padding INSIDE the 100%.
  //
  // The seed height is 700: tall enough to cover the WIDEST stacked layout (a
  // ~640px column, just under the breakpoint where the card turns two-column),
  // where it measures ~674px. The postMessage below only ever trims — a phone
  // reports ~563px and the frame shrinks to it immediately. Seeding SHORT is the
  // bad direction: the host page visibly jumps the moment the iframe reports,
  // and a host that never runs the script at all would clip the CTA outright.
  const frameTitle = String(brandName || '').trim() || 'Configurador';
  return `<!-- Configurator — self-sizing launch card -->
<div data-togo-embed style="width:100%;margin:0 auto;padding:0 clamp(16px,4vw,40px);box-sizing:border-box">
  <iframe src="${cardUrl}" title="${frameTitle}" scrolling="no" style="width:100%;border:0;display:block;height:700px;overflow:hidden;color-scheme:light"></iframe>
</div>
<script>(function(){var B=document.querySelectorAll('[data-togo-embed]');var box=B[B.length-1];if(!box||box.getAttribute('data-ready'))return;box.setAttribute('data-ready','1');var ifr=box.querySelector('iframe');window.addEventListener('message',function(e){var d=e.data;if(d&&d.type==='togo-embed-height'&&d.height>0&&ifr&&e.source===ifr.contentWindow){ifr.style.height=d.height+'px'}})})();</script>`;
}

function endpoint() {
  const base = `${SUPABASE_URL}/functions/v1/togo-embed`;
  return SUPABASE_ANON_KEY ? `${base}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}` : base;
}

/**
 * Fetch the public Togo catalog: { configured, storeName, logoImageId, rates,
 * models[], dealer? }. With a `dealerSlug`, `&dealer=<slug>` yields the
 * dealer-adjusted, re-branded catalog (or a 404 for an unknown slug — the error
 * carries `.status` so the caller can render a friendly "unavailable" state).
 */
export async function fetchConfiguratorCatalog(dealerSlug) {
  const r = await fetch(withQuery(endpoint(), { dealer: dealerSlug }));
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/* ── The cross-visit catalog snapshot ────────────────────────────────────────
 *
 * The catalog round-trip (an Edge Function cold start + a ~570 KB payload) is
 * the FIRST thing the widget waits on, and it gated the entire first screen on
 * EVERY visit — the owner's "the loading is abysmal" (2026-08-01). Same cure
 * the app shell uses (db/persistentResultCache) and the thumbnails already
 * ride (thumbnails' Cache Storage store): paint from the device's last
 * snapshot instantly, revalidate in the background, swap only if the content
 * actually changed.
 *
 * Same best-effort contract as the thumbnail store: Cache Storage is absent /
 * partitioned / denied in some third-party-iframe contexts, and a store that
 * isn't there must cost exactly what it did before — one network wait. Nothing
 * here throws into a caller.
 *
 * Staleness is bounded by the revalidate: the snapshot paints for the seconds
 * the fresh fetch needs, then the fresh payload replaces it (prices included).
 * The quote a lead turns into is priced SERVER-side regardless (togo-quote
 * parity), so a briefly stale display estimate can never mis-price anyone.
 */
const CATALOG_STORE = 'togo-catalog-v1';

async function catalogStore() {
  try {
    if (typeof caches === 'undefined' || !caches?.open) return null;
    return await caches.open(CATALOG_STORE);
  } catch { return null; }
}

/** A stored payload is paintable only if it still looks like a catalog — the
 *  minimal shape every consumer reads. Anything else reads as a miss. */
function isCatalogSnapshot(data) {
  return !!(data && typeof data === 'object' && Array.isArray(data.models));
}

async function readCatalogSnapshot(url) {
  try {
    const store = await catalogStore();
    const res = store && await store.match(url);
    if (!res) return null;
    const data = await res.json();
    return isCatalogSnapshot(data) ? data : null;
  } catch { return null; }
}

/** Write-behind — the caller already has its payload by the time this runs. */
function writeCatalogSnapshot(url, data) {
  (async () => {
    const store = await catalogStore();
    if (!store) return;
    await store.put(url, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  })().catch(() => {});
}

function dropCatalogSnapshot(url) {
  (async () => { const store = await catalogStore(); if (store) await store.delete(url); })().catch(() => {});
}

/**
 * The catalog, snapshot-first: resolves with the device's stored payload
 * immediately when one exists (revalidating in the background), else with the
 * network fetch. `onRefresh` fires ONLY when the background revalidate changes
 * the answer: `{ data }` for a payload whose content differs from the painted
 * snapshot, `{ error }` when the dealer stopped existing (HTTP 404 — the
 * distribution kill switch must still tear the widget down, and the dead
 * snapshot is dropped so the next boot can't resurrect it). A network blip on
 * revalidate is silent: the painted snapshot IS the answer.
 */
export async function fetchConfiguratorCatalogCached(dealerSlug, { onRefresh } = {}) {
  const url = withQuery(endpoint(), { dealer: dealerSlug });
  const snapshot = await readCatalogSnapshot(url);
  if (!snapshot) {
    const fresh = await fetchConfiguratorCatalog(dealerSlug);
    writeCatalogSnapshot(url, fresh);
    return fresh;
  }
  (async () => {
    try {
      const fresh = await fetchConfiguratorCatalog(dealerSlug);
      writeCatalogSnapshot(url, fresh);
      if (JSON.stringify(fresh) !== JSON.stringify(snapshot)) onRefresh?.({ data: fresh });
    } catch (e) {
      if (e?.status === 404) { dropCatalogSnapshot(url); onRefresh?.({ error: e }); }
    }
  })();
  return snapshot;
}

/**
 * Fetch the plan OUTLINES for a few models: `?svg=<id,id,…>` → `{ [id]: svg }`.
 *
 * The catalog payload no longer carries `svg`: 605 CAD outlines were HALF its
 * bytes (589 KB of 1.16 MB, measured 2026-08-01) for a field exactly ONE surface
 * reads — the plan → DXF export. Everything on screen derives its silhouette
 * from the MESH instead. So the outlines are pulled for the handful of pieces a
 * visitor actually placed, at the moment they export.
 *
 * Resolves to `{}` on ANY failure (the server caps the list at 40 ids and answers
 * `{}` for unknown ones): a missing outline costs the DXF that piece's silhouette
 * — planToDxf falls back to its footprint rectangle, so sizes and positions are
 * still exact — and the export must never die on a network hiccup.
 */
export async function fetchConfiguratorPlanSvgs(ids) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))].slice(0, 40);
  if (!list.length) return {};
  try {
    const r = await fetch(withQuery(endpoint(), { svg: list.join(',') }), {
      // Reached off globalThis and optional-called: an older engine without
      // AbortSignal.timeout simply gets no timeout, instead of a TypeError that
      // would silently cost every export its outlines.
      signal: globalThis.AbortSignal?.timeout?.(8000),
    });
    if (!r.ok) return {};
    const body = await r.json();
    return body && typeof body === 'object' ? body : {};
  } catch { return {}; }
}

/**
 * Submit a quote request (a lead). `payload` =
 *   { contact: { name, phone, email }, items: [{ modelId, x, y, rot }],
 *     estimateUsd?, note? }
 * A `dealerSlug` adds `dealer: <slug>` to the body so the lead is routed to that
 * dealer's Togo workspace (absent → Alcover's own embed). The lead lands as a
 * PENDING togo_request (it is NOT auto-injected into Cotizaciones). Resolves to
 * { ok } or throws.
 */
export async function submitConfiguratorRequest(payload, dealerSlug) {
  // Meta click id / browser id ride along so an ad-driven build can be credited
  // to the ad — the server only reports it for Alcover's own embed, never a
  // routed dealer's lead (lib/metaAttribution, functions/togo-embed). A TEAM
  // browser sends the flag instead: the request still lands, Meta hears nothing.
  const withAttribution = {
    ...payload,
    ...(isTeamBrowser() ? { internal: true } : metaAttribution()),
  };
  const body = dealerSlug ? { ...withAttribution, dealer: dealerSlug } : withAttribution;
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resBody = await r.json().catch(() => ({}));
  if (!r.ok || !resBody?.ok) {
    const e = new Error(resBody?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return resBody;
}

/**
 * Read a dealer's token-gated lead inbox: `&inbox=<token>` →
 *   { dealer, requests: [{ id, status, contact, note, estimateUsd, createdAt,
 *     items }], modelNames: { <modelId>: <name> } }.
 * The token is the only authorization. Throws an Error with `.status` on !ok
 * (mirrors fetchConfiguratorCatalog's error idiom).
 */
export async function fetchDealerInbox(token) {
  const r = await fetch(withQuery(endpoint(), { inbox: token }));
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/**
 * Update one of a dealer's own leads from the token-gated inbox:
 *   POST { inbox: <token>, action: 'setStatus', id, status } → { ok: true }.
 * `status` is 'pending' | 'contacted'. Throws an Error with `.status` on !ok
 * (same idiom as submitConfiguratorRequest).
 */
export async function updateDealerLead(token, id, status) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inbox: token, action: 'setStatus', id, status }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.ok) {
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return body;
}

/**
 * ONE dealer quote op, token-gated — the dealer dashboard's write path.
 *   POST { inbox: <token>, quoteOp, ...payload }
 * The inbox token is the only authorization, and the server scopes every op to
 * that dealer's own rows (a foreign id answers 404, exactly like a missing
 * one). Ops: 'create' {requestId} · 'list' · 'get' {id} ·
 * 'setStatus' {id,status} · 'share' {id,enabled}.
 * Mirrors updateDealerLead's error idiom (an Error carrying `.status`).
 */
export async function dealerQuoteOp(token, quoteOp, payload = {}) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inbox: token, quoteOp, ...payload }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.error) {
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return body;
}

// Once per visit: a view is a signal, not a counter.
let configuratorViewReported = false;

/**
 * Report a PRICED composition → Meta `ViewContent`.
 *
 * The configurator's mid-funnel signal: pieces placed and a fabric chosen, so
 * there is a real number on screen — but no quote requested yet. That is the
 * retargeting audience worth having, and it was invisible: the only event this
 * widget sent fired on submit, i.e. the small minority who finish.
 *
 * The server skips it entirely for a routed dealer's embed — their visitors are
 * their audience, not Alcover's. Silent and fire-and-forget: this rides a
 * public widget and must never interrupt anyone.
 */
export function reportConfiguratorView({ estimateUsd = 0, pieces = 0, dealerSlug = '' } = {}) {
  // This ping exists ONLY to tell Meta — a team browser sends nothing at all.
  if (configuratorViewReported || isTeamBrowser()) return;
  configuratorViewReported = true;
  try {
    const body = {
      view: { estimateUsd, pieces, sessionId: viewSessionId(), ...metaAttribution() },
    };
    if (dealerSlug) body.dealer = dealerSlug; // the server refuses it — belt and braces
    fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch { /* never worth a visitor's error */ }
}
