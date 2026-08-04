// The SOLICITUD ViewModels — the configurator lead, before it is a document.
//
//   resolveRequestsBoard  the triage list (Solicitudes): tabs, source filter,
//                         one row per lead with everything its card draws.
//   resolveRequestDetail  ONE lead, opened: the build it describes, priced, its
//                         customer, its timeline and what may still be done to it.
//
// The prices in the detail come from the server (togo-embed's shared pricer —
// the same numbers the widget showed the visitor and the dealer's own inbox
// reads); this file formats and labels them and derives nothing of its own. The
// board deliberately has NO prices: it renders straight off `togo_requests`
// rows, and the only money on a card is the estimate the visitor themself was
// shown, stored on the row.
//
// Pure: no React, no db, no supabase.

import { formatQuoteMoney } from './quoteDoc.js';

/* -------------------------------- statuses -------------------------------- */

// The stored vocabulary (togo_requests.status): a lead is new, acknowledged,
// turned into a quote, or set aside. The tone is a TOKEN — the View owns colour.
const REQUEST_STATUS = {
  pending: { label: 'Nueva', tone: 'warn' },
  contacted: { label: 'Contactada', tone: 'good' },
  converted: { label: 'Cotizada', tone: 'info' },
  dismissed: { label: 'Descartada', tone: 'neutral' },
};

export function requestStatusMeta(status) {
  const key = REQUEST_STATUS[status] ? status : 'pending';
  return { key, ...REQUEST_STATUS[key] };
}

/** The triage tabs. 'open' leads first — that is the job of this screen. */
export const REQUEST_BOARD_TABS = [
  { key: 'open', label: 'Abiertas', statuses: ['pending', 'contacted'] },
  { key: 'converted', label: 'Cotizadas', statuses: ['converted'] },
  { key: 'dismissed', label: 'Descartadas', statuses: ['dismissed'] },
  { key: 'all', label: 'Todas', statuses: null },
];

const tabDef = (key) => REQUEST_BOARD_TABS.find((tb) => tb.key === key) || REQUEST_BOARD_TABS[0];

const digitsOf = (phone) => String(phone || '').replace(/\D/g, '');

/** The placements a lead's stored items describe, in the shape every geometry
 *  VM here already speaks (resolveConfigurator / scenePlacementsFromPlaced /
 *  placementsFromPlaced). Derived ONCE, so no card re-derives it. */
export function placedFromItems(items, keyPrefix = 'p') {
  return (Array.isArray(items) ? items : []).map((it, i) => ({
    uid: `${keyPrefix}-${i}`,
    pieceId: it.modelId,
    x: it.x,
    y: it.y,
    rot: it.rot,
    ...(it.material ? { material: it.material } : {}),
    ...(it.partMaterials ? { partMaterials: it.partMaterials } : {}),
    ...(it.partFinishes ? { partFinishes: it.partFinishes } : {}),
  }));
}

/** The distinct fabrics a lead picked, with their swatch codes (the card's
 *  colour strip). First appearance wins, so the strip is stable. */
function fabricsOf(items) {
  const seen = new Map();
  for (const it of (items || [])) {
    const m = it.material;
    if (m?.fabric && !seen.has(m.fabric)) seen.set(m.fabric, m.code || '');
  }
  return [...seen.entries()].map(([fabric, code]) => ({ fabric, code }));
}

/**
 * The Solicitudes board.
 *
 * `requests` are `togo_requests` rows as the app reads them (camelCase, `*At`
 * already in ms), `dealers` the routing dealers. `tab` filters by status,
 * `dealerFilter` by source ('all' | 'direct' | <dealerId>).
 */
export function resolveRequestsBoard(requests, { dealers = [], tab = 'open', dealerFilter = 'all' } = {}) {
  const all = [...(requests || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const nameById = new Map((dealers || []).map((d) => [d.id, d.name]));
  // A routed lead's estimate is in THAT dealer's display currency (its widget
  // showed retail × markup × FX), so the card must label it with the dealer's
  // own currency — stamping US$ on a peso figure states a number 60× off.
  const currencyById = new Map((dealers || []).map((d) => [d.id, d.currency || 'USD']));

  const counts = { all: all.length };
  for (const tb of REQUEST_BOARD_TABS) {
    counts[tb.key] = tb.statuses ? all.filter((r) => tb.statuses.includes(r.status)).length : all.length;
  }

  const wanted = tabDef(tab).statuses;
  const rows = all
    .filter((r) => (wanted ? wanted.includes(r.status) : true))
    .filter((r) => {
      if (dealerFilter === 'all') return true;
      if (dealerFilter === 'direct') return !r.dealerId;
      return r.dealerId === dealerFilter;
    })
    .map((r) => {
      const contact = r.contact || {};
      const currency = (r.dealerId && currencyById.get(r.dealerId)) || 'USD';
      return {
        currency,
        id: r.id,
        name: contact.name || 'Sin nombre',
        phone: contact.phone || '',
        phoneDigits: digitsOf(contact.phone),
        email: contact.email || '',
        createdAt: r.createdAt || null,
        status: requestStatusMeta(r.status),
        dealerId: r.dealerId || null,
        isDirect: !r.dealerId,
        dealerLabel: r.dealerId ? (nameById.get(r.dealerId) || 'Distribuidor') : 'Directo',
        // The number the VISITOR saw, in the currency that widget showed it in
        // (a routed dealer's estimate is already markup × FX). Labelled, never
        // re-converted — see formatQuoteMoney.
        estimate: r.estimateUsd ?? null,
        estimateLabel: formatQuoteMoney(r.estimateUsd ?? null, currency),
        note: r.note || '',
        items: r.items || [],
        placed: placedFromItems(r.items, r.id),
        fabrics: fabricsOf(r.items),
        snapshotImageId: r.snapshotImageId || null,
        quoteId: r.quoteId || null,
      };
    });

  return {
    rows,
    counts,
    tabs: REQUEST_BOARD_TABS.map((tb) => ({ key: tb.key, label: tb.label, count: counts[tb.key] || 0 })),
    sources: [
      { key: 'all', label: 'Todos' },
      { key: 'direct', label: 'Directo' },
      ...(dealers || []).map((d) => ({ key: d.id, label: d.name })),
    ],
    empty: all.length === 0,
    noMatches: all.length > 0 && rows.length === 0,
  };
}

/* --------------------------------- detail --------------------------------- */

const dimsOf = (m) => (m && m.widthCm > 0 && m.depthCm > 0 ? `${m.widthCm} × ${m.depthCm} cm` : '');

const PART_LABELS = {
  base: 'Cuerpo',
  exterior: 'Exterior',
  interior: 'Interior',
  cushion: 'Cojín',
  bolster: 'Rulo',
  armCushion: 'Cojín de brazo',
  structure: 'Estructura',
};

const materialLabel = (m) => (m ? [m.fabric, m.grade].filter(Boolean).join(' · ') : '');

/**
 * ONE lead, opened.
 *
 * `payload` is togo-embed's `{ request, models, dealer, currency, quote }`: the
 * request's items already carry `priceUsd` (and `complete` where the elemento
 * completo fold applied) from the SHARED server pricer, so every piece here
 * states the number the visitor was shown and the dealer's inbox reads.
 *
 * The one judgement this VM makes is what may still be DONE to the lead:
 * a build nothing can price has no quote to make (`canQuote` false, with the
 * reason said out loud) — the same gate the server enforces, surfaced before the
 * click instead of after it.
 */
export function resolveRequestDetail(payload) {
  const { request = null, models = {}, dealer = null, currency = 'USD', quote = null } = payload || {};
  if (!request) return null;
  const contact = request.contact || {};
  const items = Array.isArray(request.items) ? request.items : [];
  const money = (v) => formatQuoteMoney(v, currency);
  const status = requestStatusMeta(request.status);

  const pieces = items.map((it, i) => {
    const model = models[it.modelId] || {};
    const parts = Object.entries(it.partMaterials || {}).map(([role, pick]) => ({
      role,
      label: PART_LABELS[role] || role,
      fabric: materialLabel(pick),
      code: pick?.code || '',
    }));
    const finishes = Object.entries(it.partFinishes || {}).map(([group, option]) => ({
      group,
      option: String(option),
      label: `${group}: ${option}`,
    }));
    return {
      id: `${i + 1}-${it.modelId || 'pieza'}`,
      modelId: it.modelId,
      name: model.name || it.modelId || '—',
      collection: model.collection || '',
      dims: dimsOf(model),
      fabric: materialLabel(it.material),
      code: it.material?.code || '',
      parts,
      finishes,
      // «Incluido»: the whole piece billed on one SKU, so its componentes ride
      // it. Listed, never charged twice.
      complete: it.complete === true,
      unpriced: it.priceUsd == null,
      price: it.priceUsd ?? null,
      priceLabel: money(it.priceUsd ?? null),
    };
  });

  const unpriced = pieces.filter((p) => p.unpriced).length;
  const total = request.totalUsd ?? null;

  const timeline = [{ key: 'created', label: 'Solicitud recibida', at: request.createdAt }];
  if (status.key === 'contacted') timeline.push({ key: 'contacted', label: 'Marcada como contactada', at: request.updatedAt });
  if (quote) timeline.push({ key: 'quoted', label: `Cotización #${quote.number} creada`, at: quote.createdAt });
  if (quote?.sentAt) timeline.push({ key: 'sent', label: 'Cotización enviada', at: quote.sentAt });
  if (quote?.firstViewedAt) timeline.push({ key: 'seen', label: 'El cliente abrió la cotización', at: quote.firstViewedAt });
  if (status.key === 'dismissed') timeline.push({ key: 'dismissed', label: 'Descartada', at: request.updatedAt });

  return {
    id: request.id,
    status,
    contact: {
      name: contact.name || 'Sin nombre',
      phone: contact.phone || '',
      phoneDigits: digitsOf(contact.phone),
      email: contact.email || '',
    },
    note: request.note || '',
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    dealer: dealer ? { id: dealer.id, name: dealer.name, isDirect: false } : { id: null, name: 'Directo', isDirect: true },
    currency,
    pieces,
    placed: placedFromItems(items, request.id),
    planItems: items.map((it) => ({ modelId: it.modelId, x: it.x, y: it.y, rot: it.rot })),
    models,
    fabrics: fabricsOf(items),
    snapshotImageId: request.snapshotImageId || null,
    // The composition render, resolved to a URL server-side so every surface
    // draws it the same way.
    snapshotUrl: request.snapshotUrl || null,
    timeline,
    totals: {
      currency,
      total,
      totalLabel: money(total),
      pieces: pieces.length,
      unpriced,
      // What the visitor themself saw at submit — kept next to our own total so
      // a disagreement (a price list moved since) is visible instead of quietly
      // replacing what they were shown.
      estimate: request.estimateUsd ?? null,
      estimateLabel: money(request.estimateUsd ?? null),
    },
    quote,
    actions: {
      // A DECLINED quote frees the lead to be quoted again — a new document at
      // today's prices, never an edit of the old one (the unique index
      // veta_quotes_request_live_idx is the same rule, server-side).
      canQuote: (!quote || quote.status === 'declined') && total != null,
      requoting: quote?.status === 'declined',
      quoteBlocked: (quote && quote.status !== 'declined')
        ? ''
        : (pieces.length === 0
          ? 'Esta solicitud no tiene piezas que cotizar.'
          : (total == null ? 'Ninguna pieza tiene precio: revisa las telas elegidas antes de cotizar.' : '')),
      canContact: status.key === 'pending',
      canReopen: status.key === 'contacted' || status.key === 'dismissed',
      canDismiss: status.key === 'pending' || status.key === 'contacted',
    },
  };
}
