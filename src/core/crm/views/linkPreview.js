// Link previews for the chat inboxes (WhatsApp + Instagram Direct) — the
// dealer-side render of what the CLIENT sees when a link lands in a chat.
//
// Pure string Model, two pieces:
//   • splitMessageLinks(text) — URL detection, so bubbles linkify instead of
//     printing a dead string.
//   • resolveLinkPreview(text) — the preview card for the FIRST link. The
//     browser can't crawl arbitrary URLs (CORS), so rich cards only exist for
//     OUR OWN shared-link kinds: every launcher page under public/p/*.html
//     (+ configurator.html) carries a static og card, and this catalog mirrors
//     those exact title/description/og:image values — the inbox then shows the
//     SAME card WhatsApp renders on the client's phone. Any other URL resolves
//     to { url, domain } only (rendered as a plain clickable link).
//
// tests/linkPreview.test.js pins this catalog to the launcher pages' ACTUAL
// og tags — a card bump (og-*-vN.jpg) or copy change goes red there until the
// catalog moves with it. Keep images root-relative: the app serves the same
// public/ assets as the shared origin.

import { QUOTE_CARD_IMAGE } from '../../../lib/quoteShare.js';
import { CONTRACT_CARD_IMAGE } from '../../../lib/contractShare.js';
import { STATEMENT_CARD_IMAGE } from '../../../lib/accountStatementShare.js';
import { PREVIEW_VERSION } from '../../../lib/previewVersion.js';

// Launcher kind → the static card its page serves (public/p/<kind>.html).
const LAUNCHER_CARDS = {
  cotizacion: {
    title: 'Su propuesta de diseño · ALCOVER',
    description: 'Telas, dimensiones y total. Ábrela para cotizar en vivo.',
    image: QUOTE_CARD_IMAGE,
  },
  contrato: {
    title: 'Su plan de pago · ALCOVER',
    description: 'Revíselo y fírmelo en línea, desde su teléfono.',
    image: CONTRACT_CARD_IMAGE,
  },
  cuenta: {
    title: 'Su estado de cuenta · ALCOVER',
    description: 'Saldos, cargos y pagos en un lugar.',
    image: STATEMENT_CARD_IMAGE,
  },
  tienda: {
    title: 'Tienda ALCOVER',
    description: 'Explore la colección, disponible ahora.',
    image: '/og-tienda-v8.jpg',
  },
  togo: {
    title: 'Diseñe su Togo · ALCOVER',
    description: 'Combine módulos y telas y véalo en vivo.',
    image: '/og-togo-v8.jpg',
  },
};

/**
 * The COMPLETE library of shared-link kinds and their preview cards — the
 * design palette for WhatsApp templates (Difusión → Plantillas renders it so
 * the dealer builds templates around the card each link will show).
 *
 *   resolvePreviewLibrary(origin) → [{
 *     kind, label, title, description, image,   // the og card, per LAUNCHER_CARDS
 *     buttonBase,   // the URL base a template's dynamic URL button registers —
 *                   // per-recipient kinds end at `?d=` (the {{1}} suffix is the
 *                   // recipient's token); campaign-wide kinds end at `?pv=`
 *                   // (the suffix is just the preview version), so ONE template
 *                   // machinery covers both.
 *     buttonText,   // suggested CTA for the button
 *     perRecipient, // true ⇒ each recipient gets their own link (quote/contract/
 *                   // statement); false ⇒ one public link for everyone (store/togo)
 *   }]
 *
 * Bases mirror the lib builders (shareLinkBase · contractShareUrl ·
 * accountStatementShare · storeLinkUrl · togoShareUrl) — pinned round-trip in
 * tests/linkPreview.test.js: every buttonBase must resolve back to its own
 * card through resolveLinkPreview, so the library can never drift from the
 * resolver (or the launcher pages behind it).
 */
export function resolvePreviewLibrary(origin = '') {
  const o = String(origin || '').replace(/\/$/, '');
  return [
    { kind: 'cotizacion', label: 'Cotización', ...LAUNCHER_CARDS.cotizacion, perRecipient: true, buttonBase: `${o}/p/cotizacion.html?d=`, buttonText: 'Ver cotización' },
    { kind: 'contrato', label: 'Plan de pago (contrato)', ...LAUNCHER_CARDS.contrato, perRecipient: true, buttonBase: `${o}/p/contrato.html?d=`, buttonText: 'Ver plan de pago' },
    { kind: 'cuenta', label: 'Estado de cuenta', ...LAUNCHER_CARDS.cuenta, perRecipient: true, buttonBase: `${o}/p/cuenta.html?d=`, buttonText: 'Ver estado de cuenta' },
    { kind: 'tienda', label: 'Tienda', ...LAUNCHER_CARDS.tienda, perRecipient: false, buttonBase: `${o}/p/tienda.html?pv=`, buttonText: 'Ver la tienda' },
    { kind: 'togo', label: 'Configurador Togo', ...LAUNCHER_CARDS.togo, perRecipient: false, buttonBase: `${o}/configurator?pv=`, buttonText: 'Diseñar mi Togo' },
  ];
}

/** The full shareable link for a campaign-wide (non-per-recipient) library
 *  entry — the buttonBase plus the current preview version as its suffix,
 *  identical to storeLinkUrl()/togoShareUrl(). */
export function previewLibraryLink(entry) {
  return entry?.perRecipient ? '' : `${entry?.buttonBase || ''}${PREVIEW_VERSION}`;
}

const URL_RE = /https?:\/\/\S+/g;
// Trailing prose punctuation is not part of the link ("mira https://x.do/p!").
const TRAILING_PUNCT_RE = /[).,;:!?…»"'\]]+$/;

/**
 * Split a message body into text/link segments for linkified rendering.
 *
 *   splitMessageLinks('mira https://x.do, te gustará')
 *     → [{ type:'text', text:'mira ' }, { type:'link', href:'https://x.do' },
 *        { type:'text', text:', te gustará' }]
 *
 * Always returns at least one segment for non-empty text; [] for empty.
 */
export function splitMessageLinks(text) {
  const s = String(text || '');
  if (!s) return [];
  const parts = [];
  let last = 0;
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    const href = m[0].replace(TRAILING_PUNCT_RE, '');
    if (!href) continue;
    if (m.index > last) parts.push({ type: 'text', text: s.slice(last, m.index) });
    parts.push({ type: 'link', href });
    last = m.index + href.length;
    URL_RE.lastIndex = last;
  }
  if (last < s.length) parts.push({ type: 'text', text: s.slice(last) });
  return parts;
}

/** The first http(s) URL in a message body, or ''. */
export function firstMessageLink(text) {
  const link = splitMessageLinks(text).find((p) => p.type === 'link');
  return link ? link.href : '';
}

/**
 * The preview card for the first link in a message (or for a bare URL).
 *
 *   resolveLinkPreview(bodyOrUrl)
 *     → { url, domain, kind, title, description, image }  // one of our links
 *     | { url, domain, kind: 'external' }                 // anyone else's
 *     | null                                              // no link at all
 *
 * Matching is PATH-based, never host-based: the same repo deploys under more
 * than one hostname (prod domain, Vercel previews, localhost), and a
 * `/p/cotizacion.html` path is unambiguous wherever it's served. Old-format
 * hash links (`#/q/…`, pre-launcher) still resolve to the quote card, exactly
 * like templateButtonSuffix keeps accepting both generations.
 */
export function resolveLinkPreview(text) {
  const url = firstMessageLink(text);
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const domain = parsed.hostname.replace(/^www\./, '');
  const launcher = /^\/p\/([a-z]+)\.html$/i.exec(parsed.pathname)?.[1]?.toLowerCase();
  let kind = launcher && LAUNCHER_CARDS[launcher] ? launcher : null;
  // The clean /configurator URL is rewritten to the togo launcher (see
  // tests/ogImage.test.js) — same card.
  if (!kind && /^\/configurator(\.html)?$/i.test(parsed.pathname)) kind = 'togo';
  // Pre-launcher SPA hash links still circulate in old chats.
  if (!kind && parsed.hash.startsWith('#/q/')) kind = 'cotizacion';
  if (!kind && parsed.hash.startsWith('#/tienda')) kind = 'tienda';
  if (!kind && parsed.hash.startsWith('#/configurator')) kind = 'togo';
  if (!kind) return { url, domain, kind: 'external' };
  return { url, domain, kind, ...LAUNCHER_CARDS[kind] };
}
