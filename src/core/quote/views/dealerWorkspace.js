// ViewModel — the DISTRIBUIDORES workspace: how Alcover onboards a Ligne Roset
// dealer onto the SHARED Togo configurator and then watches it work.
//
// One deploy serves every dealer. A `dealers` row is therefore not a profile —
// it is the set of DIALS that bend the one widget for one storefront:
//   • IDENTIDAD — slug (the `?dealer=` key), name/logo/locale.
//   • CATÁLOGO  — `collections`: WHICH collections that dealer carries. Empty /
//                 null = the whole catalog (the contract the Edge Function
//                 reads), so "todas" is the absence of a filter, never a list
//                 of every collection frozen at create time — a collection
//                 added next month reaches an "todas" dealer automatically.
//   • PRECIOS   — TWO independent money knobs that everybody conflates:
//                 `usdRate` is FX (USD → the dealer's currency) and
//                 `priceMultiplier` is the dealer's own markup. Shown =
//                 retail USD × multiplier × rate, labelled `currency`. The
//                 live preview below is what makes that legible: it runs one
//                 REAL piece off the catalog through the whole chain.
//   • ENTREGA   — the token-gated inbox; a dealer's leads are theirs.
//
// MVVM: pages/admin/ConfiguratorDealers.jsx + components/configurator/Dealer* render THIS and
// derive nothing. Pure — no React, no db, no fetch. `now` is injectable so the
// time-derived figures stay testable.
//
// Everything money-shaped mirrors the server verbatim (togo-embed/index.ts
// `retail()` + dealer.ts `applyDealerPricing`): list × (1 + margen%) → retail,
// × multiplier → dealer USD, each rounded to 2dp exactly where the server
// rounds. This is a PREVIEW, not a second pricing engine: the widget and the
// quote it becomes are priced server-side, and a drift here would show the
// admin a number their visitors never see.

import { canonicalCollection, collectionKey } from '../../../lib/configurator/collections.js';

/** Configurator + inbox languages, in the order the picker offers them. */
export const DEALER_LOCALES = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

/**
 * How much of the priced shape reaches the dealer's visitors. The `hint` is the
 * one line the onboarding shows under each choice — what it DOES to the widget,
 * mirroring applyPricingMode() server-side.
 */
export const DEALER_PRICING_MODES = [
  { value: 'full', label: 'Precios completos', hint: 'El visitante ve el precio de cada pieza y cambia de tela con el precio en pantalla.' },
  { value: 'from', label: 'Precio «desde»', hint: 'Solo el precio base de cada pieza. Al cambiar de tela el precio ya no se recalcula.' },
  { value: 'hidden', label: 'Sin precios', hint: 'Ningún precio sale del servidor: el visitante arma y pide cotización.' },
];

const LOCALE_LABEL = Object.fromEntries(DEALER_LOCALES.map((l) => [l.value, l.label]));
const PRICING_LABEL = Object.fromEntries(DEALER_PRICING_MODES.map((m) => [m.value, m.label]));
const PRICING_HINT = Object.fromEntries(DEALER_PRICING_MODES.map((m) => [m.value, m.hint]));

export const dealerLocaleLabel = (v) => LOCALE_LABEL[v] || v || '—';
export const dealerPricingLabel = (v) => PRICING_LABEL[v] || v || '—';

// Lead status → the same status-pill family every list surface in the app uses.
const LEAD_STATUS_META = {
  pending: { label: 'Pendiente', cls: 'status-pill-pending' },
  contacted: { label: 'Contactado', cls: 'status-pill-sent' },
  converted: { label: 'Convertido', cls: 'status-pill-accepted' },
  dismissed: { label: 'Descartado', cls: 'status-pill-archived' },
};

/** The dealer's lead list is theirs until they close it — both open states. */
const OPEN_LEAD_STATUSES = new Set(['pending', 'contacted']);

export const DEALER_LIST_TABS = [
  { key: 'all', label: 'Todos' },
  { key: 'active', label: 'Activos' },
  { key: 'inactive', label: 'Inactivos' },
];

export const DEALER_SORT_OPTIONS = [
  { key: 'name', label: 'Nombre' },
  { key: 'open', label: 'Solicitudes abiertas' },
  { key: 'recent', label: 'Última solicitud' },
  { key: 'pieces', label: 'Piezas que sirve' },
];

const DEALER_RECENT_LEADS_MAX = 5;

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * A finite, positive multiplier/rate — anything else (0, negative, NaN, junk)
 * falls back to 1. Byte-for-byte the server's `safeMultiplier` rule, so the
 * preview can never promise a price the Edge Function would refuse to produce.
 */
function safeFactor(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** name → url-safe kebab slug (accents stripped) — the `?dealer=` key. */
export function dealerSlugify(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Format an amount in an arbitrary ISO 4217 code. Zero decimals — retail
 * furniture money, matching what the dealer's own inbox prints. A code Intl
 * refuses (typo'd, 2-letter, not a currency) degrades to `1,234 XX` instead of
 * throwing: the dealer is mid-typing a currency and the preview must survive it.
 */
export function dealerMoneyLabel(amount, currency, { locale = 'es', display = 'symbol' } = {}) {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const value = Number(amount);
  const code = String(currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: code, currencyDisplay: display, maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Math.round(value).toLocaleString('en-US')} ${code}`;
  }
}

/**
 * The pieces a resolved catalog actually offers — `resolveConfiguratorModels`'s
 * `resolvedById` flattened to what this workspace counts and prices. That map is
 * already gated to ACTIVE + drawable models, so "18 piezas" means eighteen
 * pieces a visitor can really place, not eighteen rows in a table.
 */
function catalogPieces(resolvedById) {
  return Object.values(resolvedById || {}).map((p) => ({
    id: p.id,
    label: p.label || p.name || '—',
    name: p.name || p.label || '—',
    collection: canonicalCollection(p.collection),
    key: collectionKey(p.collection),
    listUsd: Number(p.unitPrice) > 0 ? Number(p.unitPrice) : null,
  }));
}

/**
 * How a STORED `dealers.collections` reads. The column's contract is
 * «NULL or empty ⇒ the whole catalog», so both collapse to null the moment a row
 * is read — and every VM below can then treat an ARRAY as a real restriction
 * (including the empty one the alta form uses for "restringiendo, nada elegido
 * todavía", which must block the save instead of silently meaning "todas").
 */
export function dealerStoredCollections(row) {
  const v = row?.collections;
  return Array.isArray(v) && v.length ? v : null;
}

/**
 * THE CATÁLOGO DIAL — which collections this dealer carries, read off the REAL
 * catalog.
 *
 * `selected` is null/undefined for the whole catalog, or the ARRAY of
 * collections carried (see `dealerStoredCollections` for the DB reading).
 * Options come from the live `togo_models` set, folded through `collectionKey`
 * so a drifted spelling («EXCLUSIF» vs «Exclusif») can't offer the same family
 * twice, and carry the piece count that makes the choice legible
 * ("Togo · 18 piezas").
 *
 * NO-VANISH: a stored collection that no longer exists in the catalog (renamed,
 * emptied) is reported in `unknown` instead of being silently dropped — it is
 * still narrowing what that dealer serves, and the admin has to see it to fix it.
 */
export function resolveDealerCollections({ resolvedById, selected } = {}) {
  const pieces = catalogPieces(resolvedById);

  const byKey = new Map();
  for (const p of pieces) {
    const entry = byKey.get(p.key) || { key: p.key, label: p.collection, count: 0, priced: 0 };
    entry.count += 1;
    if (p.listUsd != null) entry.priced += 1;
    byKey.set(p.key, entry);
  }

  // NOT `.length === 0`: an EMPTY array is an explicit restriction with nothing
  // picked yet (the form state right after «Solo algunas»), and reading it as
  // "todas" is what would let a half-made choice ship as the whole catalog.
  const restricted = Array.isArray(selected);
  const all = !restricted;
  const rawSelected = restricted ? selected.filter((s) => String(s ?? '').trim()) : [];
  const selectedKeys = new Set(rawSelected.map(collectionKey));

  const known = [...byKey.values()]
    .map((o) => ({ ...o, missing: false, selected: all || selectedKeys.has(o.key) }))
    // Biggest family first (it is the one the dealer is likeliest to carry),
    // alphabetical inside a tie so the list never reshuffles between renders.
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));

  // NOTHING can be judged against a catalog that isn't there — mid-load, or on a
  // profile with no published models. An empty catalog therefore flags NO
  // collection as missing, calls no dealer empty, and (below) rewrites nobody's
  // stored list: the alternative is a load window in which every dealer reads as
  // broken and one unrelated save wipes what they carry.
  const catalogKnown = pieces.length > 0;

  const knownKeys = new Set(known.map((o) => o.key));
  const unknown = !catalogKnown ? [] : [...new Set(rawSelected.map(collectionKey))]
    .filter((k) => !knownKeys.has(k))
    .map((k) => {
      const raw = rawSelected.find((s) => collectionKey(s) === k);
      return { key: k, label: canonicalCollection(raw), count: 0, priced: 0, missing: true, selected: true };
    });

  // A stored collection the catalog no longer has stays IN the list, checked and
  // flagged — it is still narrowing what this dealer serves, so it must be
  // visible AND unpickable-away-able. Dropping it silently would rewrite the
  // dealer's catalog behind the admin's back on the next unrelated save.
  const options = [...known, ...unknown];

  const servedOptions = options.filter((o) => o.selected);
  const servedPieces = all
    ? pieces.length
    : servedOptions.reduce((s, o) => s + o.count, 0);

  const chosenLabels = catalogKnown
    ? servedOptions.map((o) => o.label)
    : rawSelected.map(canonicalCollection);
  const summary = all
    ? `Todo el catálogo · ${plural(pieces.length, 'pieza', 'piezas')}`
    : (chosenLabels.length
      ? `${chosenLabels.join(' · ')}${catalogKnown ? ` · ${plural(servedPieces, 'pieza', 'piezas')}` : ''}`
      : 'Sin colecciones seleccionadas');

  return {
    options,
    unknown,
    all,
    catalogKnown,
    // The stored value this selection should be written as: null for "todas",
    // and the UNTOUCHED list when the catalog can't be read (see catalogKnown).
    valueToStore: all ? null : (catalogKnown ? servedOptions.map((o) => o.label) : rawSelected.slice()),
    selectedLabels: chosenLabels,
    servedPieces,
    catalogPieces: pieces.length,
    catalogCollections: known.length,
    summary,
    // A dealer that carries nothing serves an empty widget — a real, blocking
    // misconfiguration, not a style choice. Only ever asserted against a
    // catalog we can actually see.
    empty: catalogKnown && !all && servedPieces === 0,
  };
}

/**
 * THE PRECIOS DIALS made legible — one REAL piece off the catalog walked
 * through the whole chain, so the admin can read what a visitor will see before
 * anyone visits.
 *
 * Sample = the dearest piece the dealer actually serves (the flagship: the row
 * where a wrong rate is most obvious), deterministic on ties so the preview
 * never flickers between renders. Never invented — with no priced piece in the
 * served catalog the preview says so and shows nothing.
 */
export function resolveDealerPricePreview({
  resolvedById, collections, marginPct = 0,
  currency = 'USD', usdRate = 1, priceMultiplier = 1, pricingMode = 'full', locale = 'es',
} = {}) {
  const catalog = resolveDealerCollections({ resolvedById, selected: collections });
  const served = catalogPieces(resolvedById)
    .filter((p) => catalog.all || catalog.selectedLabels.includes(p.collection));

  const rate = safeFactor(usdRate);
  const multiplier = safeFactor(priceMultiplier);
  const margin = Number.isFinite(Number(marginPct)) ? Number(marginPct) : 0;
  const code = String(currency || 'USD').toUpperCase();
  const mode = PRICING_LABEL[pricingMode] ? pricingMode : 'full';

  const base = {
    currency: code, usdRate: rate, priceMultiplier: multiplier, marginPct: margin,
    pricingMode: mode, pricingLabel: PRICING_LABEL[mode], pricingHint: PRICING_HINT[mode],
    // Both knobs at identity ⇒ the dealer shows Alcover's own retail in USD.
    identity: rate === 1 && multiplier === 1,
    sample: null, steps: [], headline: null,
  };

  const priced = served.filter((p) => p.listUsd != null);
  if (!priced.length) {
    return {
      ...base,
      ok: false,
      reason: served.length ? 'no-priced-piece' : 'no-catalog',
      note: served.length
        ? 'Ninguna pieza de este catálogo tiene precio de lista todavía — vincula los modelos a un producto en Modelos.'
        : 'Aún no hay piezas publicadas en las colecciones elegidas.',
    };
  }

  const sample = priced
    .slice()
    .sort((a, b) => (b.listUsd - a.listUsd) || a.label.localeCompare(b.label) || String(a.id).localeCompare(String(b.id)))[0];

  // The server's chain, in the server's order, rounded where the server rounds.
  const listUsd = sample.listUsd;
  const retailUsd = round2(listUsd * (1 + margin / 100));
  const dealerUsd = round2(retailUsd * multiplier);
  const displayAmount = dealerUsd * rate;

  const usd = (v) => dealerMoneyLabel(v, 'USD', { locale: 'en-US', display: 'code' });
  const shown = dealerMoneyLabel(displayAmount, code, { locale });

  const steps = [
    { key: 'list', label: 'Precio de lista', value: usd(listUsd), hint: `${sample.label} · ${sample.collection}` },
    { key: 'margin', label: `Margen Alcover ${margin}%`, value: usd(retailUsd), hint: 'El retail que ya usa el configurador.' },
    { key: 'multiplier', label: `Margen del distribuidor ×${multiplier}`, value: usd(dealerUsd), hint: 'Su markup sobre el retail. Deja 1 para vender al mismo precio.' },
    { key: 'rate', label: `Tasa ×${rate}`, value: shown, hint: `Convierte a ${code}. Deja 1 si el distribuidor cobra en USD.` },
  ];

  // What the visitor literally reads on the piece, per presentation mode.
  const headline = mode === 'hidden'
    ? { from: usd(retailUsd), to: 'Sin precio', muted: true }
    : { from: usd(retailUsd), to: mode === 'from' ? `desde ${shown}` : shown, muted: false };

  return {
    ...base,
    ok: true,
    reason: null,
    note: null,
    sample: { id: sample.id, label: sample.label, name: sample.name, collection: sample.collection, listUsd },
    retailUsd, dealerUsd, displayAmount,
    formatted: { list: usd(listUsd), retail: usd(retailUsd), dealer: usd(dealerUsd), display: shown },
    steps,
    headline,
  };
}

/**
 * THE ALTA — the guided create/edit flow's state, as data.
 *
 * Every step reports whether it is settled and what it currently means for the
 * widget, so the wizard renders a summary instead of a form dump. Blocking
 * problems land in `issues` (and gate `canSave`); a slug collision is one of
 * them: two dealers on one slug means one of them silently serves the other's
 * catalog.
 */
export function resolveDealerDraft({
  form, dealers, resolvedById, marginPct = 0, editingId = null,
} = {}) {
  const f = form || {};
  const name = String(f.name || '').trim();
  const slug = String(f.slug || '').trim();
  const contactEmail = String(f.contactEmail || '').trim();

  const catalog = resolveDealerCollections({ resolvedById, selected: f.collections });
  const pricing = resolveDealerPricePreview({
    resolvedById,
    collections: f.collections,
    marginPct,
    currency: f.currency,
    usdRate: f.usdRate,
    priceMultiplier: f.priceMultiplier,
    pricingMode: f.pricingMode,
    locale: f.locale,
  });

  const slugTaken = !!slug && (dealers || []).some(
    (d) => d.id !== editingId && dealerSlugify(d.slug) === dealerSlugify(slug),
  );
  const currencyOk = /^[A-Za-z]{3}$/.test(String(f.currency || '').trim());
  const emailOk = !contactEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail);

  const issues = [];
  if (!name) issues.push({ key: 'name', step: 'identidad', text: 'Ponle un nombre al distribuidor.' });
  if (!slug) issues.push({ key: 'slug', step: 'identidad', text: 'Falta el slug: es la clave «?dealer=» de su enlace.' });
  if (slugTaken) issues.push({ key: 'slug-taken', step: 'identidad', text: `El slug «${slug}» ya lo usa otro distribuidor.` });
  if (!emailOk) issues.push({ key: 'email', step: 'identidad', text: 'El correo de contacto no parece válido.' });
  if (catalog.empty) issues.push({ key: 'catalog', step: 'catalogo', text: 'No elegiste ninguna colección: su configurador saldría vacío.' });
  if (!currencyOk) issues.push({ key: 'currency', step: 'precios', text: 'La moneda va en código ISO de 3 letras (USD, EUR, DOP…).' });

  const issuesFor = (step) => issues.filter((i) => i.step === step);

  const steps = [
    {
      key: 'identidad',
      label: 'Identidad',
      summary: name ? `${name} · /${slug || '—'} · ${dealerLocaleLabel(f.locale)}` : 'Nombre, slug e idioma del configurador',
      done: !!name && !!slug && !slugTaken && emailOk,
      issues: issuesFor('identidad'),
    },
    {
      key: 'catalogo',
      label: 'Catálogo',
      summary: catalog.summary,
      done: !catalog.empty,
      issues: issuesFor('catalogo'),
    },
    {
      key: 'precios',
      label: 'Precios',
      summary: `${dealerPricingLabel(f.pricingMode)} · ${String(f.currency || 'USD').toUpperCase()}${pricing.identity ? '' : ` · ×${pricing.priceMultiplier} · tasa ${pricing.usdRate}`}`,
      done: currencyOk,
      issues: issuesFor('precios'),
    },
    {
      key: 'entrega',
      label: 'Entrega de solicitudes',
      summary: 'Bandeja privada con enlace propio · Alcover no cotiza sus leads automáticamente',
      done: true,
      issues: [],
    },
  ];

  return {
    catalog,
    pricing,
    steps,
    issues,
    slugTaken,
    canSave: issues.length === 0,
  };
}

/** Per-dealer lead rollup, off the FULL requests array (dealerId is the key). */
function leadsFor(dealerId, requests) {
  const mine = (requests || []).filter((r) => r.dealerId === dealerId);
  const counts = { pending: 0, contacted: 0, converted: 0, dismissed: 0 };
  let lastAt = 0;
  let pipelineUsd = 0;
  for (const r of mine) {
    if (counts[r.status] != null) counts[r.status] += 1;
    if ((r.createdAt || 0) > lastAt) lastAt = r.createdAt || 0;
    if (OPEN_LEAD_STATUSES.has(r.status) && Number(r.estimateUsd) > 0) pipelineUsd += Number(r.estimateUsd);
  }
  return {
    rows: mine,
    total: mine.length,
    ...counts,
    open: counts.pending + counts.contacted,
    pipelineUsd,
    lastAt: lastAt || null,
  };
}

/**
 * THE LIST — every dealer as one row, plus the tab counts. Filtering/sorting
 * happen HERE so the page only renders; `search` matches the fields an admin
 * actually types (name, slug, correo, moneda, colecciones).
 */
export function resolveDealersList({
  dealers, requests, resolvedById, search = '', status = 'all', sort,
} = {}) {
  const list = Array.isArray(dealers) ? dealers : [];
  const q = String(search || '').trim().toLowerCase();
  const sortKey = sort?.key || 'name';
  const dir = sort?.dir === 'desc' ? -1 : 1;

  const rows = list.map((d) => {
    const catalog = resolveDealerCollections({ resolvedById, selected: dealerStoredCollections(d) });
    const leads = leadsFor(d.id, requests);
    const multiplier = safeFactor(d.priceMultiplier);
    const rate = safeFactor(d.usdRate);
    const currency = String(d.currency || 'USD').toUpperCase();
    return {
      id: d.id,
      dealer: d,
      name: d.name || 'Distribuidor',
      slug: d.slug || '',
      active: d.active !== false,
      statusLabel: d.active !== false ? 'Activo' : 'Inactivo',
      statusCls: d.active !== false ? 'status-pill-active' : 'status-pill-inactive',
      contactEmail: d.contactEmail || '',
      localeLabel: dealerLocaleLabel(d.locale),
      currency,
      priceMultiplier: multiplier,
      usdRate: rate,
      pricingMode: d.pricingMode || 'full',
      pricingLabel: dealerPricingLabel(d.pricingMode),
      // "EUR · ×1.35 · tasa 0.92" — both knobs, never collapsed into one number.
      moneyLabel: [currency, multiplier === 1 ? null : `×${multiplier}`, rate === 1 ? null : `tasa ${rate}`]
        .filter(Boolean).join(' · '),
      catalogLabel: catalog.all ? 'Todo el catálogo' : (catalog.selectedLabels.join(', ') || 'Sin colecciones'),
      catalogAll: catalog.all,
      catalogPieces: catalog.servedPieces,
      catalogEmpty: catalog.empty,
      catalogUnknown: catalog.unknown,
      open: leads.open,
      pending: leads.pending,
      contacted: leads.contacted,
      converted: leads.converted,
      total: leads.total,
      lastLeadAt: leads.lastAt,
      pipelineUsd: leads.pipelineUsd,
    };
  });

  const counts = {
    all: rows.length,
    active: rows.filter((r) => r.active).length,
    inactive: rows.filter((r) => !r.active).length,
  };

  const filtered = rows
    .filter((r) => (status === 'active' ? r.active : status === 'inactive' ? !r.active : true))
    .filter((r) => !q || [r.name, r.slug, r.contactEmail, r.currency, r.catalogLabel]
      .some((v) => String(v || '').toLowerCase().includes(q)));

  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    open: (a, b) => (a.open - b.open) || a.name.localeCompare(b.name),
    recent: (a, b) => ((a.lastLeadAt || 0) - (b.lastLeadAt || 0)) || a.name.localeCompare(b.name),
    pieces: (a, b) => (a.catalogPieces - b.catalogPieces) || a.name.localeCompare(b.name),
  }[sortKey] || ((a, b) => a.name.localeCompare(b.name));

  return {
    rows: filtered.slice().sort((a, b) => cmp(a, b) * dir),
    counts,
    tabs: DEALER_LIST_TABS.map((t) => ({ ...t, count: counts[t.key] })),
    empty: rows.length === 0,
    noMatches: rows.length > 0 && filtered.length === 0,
  };
}

/**
 * THE FICHA — one dealer's whole picture: estado, the catalog they carry, how
 * their prices are presented (with the live example), and THEIR solicitudes.
 * Zero leads is an honest zero — nothing is invented to fill the panel.
 */
export function resolveDealerDetail({
  dealer, requests, resolvedById, marginPct = 0, now = Date.now(), recentMax = DEALER_RECENT_LEADS_MAX,
} = {}) {
  if (!dealer) return null;

  const stored = dealerStoredCollections(dealer);
  const catalog = resolveDealerCollections({ resolvedById, selected: stored });
  const pricing = resolveDealerPricePreview({
    resolvedById,
    collections: stored,
    marginPct,
    currency: dealer.currency,
    usdRate: dealer.usdRate,
    priceMultiplier: dealer.priceMultiplier,
    pricingMode: dealer.pricingMode,
    locale: dealer.locale,
  });
  const leads = leadsFor(dealer.id, requests);

  const recent = leads.rows
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, recentMax)
    .map((r) => {
      const meta = LEAD_STATUS_META[r.status] || { label: r.status || '—', cls: 'status-pill-draft' };
      return {
        id: r.id,
        name: r.contact?.name || 'Sin nombre',
        contact: [r.contact?.phone, r.contact?.email].filter(Boolean).join(' · '),
        createdAt: r.createdAt || null,
        estimateUsd: Number(r.estimateUsd) > 0 ? Number(r.estimateUsd) : null,
        pieces: (r.items || []).length,
        statusLabel: meta.label,
        statusCls: meta.cls,
        quoteId: r.status === 'converted' ? (r.quoteId || null) : null,
      };
    });

  // The nudges worth surfacing on the ficha — each a real misconfiguration,
  // never decoration.
  const warnings = [];
  if (dealer.active === false) {
    warnings.push('Está inactivo: su enlace y su embed no cargan.');
  }
  if (catalog.empty) {
    warnings.push('No tiene colecciones asignadas: su configurador sale vacío.');
  }
  if (catalog.unknown.length) {
    warnings.push(`Tiene ${plural(catalog.unknown.length, 'colección', 'colecciones')} guardada(s) que ya no existe(n) en el catálogo: ${catalog.unknown.map((u) => u.label).join(', ')}.`);
  }
  if (!dealer.inboxToken) {
    warnings.push('Sin token de bandeja: no puede leer sus solicitudes.');
  }

  return {
    id: dealer.id,
    dealer,
    name: dealer.name || 'Distribuidor',
    slug: dealer.slug || '',
    active: dealer.active !== false,
    statusLabel: dealer.active !== false ? 'Activo' : 'Inactivo',
    statusCls: dealer.active !== false ? 'status-pill-active' : 'status-pill-inactive',
    contactEmail: dealer.contactEmail || '',
    locale: dealer.locale || 'es',
    localeLabel: dealerLocaleLabel(dealer.locale),
    logoUrl: dealer.logoUrl || '',
    notes: dealer.notes || '',
    inboxToken: dealer.inboxToken || '',
    createdAt: dealer.createdAt || null,
    ageDays: dealer.createdAt ? Math.max(0, Math.floor((now - dealer.createdAt) / 86400000)) : null,
    catalog,
    pricing,
    leads: {
      total: leads.total,
      pending: leads.pending,
      contacted: leads.contacted,
      converted: leads.converted,
      dismissed: leads.dismissed,
      open: leads.open,
      pipelineUsd: leads.pipelineUsd,
      lastAt: leads.lastAt,
      recent,
      empty: leads.total === 0,
    },
    warnings,
  };
}
