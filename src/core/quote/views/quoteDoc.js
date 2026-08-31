// The QUOTE DOCUMENT ViewModel — one projection, two surfaces.
//
// `resolveQuoteDoc` is the shared content tree for BOTH the manufacturer's quote
// detail screen and the customer's login-less `#/q/<token>` page, the same way
// `resolveQuoteView` backs the editor preview, the client link and the PDF: the
// two must never drift, because they are the same document seen from two sides.
// The internal screen renders it with its chrome (status actions, the share
// link, the originating lead); the customer page renders it on paper. Neither
// derives anything of its own.
//
// IT NEVER PRICES ANYTHING. A quote's money was frozen server-side at creation
// (supabase/functions/togo-embed/quotes.ts + migration 20261130000000): `unit`,
// `total` and `currency` arrive already resolved, in the currency they are
// stated in, and this file only formats and labels them. There is no rate, no
// margin and no multiplication anywhere below — if a number could be computed
// here, tomorrow's catalog could change what yesterday's customer reads.
//
// Pure: no React, no db, no supabase.

import { t, piecesLabel, resolveConfiguratorLocale, DEFAULT_CONFIGURATOR_LOCALE } from '../../../lib/configurator/i18n.js';

/* --------------------------------- copy ---------------------------------- */

// The handful of strings the configurator's own dictionary doesn't carry (it
// speaks about building a sofa, not about a document). Everything else — total,
// plan, note, «incluido», «sin precio», the part names, the piece count — comes
// from lib/configurator/i18n so the customer's page reads in ONE voice with the widget
// they built in. Same four locales as that dictionary, for the same reason:
// the configurator ships to dealers outside the DR.
const DOC_COPY = {
  es: {
    title: 'Cotización',
    preparedFor: 'Preparada para',
    pieces: 'Piezas',
    unit: 'Precio',
    draft: 'Borrador',
    sent: 'Enviada',
    accepted: 'Aceptada',
    declined: 'Rechazada',
  },
  en: {
    title: 'Quote',
    preparedFor: 'Prepared for',
    pieces: 'Pieces',
    unit: 'Price',
    draft: 'Draft',
    sent: 'Sent',
    accepted: 'Accepted',
    declined: 'Declined',
  },
  fr: {
    title: 'Devis',
    preparedFor: 'Préparé pour',
    pieces: 'Pièces',
    unit: 'Prix',
    draft: 'Brouillon',
    sent: 'Envoyé',
    accepted: 'Accepté',
    declined: 'Refusé',
  },
  de: {
    title: 'Angebot',
    preparedFor: 'Für',
    pieces: 'Stücke',
    unit: 'Preis',
    draft: 'Entwurf',
    sent: 'Gesendet',
    accepted: 'Angenommen',
    declined: 'Abgelehnt',
  },
};

/** The document's own copy for a locale (unknown locale ⇒ the default). */
export function quoteDocCopy(locale) {
  return DOC_COPY[locale] || DOC_COPY[DEFAULT_CONFIGURATOR_LOCALE];
}

/* --------------------------------- money --------------------------------- */

/**
 * A FROZEN figure, formatted — never converted.
 *
 * The value is already expressed in `currency` (a dealer's price factor baked
 * markup × FX in before the quote was frozen), so this is `Intl` and nothing
 * else. Deliberately NOT `formatMoney`, which multiplies by a live rate: pointing
 * a live rate at a frozen number is precisely how a sent quote starts saying a
 * different total than the day it was sent.
 */
export function formatQuoteMoney(value, currency = 'USD', locale = DEFAULT_CONFIGURATOR_LOCALE) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  try {
    // The DEFAULT locale formats US-style ($12,880.50) rather than es-ES-style
    // (12.880,50 US$): that is how every other money figure in this app is
    // written (lib/format's formatMoney is pinned to en-US grouping), and a
    // quote total must not be the one number on screen using a different
    // convention. A dealer locale that is genuinely elsewhere — fr, de, en —
    // formats in its own, because that document is read there.
    const numberLocale = locale === DEFAULT_CONFIGURATOR_LOCALE ? 'en-US' : locale;
    return new Intl.NumberFormat(numberLocale, { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    // An unknown/garbled currency code must still print the money.
    return `${n.toFixed(2)} ${currency || ''}`.trim();
  }
}

/* -------------------------------- statuses -------------------------------- */

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined'];

// The pill's tone as a TOKEN, not a class: the View owns the palette (a leaf
// status→class map at the render site is the repo's convention).
const STATUS_TONE = { draft: 'neutral', sent: 'info', accepted: 'good', declined: 'bad' };

/** `{ key, label, tone }` for a quote status, in the document's locale. */
export function quoteStatusMeta(status, locale = DEFAULT_CONFIGURATOR_LOCALE) {
  const key = QUOTE_STATUSES.includes(status) ? status : 'draft';
  return { key, label: quoteDocCopy(locale)[key], tone: STATUS_TONE[key] };
}

/* ------------------------------ the document ------------------------------ */

const dims = (line) => (line.widthCm > 0 && line.depthCm > 0 ? `${line.widthCm} × ${line.depthCm} cm` : '');

/** A line's fabric, as one readable string: "FESTA BLEU PAON · Grade C". */
function fabricLabel(material) {
  if (!material) return '';
  return [material.fabric, material.grade].filter(Boolean).join(' · ');
}

/**
 * The frozen quote → everything either surface renders.
 *
 * `quote` is the stored document (the internal `quoteDetailShape` or the
 * customer bundle's `quote` — the frozen halves are identical by construction),
 * `brand` the identity it was quoted under, `models` the catalogue geometry its
 * plan is drawn from. Locale follows the BRAND, so a French dealer's customer
 * reads a French document.
 */
export function resolveQuoteDoc({ quote, brand = null, models = {}, locale: forced = null } = {}) {
  const locale = forced || resolveConfiguratorLocale({ dealerLocale: brand?.locale });
  const copy = quoteDocCopy(locale);
  const q = quote || {};
  const currency = (q.totals && q.totals.currency) || q.currency || 'USD';
  const money = (v) => formatQuoteMoney(v, currency, locale);
  const lines = Array.isArray(q.lines) ? q.lines : [];

  const rows = lines.map((line) => {
    const parts = (line.parts || []).map((p) => ({
      role: p.role,
      // The configurator's own word for the part (Cojín / Cushion / Coussin…).
      label: t(locale, `part.${p.role}`) || p.role,
      fabric: fabricLabel(p),
      code: p.code || '',
    }));
    return {
      id: line.id,
      modelId: line.modelId,
      name: line.name,
      collection: line.collection,
      dims: dims(line),
      fabric: fabricLabel(line.material),
      code: line.material?.code || '',
      parts,
      finishes: (line.finishes || []).map((f) => ({
        group: f.group,
        option: f.option,
        label: `${f.group}: ${f.option}`,
      })),
      qty: line.qty || 1,
      // «Incluido»: the elemento completo fold resolved, so the componentes this
      // piece is made of were bought by the one price above them — they are
      // LISTED (the customer must see what they are getting) and not charged.
      complete: !!line.complete,
      completeLabel: line.complete ? t(locale, 'price.included') : '',
      // No-vanish: a pick nothing can price keeps its row and says so, rather
      // than silently leaving the sheet and making the quote look cheaper.
      unpriced: !!line.unpriced,
      unpricedLabel: line.unpriced ? t(locale, 'summary.noPrice') : '',
      unit: line.unit,
      total: line.total,
      unitLabel: money(line.unit),
      totalLabel: money(line.total),
    };
  });

  const totals = q.totals || {};
  // The plan drawing's input — `composePlanPreview(models, planItems)`, the same
  // call the dealer inbox makes off the same geometry map.
  const planItems = lines.map((line) => ({
    modelId: line.modelId,
    x: line.plan?.x || 0,
    y: line.plan?.y || 0,
    rot: line.plan?.rot || 0,
  }));

  return {
    locale,
    copy,
    number: q.number,
    title: `${copy.title} #${q.number}`,
    status: quoteStatusMeta(q.status, locale),
    brand: brand ? { name: brand.name || '', logoUrl: brand.logoUrl || null } : null,
    customerName: q.customerName || q.customer?.name || '',
    note: q.note || '',
    snapshotUrl: q.snapshotUrl || null,
    snapshotImageId: q.snapshotImageId || null,
    lines: rows,
    planItems,
    models,
    totals: {
      currency,
      total: totals.total ?? null,
      totalLabel: money(totals.total ?? null),
      label: t(locale, 'inbox.total'),
      pieces: totals.pieces || rows.length,
      piecesLabel: piecesLabel(locale, totals.pieces || rows.length),
      unpriced: totals.unpriced || 0,
    },
    dates: {
      createdAt: q.createdAt || null,
      sentAt: q.sentAt || null,
      acceptedAt: q.acceptedAt || null,
      declinedAt: q.declinedAt || null,
    },
    labels: {
      plan: t(locale, 'inbox.plan'),
      note: t(locale, 'inbox.note'),
      preparedFor: copy.preparedFor,
      pieces: copy.pieces,
      unit: copy.unit,
      loading: t(locale, 'inbox.loading'),
      error: t(locale, 'inbox.error'),
    },
  };
}

/* -------------------------------- the board ------------------------------- */

/** The list's tabs. 'all' first, then the life of a quote in order. */
export const QUOTE_BOARD_TABS = [
  { key: 'all', label: 'Todas' },
  { key: 'draft', label: 'Borradores' },
  { key: 'sent', label: 'Enviadas' },
  { key: 'accepted', label: 'Aceptadas' },
  { key: 'declined', label: 'Rechazadas' },
];

const matches = (row, needle) => {
  if (!needle) return true;
  const hay = `${row.number} ${row.customerName} ${row.brandName}`.toLowerCase();
  return hay.includes(needle);
};

/**
 * The manufacturer's quote list: rows shaped for the table + the tab counts.
 * Sorted newest first (the server already does, this makes it independent of
 * that). Money is formatted in each quote's OWN currency — the list mixes
 * dealers, so a column total would be adding dollars to euros; there isn't one,
 * deliberately.
 */
export function resolveQuotesBoard(quotes, { status = 'all', query = '' } = {}) {
  const all = Array.isArray(quotes) ? [...quotes] : [];
  all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const needle = String(query || '').trim().toLowerCase();

  const counts = { all: all.length };
  for (const key of QUOTE_STATUSES) counts[key] = all.filter((q) => q.status === key).length;

  const rows = all
    .filter((q) => (status === 'all' ? true : q.status === status))
    .filter((q) => matches(q, needle))
    .map((q) => ({
      id: q.id,
      number: q.number,
      customerName: q.customerName || '—',
      brandName: q.brandName || '',
      status: quoteStatusMeta(q.status),
      totalLabel: formatQuoteMoney(q.total, q.currency),
      pieces: q.pieces,
      unpriced: q.unpriced || 0,
      createdAt: q.createdAt,
      sentAt: q.sentAt,
      shared: !!q.shared,
      shareToken: q.shareToken || null,
      viewCount: q.viewCount || 0,
      // «Visto»: the customer opened their link. The one signal that says the
      // quote actually arrived, and the reason view_count is stamped at all.
      seen: (q.viewCount || 0) > 0,
      requestId: q.requestId || null,
    }));

  return {
    rows,
    counts,
    tabs: QUOTE_BOARD_TABS.map((tabDef) => ({ ...tabDef, count: counts[tabDef.key] || 0 })),
    empty: all.length === 0,
    noMatches: all.length > 0 && rows.length === 0,
  };
}

/** The customer link for a share token — the ONE place that URL is built, so the
 *  list, the detail screen and anything that copies it can't disagree. */
export function quoteShareUrl(token, origin = (typeof location !== 'undefined' ? location.origin : '')) {
  return token ? `${origin}/#/q/${token}` : '';
}
