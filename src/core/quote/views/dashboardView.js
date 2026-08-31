// EL PANEL — the manufacturer's home screen, and the one projection behind it.
//
// It answers exactly two questions, in this order:
//
//   1. ¿ESTÁ MI CATÁLOGO EN CONDICIONES DE VENDER? — the readiness ledger. A
//      piece is only sellable when the configurador can place it AND the quote
//      can price it, and there are four independent ways for that to be false
//      (no plan, en borrador, sin SKU, SKU sin precio) plus three that degrade
//      it without blocking it (sin malla, malla vieja, sin miniatura). Every one
//      of them is a fact off a real column — never a score, never a guess.
//
//   2. ¿QUÉ NECESITA DE MÍ HOY? — materiales, distribuidores, solicitudes y
//      cotizaciones, each reduced to the handful of numbers that decide
//      something, each pointing at the screen that fixes it.
//
// THE SILENT ONE is `sinPrecio`: a model bound to a `product_root` that carries
// no priced row in `products`. Nothing on any other screen says so — the model
// looks bound, the configurador places it, and the quote comes out missing the
// money. It is the only check here that needs a JOIN, and the only reason this
// VM takes the price catalog at all.
//
// TWO RULES THIS FILE WILL NOT BREAK:
//
//   • MONEY IS NEVER SUMMED ACROSS CURRENCIES. A quote's total is FROZEN in the
//     currency it was written in (a routed dealer's markup × FX is already baked
//     in server-side), so the pipeline is grouped BY CURRENCY and each group is
//     labelled with its own code. There is no grand total, and nothing here
//     multiplies by a rate: the stored figure is read and formatted, full stop.
//   • A NUMBER NOBODY CAN KNOW YET IS NOT ZERO. The price catalog is the slowest
//     read on the screen, so while it is in flight the price check reports
//     `pending` instead of a confident 0 — the page says «comprobando», never
//     «todo en orden».
//
// Pure: no React, no db, no supabase, no fetch. `now` is injectable so the
// time-derived figures (how long a lead has waited) stay testable.

import { canonicalCollection, collectionKey } from '../../../lib/configurator/collections.js';
import { dealerStoredCollections, dealerPricingLabel, dealerLocaleLabel } from './dealerWorkspace.js';
import { requestStatusMeta } from './requestDetail.js';
import { formatQuoteMoney, quoteStatusMeta, QUOTE_STATUSES } from './quoteDoc.js';

const DAY_MS = 86400000;

/** How many piece names a readiness row lists before it stops naming them. */
export const DASHBOARD_EXAMPLES_MAX = 4;
/** Newest leads shown under «Solicitudes». */
export const DASHBOARD_RECENT_MAX = 5;

/** The lead statuses that are still work (the Solicitudes board's «Abiertas»). */
const OPEN_REQUEST_STATUSES = ['pending', 'contacted'];
/** Every stored lead status, in the order the panel lists them. */
const REQUEST_STATUSES = ['pending', 'contacted', 'converted', 'dismissed'];

/**
 * A mesh the optimizer can actually re-export — mirrors
 * `components/configurator/sceneImport.isOptimizableMeshUrl`. Duplicated (one regex)
 * rather than imported because that module pulls three.js in, and the home
 * screen must not.
 */
const OPTIMIZABLE_MESH_RE = /\.(glb|gltf)(\?|$)/i;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Every row reader starts here: a non-array reads as empty, and a hole inside
 *  one is dropped rather than crashing the home screen on `row.id`. */
const rowsOf = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

/**
 * SKU → its family root, through the ACTIVE BRAND's own catalog grammar
 * (`brands.modules.catalog.splitSku`): Ligne Roset strips the grade letter off
 * an 8-digit root, a generic brand's SKU is its own root. Falls back to the raw
 * reference when the brand carries no adapter (or its adapter refuses the row),
 * because an unreadable reference is still a reference — dropping it would let a
 * priced SKU read as unpriced.
 */
function rootOf(reference, splitSku) {
  const raw = String(reference ?? '').trim();
  if (!raw) return '';
  if (typeof splitSku === 'function') {
    try {
      const split = splitSku(raw);
      if (split && split.root) return String(split.root).trim();
    } catch { /* a half-written adapter must not take the panel down */ }
  }
  return raw;
}

/**
 * The price catalog, distilled to the only two questions the ledger asks of it:
 * does this root EXIST, and does it carry a price above zero. Built once over
 * whatever slice of `products` the page fetched (reference + priceUsd is enough).
 */
function buildPriceIndex(products, splitSku) {
  const known = new Set();
  const priced = new Set();
  for (const p of rowsOf(products)) {
    const root = rootOf(p?.reference, splitSku);
    if (!root) continue;
    known.add(root);
    if (num(p?.priceUsd) > 0) priced.add(root);
  }
  return { known, priced };
}

/** One model's readiness facts — every field a plain read of a real column. */
function modelFacts(model, { priceIndex, productsLoaded, meshVersion }) {
  const meshUrl = String(model?.meshUrl || '');
  const root = String(model?.productRoot || '').trim();
  const bound = !!root;
  // Only ANSWERABLE once the catalog has landed: with no rows in hand every
  // binding would read as unpriced, which is the opposite of the truth.
  const priceKnown = bound && productsLoaded;
  return {
    id: model?.id,
    name: String(model?.name || '').trim() || 'Sin nombre',
    collection: canonicalCollection(model?.collection),
    // ── blockers ─────────────────────────────────────────────────────────
    // `resolveConfiguratorModels` drops a model with no `svg` from the palette outright,
    // so this is the hardest of the four: the piece does not exist for a visitor.
    noPlan: !model?.svg,
    // «Borrador» IS `active === false` and nothing else — a legacy NULL is a
    // LIVE model (the same predicate the widget and the model manager read).
    inactive: model?.active === false,
    noSku: !bound,
    unpriced: priceKnown && !priceIndex.priced.has(root),
    /** Bound to a root the catalog does not carry at all — a rebind, not a repricing. */
    skuMissing: priceKnown && !priceIndex.known.has(root),
    // ── quality (served, but degraded) ────────────────────────────────────
    noMesh: !meshUrl,
    unoptimized: !!meshUrl && meshVersion > 0 && num(model?.meshV) < meshVersion,
    /** An unoptimized mesh the batch pass can fix by itself (GLB/glTF). */
    optimizable: OPTIMIZABLE_MESH_RE.test(meshUrl),
    noThumb: !model?.thumbUrl,
  };
}

/** One ledger row: the count, who it is, and where it gets fixed. */
function checkRow({ key, label, detail, tone, facts, predicate, pending = false, link }) {
  const hits = facts.filter(predicate);
  return {
    key,
    label,
    detail,
    // A row nobody has been able to evaluate yet reports `pending`, never 0.
    count: pending ? null : hits.length,
    pending,
    tone: pending ? 'neutral' : (hits.length === 0 ? 'good' : tone),
    ok: !pending && hits.length === 0,
    examples: hits.slice(0, DASHBOARD_EXAMPLES_MAX).map((f) => f.name),
    more: Math.max(0, hits.length - DASHBOARD_EXAMPLES_MAX),
    link,
  };
}

/* ────────────────────────────── el catálogo ────────────────────────────── */

function resolveCatalogReadiness({
  models, products, productsLoaded, splitSku, meshVersion, catalogBrand,
}) {
  const rows = rowsOf(models);
  const priceIndex = buildPriceIndex(products, splitSku);
  const facts = rows.map((m) => modelFacts(m, { priceIndex, productsLoaded, meshVersion }));

  const bound = facts.filter((f) => !f.noSku).length;
  // Nothing bound ⇒ nothing to look up, so the price check is answerable even
  // with no catalog in hand: the answer is "ninguna".
  const pricePending = !productsLoaded && bound > 0;
  const missingSku = facts.filter((f) => f.skuMissing).length;
  // TWO ways every binding reads as unpriced AT ONCE, and neither is the
  // models' fault — saying «N SKUs sin precio» would send the dealer to the
  // wrong screen. Both are named instead, and both point at Marcas.
  const noPriceCatalog = !catalogBrand;
  const priceCatalogEmpty = !noPriceCatalog && productsLoaded && priceIndex.known.size === 0;
  const priceDetail = noPriceCatalog
    ? 'Esta marca no tiene catálogo de precios asignado: ninguna pieza puede tener precio todavía.'
    : (priceCatalogEmpty
      ? `El catálogo «${catalogBrand}» está vacío: importa la lista de precios y estas piezas se valorizan solas.`
      : (missingSku > 0
        ? `El SKU no tiene precio en el catálogo de esta marca (${plural(missingSku, 'ni siquiera existe en él', 'ni siquiera existen en él')}). La cotización sale sin dinero.`
        : 'El SKU existe pero no tiene precio en el catálogo de esta marca. La cotización sale sin dinero.'));

  const blockers = [
    checkRow({
      key: 'plan',
      label: 'Sin plano 2D',
      detail: 'La pieza no entra en la paleta del configurador: sin plano no se puede colocar.',
      tone: 'bad',
      facts,
      predicate: (f) => f.noPlan,
      link: { section: 'modelos' },
    }),
    checkRow({
      key: 'estado',
      label: 'En borrador',
      detail: 'Guardada como borrador: el configurador no la sirve a nadie.',
      tone: 'warn',
      facts,
      predicate: (f) => f.inactive,
      link: { section: 'modelos' },
    }),
    checkRow({
      key: 'sku',
      label: 'Sin SKU vinculado',
      detail: 'Sin referencia de catálogo la pieza se configura pero nunca puede tener precio.',
      tone: 'warn',
      facts,
      predicate: (f) => f.noSku,
      link: { section: 'modelos' },
    }),
    checkRow({
      key: 'precio',
      label: 'SKU vinculado sin precio',
      detail: priceDetail,
      tone: 'bad',
      facts,
      predicate: (f) => f.unpriced,
      pending: pricePending,
      link: { section: 'modelos' },
    }),
  ];

  const quality = [
    checkRow({
      key: 'malla',
      label: 'Sin modelo 3D',
      detail: 'Se dibuja como silueta plana a partir del plano; el visitante no ve la pieza real.',
      tone: 'warn',
      facts,
      predicate: (f) => f.noMesh,
      link: { section: 'modelos' },
    }),
    ...(meshVersion > 0 ? [checkRow({
      key: 'optimizada',
      label: `Malla sin optimizar (v${meshVersion})`,
      detail: (() => {
        const stale = facts.filter((f) => f.unoptimized);
        const manual = stale.filter((f) => !f.optimizable).length;
        return manual > 0
          ? `Pesan de más y no ofrecen partes. ${plural(manual, 'no es GLB', 'no son GLB')}: hay que reimportarlas, el pase automático no las toca.`
          : 'Pesan de más y no ofrecen partes seleccionables; el pase «Optimizar mallas» las reexporta.';
      })(),
      tone: 'info',
      facts,
      predicate: (f) => f.unoptimized,
      link: { section: 'modelos' },
    })] : []),
    checkRow({
      key: 'miniatura',
      label: 'Sin miniatura horneada',
      detail: 'Cada tile del catálogo se renderiza desde la malla en el navegador del visitante.',
      tone: 'info',
      facts,
      predicate: (f) => f.noThumb,
      link: { section: 'modelos' },
    }),
  ];

  // SELLABLE = pasa los cuatro bloqueadores. La calidad degrada la experiencia,
  // no impide la venta, así que no entra aquí.
  const blocked = facts.filter((f) => f.noPlan || f.inactive || f.noSku || f.unpriced);
  const ready = facts.length - blocked.length;
  const collections = new Set(facts.map((f) => f.collection));

  return {
    total: facts.length,
    active: facts.filter((f) => !f.inactive).length,
    drafts: facts.filter((f) => f.inactive).length,
    bound,
    collections: collections.size,
    ready,
    blocked: blocked.length,
    readyPct: facts.length ? Math.round((ready / facts.length) * 100) : null,
    /** Nothing blocks a single piece — the catalog is sellable end to end. */
    allReady: facts.length > 0 && blocked.length === 0 && !pricePending,
    /** Every quality row is clean too. */
    allPolished: facts.length > 0 && quality.every((c) => c.ok),
    /** The price join hasn't landed; `ready` is provisional and must say so. */
    pricePending,
    /** No `products.brand` catalog is assigned to this brand at all. */
    noPriceCatalog,
    /** A catalog IS assigned but holds no rows — import the price list. */
    priceCatalogEmpty,
    /** The screen the two above are fixed on. */
    priceCatalogLink: { section: 'marcas' },
    blockers,
    quality,
    empty: facts.length === 0,
  };
}

/* ───────────────────────────── los materiales ──────────────────────────── */

function resolveMaterialsHealth(materials) {
  const rows = rowsOf(materials);
  let colors = 0;
  let scanned = 0;
  let tinted = 0;
  let blank = 0;
  for (const m of rows) {
    for (const c of (Array.isArray(m?.colors) ? m.colors : [])) {
      colors += 1;
      // The weave the 3D tiles. Without it the fabric renders as a flat tone
      // (its averaged `rgb`) — and without even that, as nothing at all.
      if (c?.textureUrl) scanned += 1;
      else if (c?.rgb) tinted += 1;
      else blank += 1;
    }
  }
  const discontinued = rows.filter((m) => m?.discontinuedAt).length;
  const notInPriceList = rows.filter((m) => m?.notInPricelistAt).length;
  const withoutColors = rows.filter((m) => !(Array.isArray(m?.colors) && m.colors.length)).length;
  const ungraded = rows.filter((m) => !m?.grade).length;
  return {
    total: rows.length,
    colors,
    scanned,
    /** Colours the 3D can only tint flat (or not at all). */
    unscanned: colors - scanned,
    tinted,
    blank,
    discontinued,
    notInPriceList,
    withoutColors,
    ungraded,
    empty: rows.length === 0,
  };
}

/* ──────────────────────────── los distribuidores ───────────────────────── */

function resolveDealerBoard({ dealers, models, requests }) {
  const rows = rowsOf(dealers);
  const mods = rowsOf(models);
  const reqs = rowsOf(requests);

  // What the widget actually serves — `resolveConfiguratorModels`' own publish gate.
  const servable = mods.filter((m) => m?.active !== false && m?.svg);
  const countByKey = new Map();
  for (const m of servable) {
    const key = collectionKey(m.collection);
    countByKey.set(key, (countByKey.get(key) || 0) + 1);
  }
  // NOTHING can be judged against a catalog that isn't there (mid-load, or a
  // brand with no published pieces): with an empty catalog every dealer would
  // read as broken. Same rule resolveDealerCollections holds.
  const catalogKnown = servable.length > 0;

  const openByDealer = new Map();
  let directOpen = 0;
  for (const r of reqs) {
    if (!OPEN_REQUEST_STATUSES.includes(r?.status)) continue;
    if (!r?.dealerId) { directOpen += 1; continue; }
    openByDealer.set(r.dealerId, (openByDealer.get(r.dealerId) || 0) + 1);
  }

  const board = rows.map((d) => {
    const stored = dealerStoredCollections(d);
    // The column's contract (server + dealerStoredCollections): NULL, absent OR
    // empty ⇒ the whole catalog. An ARRAY with entries is a real restriction.
    const restricted = Array.isArray(stored);
    const labels = restricted ? [...new Set(stored.map(canonicalCollection))] : [];
    const keys = restricted ? new Set(stored.map(collectionKey)) : null;
    const served = restricted
      ? [...keys].reduce((s, k) => s + (countByKey.get(k) || 0), 0)
      : servable.length;
    // NO-VANISH: a carried collection the catalog no longer has still narrows
    // this dealer, so it is named rather than quietly dropped.
    const unknown = restricted
      ? [...new Set(stored.filter((c) => !countByKey.has(collectionKey(c))).map(canonicalCollection))]
      : [];
    const active = d?.active !== false;
    const multiplier = num(d?.priceMultiplier) || 1;
    const usdRate = num(d?.usdRate) || 1;
    const open = openByDealer.get(d?.id) || 0;
    // A restriction that resolves to nothing = a widget with an empty catalog.
    // Only meaningful for a LIVE dealer against a catalog we can actually read.
    const misconfigured = active && restricted && catalogKnown && served === 0;
    return {
      id: d?.id,
      name: String(d?.name || '').trim() || 'Distribuidor',
      slug: d?.slug || '',
      active,
      scopeLabel: restricted
        ? (labels.length ? labels.join(' · ') : 'Sin colecciones')
        : 'Todo el catálogo',
      restricted,
      servedPieces: served,
      catalogKnown,
      unknownCollections: unknown,
      currency: String(d?.currency || 'USD').toUpperCase(),
      localeLabel: dealerLocaleLabel(d?.locale),
      pricingLabel: dealerPricingLabel(d?.pricingMode),
      pricingMode: d?.pricingMode || 'full',
      priceMultiplier: multiplier,
      usdRate,
      /** Both money knobs at rest ⇒ the dealer shows the manufacturer's own USD retail. */
      priceIdentity: multiplier === 1 && usdRate === 1,
      openRequests: open,
      misconfigured,
      issue: misconfigured
        ? 'Su catálogo no resuelve ninguna pieza: el configurador le sale vacío.'
        : (unknown.length
          ? `Lleva ${plural(unknown.length, 'colección que ya no existe', 'colecciones que ya no existen')} en el catálogo: ${unknown.join(' · ')}.`
          : ''),
      link: { section: 'solicitudes', dealer: d?.id || null },
    };
  });

  // Worst first: lo roto, luego quien tiene más gente esperando.
  board.sort((a, b) => (Number(b.misconfigured) - Number(a.misconfigured))
    || (Number(b.active) - Number(a.active))
    || (b.openRequests - a.openRequests)
    || a.name.localeCompare(b.name));

  return {
    total: rows.length,
    active: board.filter((d) => d.active).length,
    inactive: board.filter((d) => !d.active).length,
    misconfigured: board.filter((d) => d.misconfigured).length,
    withStaleCollections: board.filter((d) => !d.misconfigured && d.unknownCollections.length).length,
    directOpen,
    catalogPieces: servable.length,
    catalogKnown,
    rows: board,
    empty: rows.length === 0,
  };
}

/* ────────────────────── solicitudes y cotizaciones ─────────────────────── */

function resolveRequestsSummary({ requests, dealers, recentMax, now }) {
  const rows = rowsOf(requests);
  const dealerRows = rowsOf(dealers);
  const dealerNameById = new Map(dealerRows.map((d) => [d.id, d.name]));
  // A routed lead's estimate was shown in THAT dealer's display currency
  // (markup × FX already applied), so it is labelled with the dealer's code and
  // never converted — and never added to another dealer's.
  const currencyById = new Map(dealerRows.map((d) => [d.id, String(d.currency || 'USD').toUpperCase()]));

  const byStatus = REQUEST_STATUSES.map((key) => ({
    ...requestStatusMeta(key),
    count: rows.filter((r) => r?.status === key).length,
    link: { section: 'solicitudes' },
  }));
  const open = rows.filter((r) => OPEN_REQUEST_STATUSES.includes(r?.status));

  const recent = [...rows]
    .sort((a, b) => num(b?.createdAt) - num(a?.createdAt))
    .slice(0, Math.max(0, recentMax))
    .map((r) => {
      const contact = r?.contact || {};
      const currency = (r?.dealerId && currencyById.get(r.dealerId)) || 'USD';
      const createdAt = num(r?.createdAt) || null;
      const estimate = r?.estimateUsd == null ? null : num(r.estimateUsd);
      return {
        id: r?.id,
        name: String(contact.name || '').trim() || 'Sin nombre',
        createdAt,
        ageDays: createdAt ? Math.max(0, Math.floor((now - createdAt) / DAY_MS)) : null,
        status: requestStatusMeta(r?.status),
        isDirect: !r?.dealerId,
        dealerLabel: r?.dealerId ? (dealerNameById.get(r.dealerId) || 'Distribuidor') : 'Directo',
        pieces: Array.isArray(r?.items) ? r.items.length : 0,
        currency,
        estimateLabel: estimate != null && estimate > 0 ? formatQuoteMoney(estimate, currency) : null,
        quoteId: r?.status === 'converted' ? (r?.quoteId || null) : null,
        link: { section: 'solicitudes', id: r?.id },
      };
    });

  // The oldest lead nobody has answered — the one number that says "hoy".
  let oldestOpenDays = null;
  for (const r of open) {
    if (r?.status !== 'pending' || !r?.createdAt) continue;
    const days = Math.max(0, Math.floor((now - num(r.createdAt)) / DAY_MS));
    if (oldestOpenDays == null || days > oldestOpenDays) oldestOpenDays = days;
  }

  return {
    total: rows.length,
    open: open.length,
    fresh: rows.filter((r) => r?.status === 'pending').length,
    converted: rows.filter((r) => r?.status === 'converted').length,
    oldestOpenDays,
    byStatus,
    recent,
    empty: rows.length === 0,
  };
}

function resolveQuotesSummary({ quotes, loaded, failed }) {
  const rows = rowsOf(quotes);

  const byStatus = QUOTE_STATUSES.map((key) => ({
    ...quoteStatusMeta(key),
    count: rows.filter((q) => q?.status === key).length,
    link: { section: 'cotizaciones', status: key },
  }));

  // THE CURRENCY WALL. Every bucket holds ONE currency and is labelled with it;
  // there is no cross-currency total anywhere in this object, because adding a
  // euro dealer's quote to a dollar one would be a number nobody quoted.
  const byCurrency = new Map();
  let withoutTotal = 0;
  for (const q of rows) {
    const currency = String(q?.currency || 'USD').toUpperCase();
    const bucket = byCurrency.get(currency) || {
      currency,
      count: 0,
      quotedCount: 0, quoted: 0,
      sentCount: 0, sent: 0,
      acceptedCount: 0, accepted: 0,
      declinedCount: 0, declined: 0,
    };
    bucket.count += 1;
    const total = q?.total == null ? null : num(q.total);
    // NO-VANISH: a quote with no frozen total still counts as a document; it
    // just adds no money (and is reported, so the gap is never invisible).
    if (total == null) withoutTotal += 1;
    const money = total == null ? 0 : total;
    if (q?.status === 'declined') { bucket.declinedCount += 1; bucket.declined += money; }
    else { bucket.quotedCount += 1; bucket.quoted += money; }
    if (q?.status === 'sent') { bucket.sentCount += 1; bucket.sent += money; }
    if (q?.status === 'accepted') { bucket.acceptedCount += 1; bucket.accepted += money; }
    byCurrency.set(currency, bucket);
  }

  const pipeline = [...byCurrency.values()]
    .sort((a, b) => (b.quoted - a.quoted) || a.currency.localeCompare(b.currency))
    .map((b) => ({
      ...b,
      quotedLabel: formatQuoteMoney(b.quoted, b.currency),
      sentLabel: formatQuoteMoney(b.sent, b.currency),
      acceptedLabel: formatQuoteMoney(b.accepted, b.currency),
    }));

  return {
    total: rows.length,
    loaded: !!loaded,
    failed: !!failed,
    byStatus,
    pipeline,
    /** Two or more currencies on the board — the reason there is no grand total. */
    multiCurrency: pipeline.length > 1,
    withoutTotal,
    /** Documents carrying at least one piece the server could not price. */
    unpricedLines: rows.filter((q) => num(q?.unpriced) > 0).length,
    /** Sent, and the customer has opened their link at least once. */
    seen: rows.filter((q) => num(q?.viewCount) > 0).length,
    empty: rows.length === 0,
  };
}

/* ────────────────────────── el entorno de la marca ─────────────────────── */

/**
 * What this brand's environment READS — its three import adapters, straight off
 * the resolved module set (`brands/modules`: `moduleSetFor(brand)`, which the
 * app hands down through AppContext). Derived here rather than imported from the
 * brand admin so the panel owns its own copy of the card, and defensively: a
 * half-written adapter renders as "sin datos", never as a crash on the home
 * screen.
 */
function resolveEnvironment({ brand, brandModules }) {
  const set = brandModules || null;
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  const geometry = set?.geometry || null;
  const materials = set?.materials || null;
  const catalog = set?.catalog || null;
  const grades = list(catalog?.grades);

  const cards = [
    {
      slot: 'geometry',
      title: 'Geometría',
      label: geometry?.label || 'Sin módulo',
      summary: geometry?.summary || '',
      facts: [
        { label: 'Acepta', value: list(geometry?.extensions).join(' · ') || '—' },
        ...(list(geometry?.sidecar).length
          ? [{ label: 'Texturas que acompañan', value: list(geometry.sidecar).join(' · ') }]
          : []),
        { label: 'Taxonomía', value: 'grupo · categoría · colección · modelo · variante' },
      ],
    },
    {
      slot: 'materials',
      title: 'Materiales',
      label: materials?.label || 'Sin módulo',
      summary: materials?.summary || '',
      facts: [
        { label: 'Acepta', value: list(materials?.extensions).join(' · ') || '—' },
        { label: 'Devuelve', value: 'código · nombre · color exacto · textura' },
      ],
    },
    {
      slot: 'catalog',
      title: 'Catálogo y precios',
      label: catalog?.label || 'Sin módulo',
      summary: catalog?.summary || '',
      facts: [
        { label: 'SKU', value: catalog?.skuHint || '—' },
        { label: 'Grados', value: grades.length ? grades.join(' ') : 'sin grados (un precio por SKU)' },
        { label: 'Lista de precios', value: list(catalog?.priceColumns).join(',') || '—' },
      ],
    },
  ];

  return {
    hasBrand: !!brand,
    name: brand?.name || brand?.slug || '',
    slug: brand?.slug || '',
    /** The brand's own mark and accent — the View renders them, never guesses
     *  them from the slug: a brand without a logo is not a broken brand. */
    branding: {
      logoUrl: brand?.branding?.logoUrl || null,
      primaryColor: brand?.branding?.primaryColor || null,
    },
    active: brand ? brand.active !== false : false,
    locale: brand?.locale || 'es',
    currency: String(brand?.currency || 'USD').toUpperCase(),
    /** Which `products.brand` catalog prices this environment; '' = none yet. */
    catalogBrand: brand?.settings?.catalogBrand || brand?.slug || '',
    setId: set?.setId || null,
    setLabel: set?.label || '',
    setSummary: set?.summary || '',
    /** The stored selection named a set the registry doesn't have — Ligne Roset's is running. */
    fellBack: !!set?.fellBack,
    /** At least one slot overridden away from the set's own adapter. */
    mixed: Object.keys(set?.overrides || {}).length > 0,
    cards,
    link: { section: 'marcas' },
  };
}

/* ────────────────────────────── the projection ─────────────────────────── */

/**
 * THE PANEL. Everything the home screen renders, from real rows only.
 *
 * @param brand          the open `brands` row (null on an unscoped install)
 * @param brandModules   its resolved import-module set (AppContext.brandModules)
 * @param models         `togo_models` rows for the open brand
 * @param materials      `materials` rows for the open brand
 * @param dealers        `dealers` rows for the open brand
 * @param requests       `togo_requests` rows for the open brand
 * @param quotes         the frozen quote LIST shapes (pages/quoting/api fetchQuotes)
 * @param products       the brand's price catalog — `{ reference, priceUsd }` is enough
 * @param productsLoaded false while that read is in flight: the price check
 *                       reports `pending` instead of a confident zero
 * @param quotesLoaded / quotesError  same honesty for the quote board
 * @param meshVersion    the mesh pipeline version in this deploy (ALCOVER_MESH_V);
 *                       0 ⇒ the optimization row is not offered at all
 */
export function resolveAdminDashboard({
  brand = null,
  brandModules = null,
  models = [],
  materials = [],
  dealers = [],
  requests = [],
  quotes = [],
  products = [],
  productsLoaded = true,
  quotesLoaded = true,
  quotesError = null,
  meshVersion = 0,
  recentMax = DASHBOARD_RECENT_MAX,
  now = Date.now(),
} = {}) {
  const splitSku = typeof brandModules?.catalog?.splitSku === 'function'
    ? brandModules.catalog.splitSku
    : null;

  const environment = resolveEnvironment({ brand, brandModules });
  const catalog = resolveCatalogReadiness({
    models, products, productsLoaded, splitSku, meshVersion: num(meshVersion),
    catalogBrand: environment.catalogBrand,
  });
  const materialsHealth = resolveMaterialsHealth(materials);
  const dealerBoard = resolveDealerBoard({ dealers, models, requests });
  const requestsSummary = resolveRequestsSummary({ requests, dealers, recentMax, now });
  const quotesSummary = resolveQuotesSummary({
    quotes, loaded: quotesLoaded, failed: !!quotesError,
  });

  // The four figures worth reading before anything else, each a link.
  const kpis = [
    {
      key: 'ready',
      label: 'Piezas listas para vender',
      value: catalog.total ? `${catalog.ready}/${catalog.total}` : '0',
      hint: catalog.empty
        ? 'Aún no hay modelos en esta marca.'
        : (catalog.pricePending
          ? 'Provisional: falta comprobar los precios del catálogo.'
          : (catalog.allReady
            ? 'Nada bloquea el catálogo.'
            : `${plural(catalog.blocked, 'pieza no se puede vender', 'piezas no se pueden vender')}.`)),
      tone: catalog.empty ? 'neutral' : (catalog.blocked > 0 ? 'warn' : 'good'),
      link: { section: 'modelos' },
    },
    {
      key: 'requests',
      label: 'Solicitudes abiertas',
      value: String(requestsSummary.open),
      hint: requestsSummary.empty
        ? 'Aún no hay solicitudes.'
        : (requestsSummary.oldestOpenDays != null
          ? `La más antigua sin atender lleva ${plural(requestsSummary.oldestOpenDays, 'día', 'días')}.`
          : 'Ninguna sin atender.'),
      tone: requestsSummary.open > 0 ? 'warn' : 'neutral',
      link: { section: 'solicitudes' },
    },
    {
      key: 'quotes',
      label: 'Cotizaciones enviadas',
      value: String(quotesSummary.byStatus.find((s) => s.key === 'sent')?.count ?? 0),
      hint: quotesSummary.empty
        ? 'Aún no hay cotizaciones.'
        : `${plural(quotesSummary.seen, 'abierta por el cliente', 'abiertas por el cliente')}.`,
      tone: 'neutral',
      link: { section: 'cotizaciones' },
    },
    {
      key: 'dealers',
      label: 'Distribuidores activos',
      value: String(dealerBoard.active),
      hint: dealerBoard.empty
        ? 'Aún no hay distribuidores.'
        : (dealerBoard.misconfigured > 0
          ? `${plural(dealerBoard.misconfigured, 'sirve', 'sirven')} un catálogo vacío.`
          : `${plural(dealerBoard.catalogPieces, 'pieza publicada', 'piezas publicadas')} para repartir.`),
      tone: dealerBoard.misconfigured > 0 ? 'bad' : 'neutral',
      link: { section: 'distribuidores' },
    },
  ];

  return { brand: environment, kpis, catalog, materials: materialsHealth, dealers: dealerBoard, requests: requestsSummary, quotes: quotesSummary, environment };
}
