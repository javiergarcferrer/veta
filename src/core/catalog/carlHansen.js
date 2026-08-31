// core/catalog/carlHansen — the ViewModels behind the Carl Hansen & Søn importer.
//
// Four surfaces, four resolvers, and between them they leave the View with
// NOTHING to derive: a browser grid over the cached product pages, a
// configurator over one model's selection trees + price list, the import plan
// that turns a configuration into `products` rows, and the 3D pipeline's state
// for one model.
//
// Everything below COMPOSES the pure Models in `brands/carl-hansen/*` (which own
// every rule that could be wrong about money) and adds only projection. Three
// things earn their place here rather than there:
//
//  1. THE CHECKS ARE DATA — `{code, level, field, message}`, the docCapture
//     idiom. The View paints each one next to the field it doubts, and only
//     `level: 'blocker'` may stop an import. A prose string would be
//     unpinnable and would drift the moment the copy changed.
//
//  2. NO-VANISH. A page whose model id didn't resolve (the measured `FK64_item`
//     singleton), or a model with no cached price row, STAYS IN THE GRID with
//     its reason attached. Filtering it out would make the gap invisible
//     exactly where somebody would go looking for it.
//
//  3. THE AXIS `kind`. `parseSelectionTree` does not emit one (it reports what
//     the tree published, and the tree names axes by POSITION — "Frame",
//     "Seat", "Seat and Back" — never by material). `buildBindingPlan` binds a
//     mesh material to an axis by FAMILY, so without a kind CH24's 13 wood
//     groups match nothing and every Wishbone lands in manual review. The
//     family is in the tree, one level down: the axis's top BRANCH labels are
//     "Wood" / "Cord" / "Upholstery". `chAxisKind` reads it there, through the
//     same `materialKindOf` word table the binder uses, so the two can't
//     disagree about what "weaving" means.
//
// MONEY RULE, inherited and never relaxed: this importer writes LIST PRICE
// ONLY. No resolver here computes, copies or invents a `cost` — that arrives
// from the landed-cost engine when the expediente is posted. Prices are ex-VAT
// USD and never converted; a DOP figure has no business in this file.
//
// Pure projection: no React, no db, no supabase. Pinned by
// tests/carlHansenViews.test.js.

import {
  parseSelectionTree,
  defaultSelection,
  enumerateSelections,
  configurationIds,
} from '../../brands/carl-hansen/selectionTree.js';
import {
  composePriceKey,
  resolveListPrice,
  priceListStateOf,
  priceListValidity,
  parseChDate,
} from '../../brands/carl-hansen/price.js';
import { swatchUrlFor, slugifyMaterial } from '../../brands/carl-hansen/swatches.js';
import { buildCarlHansenProductRows } from '../../brands/carl-hansen/productRows.js';
import { classifyZip } from '../../brands/carl-hansen/assetTier.js';
import { buildBindingPlan, materialKindOf } from '../../brands/carl-hansen/materialBind.js';

// LA MISMA proyección que el configurador público: chModelName, chAxisKind y
// resolveCarlHansenConfigurator viven en carlHansenConfigurator.js (la
// extracción que CarlHansenEmbed lee) y aquí sólo se RE-EXPORTAN — una
// implementación, un hogar; el plan de import de abajo la consume tal cual.
import { chModelName, chAxisKind, resolveCarlHansenConfigurator } from './carlHansenConfigurator.js';
export { chModelName, chAxisKind, resolveCarlHansenConfigurator };

const DAY_MS = 86_400_000;

/** Rows rendered before the grid reports the rest as `more`. */
export const CH_BROWSER_LIMIT = 60;

/* ---------------------------------------------------------------- helpers -- */

const str = (v) => (v == null ? '' : String(v));
const squish = (v) => str(v).replace(/\s+/g, ' ').trim();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

/** Lowercase, fold diacritics, punctuation → spaces. Search/facet matching
 *  only — deliberately NOT `foldSearchText`, which is byte-locked to a SQL
 *  function and must not grow a second caller with different needs. */
function fold(value) {
  return str(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `"chairs"` / `"tables-desks"` → `"Chairs"` / `"Tables Desks"`, for a facet
 *  with no breadcrumb to name it. */
function prettify(slug) {
  return squish(str(slug).replace(/[-_]+/g, ' '))
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}



/** `{code, level, field, message}` — the check vocabulary of this module. */
function issue(code, level, field, message) {
  return { code, level, field, message };
}

/** A `carl_hansen_pages` row (or a raw `pageData`) as `ChPageData`. */
function toPageData(page) {
  if (!isObj(page)) return null;
  if (Array.isArray(page.Variants)) return page;
  return {
    ProductName: str(page.name),
    ProductId: str(page.productId),
    Breadcrumb: arr(page.breadcrumb),
    Variants: arr(page.variants),
  };
}

/** A `carl_hansen_prices` row (or a raw published price file) as `ChPriceList`.
 *  BOTH validity spellings pass through untouched (`validFromDate` off the
 *  blob, `validFrom` off the cached row) — `priceListValidity` in the Model
 *  owns which one wins, and re-deciding it here would be a second opinion. */
function toPriceList(row) {
  if (!isObj(row)) return null;
  return {
    model: str(row.modelId || row.model),
    currency: str(row.currency),
    marketCode: str(row.marketCode),
    taxIncluded: row.taxIncluded === true,
    validFromDate: row.validFromDate ?? null,
    validToDate: row.validToDate ?? null,
    validFrom: row.validFrom ?? null,
    validTo: row.validTo ?? null,
    modelPrices: isObj(row.modelPrices) ? row.modelPrices : null,
    addOnPrices: isObj(row.addOnPrices) ? row.addOnPrices : null,
    axAddOnPrices: isObj(row.axAddOnPrices) ? row.axAddOnPrices : null,
    dfoAddOnPrices: isObj(row.dfoAddOnPrices) ? row.dfoAddOnPrices : null,
  };
}

/** An image (media entry or variant render) as the View renders it. */
function toImage(raw) {
  if (!isObj(raw)) return null;
  const url = squish(raw.Url || raw.url);
  if (!url) return null;
  return {
    url,
    width: Number(raw.Width ?? raw.width) || null,
    height: Number(raw.Height ?? raw.height) || null,
    alt: squish(raw.AlternativeText ?? raw.alt),
  };
}

const toImages = (list) => arr(list).map(toImage).filter(Boolean);

/**
 * The cover shot for a model card: the curated hero if the page has one,
 * otherwise the first VARIANT render.
 *
 * MEASURED, and the reason this fallback exists: 27 of 60 sampled furniture
 * pages (45%) publish an EMPTY `MediaList` — CH20 Elbow Chair among them — and
 * every single one of those carries variant renders anyway (CH20 has 27, CH29P
 * has 30). Reading only `MediaList` put «SIN FOTO» on nearly half the
 * catalogue while the photos sat one field away. Of the sampled pages with no
 * MediaList, ZERO were genuinely photo-less.
 *
 * Hero first, not variant first: the card names a MODEL, so the lifestyle shot
 * is the better cover when the page bothered to publish one. The configurator
 * inverts this deliberately (it is showing ONE configuration, so the variant
 * render wins there) — the two are different questions, not a drift.
 */
function coverImage(page) {
  const hero = toImages(page?.media)[0]?.url;
  if (hero) return hero;
  for (const variant of arr(page?.variants)) {
    const shot = toImages(variant?.Images ?? variant?.images)[0]?.url;
    if (shot) return shot;
  }
  return '';
}

/* ------------------------------------------------------------- asset links -- */

/**
 * What one `Specs.OtherAssets` entry IS. The naming is inconsistent by the
 * source's own standards (`ch24_3d-2.zip`, `VLA26_3D.zip`, `3d_ch22.zip`,
 * `BM1106.revit.zip`), so the match is case-insensitive over description AND
 * url — and `3d` wins over `revit` because `FK11_3D_Revit.zip` is both.
 *
 * The plain `<MODEL>.zip` is a Revit `.rfa` and matches NOTHING here on
 * purpose: reading it as the 3D zip is the easy, expensive mistake.
 */
export function chAssetKind(link) {
  const text = `${str(link?.description)} ${str(link?.url)}`;
  if (/3d/i.test(text)) return '3d';
  if (/revit|\.rfa\b/i.test(text)) return 'revit';
  if (/\.max\b|_max\b/i.test(text)) return 'max';
  if (/2d/i.test(text)) return '2d';
  return 'other';
}

function assetLinksOf(page) {
  return arr(page?.assetLinks ?? page?.asset_links)
    .map((raw) => {
      const url = squish(raw?.url ?? raw?.Url);
      if (!url) return null;
      const description = squish(raw?.description ?? raw?.Description);
      const link = { description, url, name: description || (url.split('/').pop() || url) };
      return { ...link, kind: chAssetKind(link) };
    })
    .filter(Boolean);
}

/* ================================================================= browser == */

/**
 * The importer's grid: every cached product page, filtered and faceted.
 *
 *   pages   — `carl_hansen_pages` rows.
 *   search  — matches model code, model name and designer (all tokens must hit).
 *   designer/category — facet selections (`''` = all).
 *   specs/prices — OPTIONAL `carl_hansen_specs` / `carl_hansen_prices` rows.
 *     Supplied, they let a card say it has no configurator or no price list;
 *     omitted, the card stays silent about it rather than claiming a gap it
 *     never looked for.
 *
 * Facets are counted over the SEARCH-filtered rows only — never over the
 * designer/category selection itself, or picking a facet would collapse its
 * own list to one entry and strand the dealer.
 */
export function resolveCarlHansenBrowser(pages, {
  search = '',
  designer = '',
  category = '',
  limit = CH_BROWSER_LIMIT,
  specs = null,
  prices = null,
} = {}) {
  const specIds = specs ? new Set(arr(specs).map((s) => str(s?.id ?? s?.modelId)).filter(Boolean)) : null;
  const priceIds = prices ? new Set(arr(prices).map((p) => str(p?.modelId)).filter(Boolean)) : null;

  // ── CURSOR ROWS ARE NOT PRODUCTS ────────────────────────────────────────────
  // The sweep must record that it READ a url even when that url turns out not to
  // be a product page — roughly 32 of the ~165 furniture urls are section or
  // redirect pages. Without a row their `fetched_at` never advances and the
  // sweep re-downloads the same 25 pages forever instead of reaching page 26.
  // Those bookkeeping rows carry an empty `variants` and nothing else.
  //
  // They are NOT models and must never reach the grid. Rendering them produced a
  // screen of identical dead cards — «SIN FOTO · — · Sin diseñador · ID SIN
  // RESOLVER» — which reads as a broken importer rather than as a sweep that is
  // working correctly.
  //
  // This is NOT the no-vanish rule and does not weaken it: a real product whose
  // model id failed to resolve, or that has no spec or no price, still appears,
  // still flagged. The difference is that a cursor row was never a product at
  // all. `slimPage` returns null unless the page has at least one variant, so a
  // product row always carries one — an empty `variants` is the marker, and it
  // needs no column and no constant shared across the Deno↔Vite wall.
  const all = arr(pages);
  const products = all.filter((page) => arr(page?.variants).length > 0);
  const skipped = all.length - products.length;

  const cards = products.map((page) => {
    const { code, name, fullName } = chModelName(page?.name);
    const modelId = squish(page?.modelId);
    const crumbs = arr(page?.breadcrumb);
    const links = assetLinksOf(page);
    const designerName = squish(page?.designer);
    const categorySlug = squish(page?.category);

    const issues = [];
    if (!modelId || page?.modelIdUnresolved === true) issues.push('model-unresolved');
    if (modelId && specIds && !specIds.has(modelId)) issues.push('spec-missing');
    if (modelId && priceIds && !priceIds.has(modelId)) issues.push('price-missing');

    return {
      id: str(page?.id),
      url: str(page?.url),
      productId: str(page?.productId),
      modelId: modelId || null,
      code,
      name,
      fullName,
      designer: designerName,
      category: categorySlug,
      // The breadcrumb reads `Products > Chairs > Dining Chairs`: [1] names the
      // section the slug came from, the last crumb the shelf it sits on.
      categoryLabel: squish(crumbs[1]?.Title) || prettify(categorySlug),
      shelfLabel: squish(crumbs[crumbs.length - 1]?.Title),
      imageSrc: coverImage(page),
      variantCount: arr(page?.variants).length,
      assetLinks: links,
      has3d: links.some((l) => l.kind === '3d'),
      hasSpec: specIds ? (!!modelId && specIds.has(modelId)) : null,
      hasPrice: priceIds ? (!!modelId && priceIds.has(modelId)) : null,
      fetchedAt: page?.fetchedAt ?? null,
      issues,
      unresolved: issues.length > 0,
      searchText: fold([code, name, designerName, modelId, str(page?.productId)].join(' ')),
    };
  });

  const tokens = fold(search).split(' ').filter(Boolean);
  const searched = tokens.length
    ? cards.filter((c) => tokens.every((t) => c.searchText.includes(t)))
    : cards;

  const designerKey = fold(designer);
  const categoryKey = fold(category);
  const matched = searched.filter((c) => (
    (!designerKey || fold(c.designer) === designerKey)
    && (!categoryKey || fold(c.category) === categoryKey || fold(c.categoryLabel) === categoryKey)
  ));

  matched.sort((a, b) => (
    (a.code || a.name).localeCompare(b.code || b.name, 'en', { numeric: true, sensitivity: 'base' })
    || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  ));

  const models = limit > 0 ? matched.slice(0, limit) : matched;

  return {
    models,
    designers: facet(searched, (c) => c.designer, (c) => c.designer, designerKey),
    categories: facet(searched, (c) => c.category, (c) => c.categoryLabel, categoryKey),
    total: matched.length,
    /** Every cached PRODUCT, before search/designer/category filtering — what a
     *  header means by "in cache". Distinct from `total`, which is what the
     *  current filters matched. */
    catalogued: products.length,
    /** Cached urls the sweep read that were not product pages (section and
     *  redirect pages). Bookkeeping, never rendered — surfaced only so a screen
     *  can explain the gap between "urls cached" and "models shown". */
    skipped,
    more: Math.max(0, matched.length - models.length),
    // NO-VANISH: the flagged cards are IN `models` above; this is the banner's
    // list, not a set the grid dropped. Counted over the WHOLE filtered set,
    // not the rendered page — a gap doesn't stop existing at row 61.
    unresolved: matched.filter((c) => c.unresolved),
  };
}

/** `[{value, label, count, selected}]`, biggest first then alphabetical. */
function facet(cards, valueOf, labelOf, selectedKey) {
  const byValue = new Map();
  for (const card of cards) {
    const value = valueOf(card);
    if (!value) continue;
    const hit = byValue.get(value);
    if (hit) hit.count += 1;
    else byValue.set(value, { value, label: labelOf(card) || value, count: 1, selected: fold(value) === selectedKey });
  }
  return [...byValue.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'en'));
}

/* ============================================================ configurator == */
// resolveCarlHansenConfigurator vive en carlHansenConfigurator.js (re-exportado
// arriba); lo que sigue son los ayudantes del PLAN DE IMPORT que lo consumen.

/** Chains root→leaf for every selectable terminal, in `axis.leaves` order. */
function leafChains(nodes, acc = [], out = []) {
  for (const node of arr(nodes)) {
    const chain = [...acc, node];
    if (node.children?.length) leafChains(node.children, chain, out);
    else if (node.isSelectable) out.push(chain);
  }
  return out;
}

/**
 * A leaf's swatch: the one the tree published, else the materials-page CDN
 * join — but ONLY when the caller supplied the collection's real slug.
 *
 * The join needs a slug the selection tree does not carry: the leaf says
 * "Canvas 0356" under a node labelled "Canvas", while the asset lives under
 * `canvas-2/canvas2_0356.jpg` (Kvadrat's "Canvas 2"). Guessing `canvas` would
 * emit a 404'd <img> in the configurator, which `swatches.js` exists to
 * prevent. No slug ⇒ null ⇒ the View renders a colour chip, which is a normal
 * answer and not an error.
 */
function swatchFor(chain, collectionSlugs) {
  const leaf = chain[chain.length - 1];
  if (leaf?.swatch) return leaf.swatch;
  const parent = chain[chain.length - 2];
  if (!parent || !isObj(collectionSlugs)) return null;
  const slug = collectionSlugs[slugifyMaterial(parent.label)] ?? collectionSlugs[slugifyMaterial(parent.key)];
  if (!slug) return null;
  const group = [...chain].reverse().find((n) => /group/i.test(str(n.label)));
  // Ancestors nearest-first: `swatchUrlFor` answers null for a family outside
  // the measured taxonomy, so the family table stays its business, not ours.
  for (let i = chain.length - 3; i >= 0; i -= 1) {
    const url = swatchUrlFor(chain[i].label, group?.label, slug, leaf.label);
    if (url) return url;
  }
  return null;
}

/** Selection keys may arrive as axis names (the price templates speak names);
 *  normalize onto axis ids so an override can never lose to a default. */
function normalizeSelection(axes, selection) {
  if (!isObj(selection)) return {};
  const byName = new Map(axes.map((a) => [a.name, a.id]));
  const out = {};
  for (const [key, value] of Object.entries(selection)) {
    if (value == null || value === '') continue;
    out[byName.get(key) ?? key] = str(value);
  }
  return out;
}

/** The configuration whose axes we render: the caller's, else the one named
 *  like the model (`CH24`, not the `CUCH24` cushion that shares the file). */
function pickConfigId(spec, axes, wanted) {
  if (wanted) return str(wanted);
  const modelId = str(spec?.id || spec?.modelId);
  const ids = [...new Set(axes.map((a) => a.configId).filter(Boolean))];
  if (modelId && ids.includes(modelId)) return modelId;
  return ids[0] || '';
}


/**
 * The variant, as the configurator shows it.
 *
 * `Stock` is DELIBERATELY NOT PROJECTED. Carl Hansen is made to order: a zero
 * in the Odense warehouse means "wait 54 days", not "cannot sell", and the
 * importer already refuses to write it onto the product row (it would make the
 * row TRACKED and the quote picker would refuse 41% of the Wishbone Chair).
 * Projecting it here would just re-open the same misreading one layer up —
 * `productionDays` is the field that answers the dealer's actual question.
 */
function toVariant(raw) {
  const days = Number(raw?.ProductionDays);
  return {
    sku: squish(raw?.Sku),
    configuration: squish(raw?.FormattedConfiguration),
    configurationDictionary: isObj(raw?.ConfigurationDictionary) ? raw.ConfigurationDictionary : {},
    // Never 0 — that would read as "ships today".
    productionDays: Number.isFinite(days) && days > 0 ? Math.trunc(days) : null,
    pageUrl: squish(raw?.PageUrl),
    images: toImages(raw?.Images),
  };
}

/**
 * Every check the configurator (and therefore the import plan) makes, as data.
 *
 * The blockers are the ways this importer could write a WRONG number into the
 * catalog; the warnings are the ways it could be about to.
 */
function configuratorIssues({ spec, page, pageData, priceList, priceKey, priced, listPriceUsd, state, matches, modelId, axes }) {
  const out = [];

  if (!isObj(spec) || !axes.length) {
    out.push(issue('spec-missing', 'blocker', 'model',
      'No hay ficha PIM para este modelo — no se puede configurar ni cotizar.'));
  }
  if (!modelId || page?.modelIdUnresolved === true) {
    out.push(issue('model-unresolved', 'blocker', 'model',
      'El modelo de la página no resolvió contra el PIM; revísalo antes de importar.'));
  }
  if (!pageData || !arr(pageData.Variants).length) {
    out.push(issue('page-missing', 'blocker', 'variant',
      'No hay página de producto en caché: sin variantes no hay EAN que importar.'));
  }

  // ── the price list itself ─────────────────────────────────────────────────
  if (!priceList) {
    out.push(issue('price-list-missing', 'blocker', 'price',
      'No hay lista de precios VAT0-USD en caché para este modelo.'));
  } else {
    if (priceList.currency && priceList.currency.toUpperCase() !== 'USD') {
      out.push(issue('price-currency', 'blocker', 'price',
        `La lista está en ${priceList.currency}; el importador solo acepta USD sin ITBIS.`));
    }
    if (priceList.taxIncluded) {
      out.push(issue('price-tax-included', 'blocker', 'price',
        'La lista trae impuesto incluido; se necesita la lista ex-VAT (VAT0-USD).'));
    }
    // STALENESS IS A MONEY RULE: an expired list is last season's numbers, and
    // minting a catalog from them is a defect nobody sees until a quote goes out.
    if (state === 'expired') {
      out.push(issue('price-list-expired', 'blocker', 'price',
        'La lista de precios venció. Actualízala antes de importar — son precios de la temporada pasada.'));
    } else if (state === 'expiring') {
      out.push(issue('price-list-expiring', 'warn', 'price',
        'La lista de precios está por vencer; conviene refrescarla.'));
    } else if (state === 'unknown') {
      out.push(issue('price-list-window-unknown', 'warn', 'price',
        'La lista no declara una vigencia utilizable.'));
    }
  }

  // ── this configuration's price ────────────────────────────────────────────
  if (!priceKey.key) {
    const missing = priceKey.missing.length ? priceKey.missing : ['price'];
    for (const field of missing) {
      out.push(issue('price-key-incomplete', 'blocker', field,
        'Falta elegir esta opción: sin ella no se arma la clave de precio.'));
    }
  } else if (priced.priceUsd == null) {
    out.push(issue('price-unmatched', 'blocker', 'price',
      `La combinación (${priceKey.key}) no existe en la lista publicada.`));
  } else if (listPriceUsd == null) {
    // The base resolved but a selected surcharge couldn't be classified, so the
    // Model refused to price. Importing the bare base would under-bill by
    // exactly that surcharge — the one error this whole layer exists to stop.
    out.push(issue('addon-unclassified', 'blocker', 'price',
      'Hay un recargo seleccionado que no se pudo clasificar; el precio quedaría por debajo del real.'));
  } else if (arr(priced.addOns).some((a) => a?.kind === 'identity')) {
    // A CONFIGURATION COLLISION, and the reason it is a blocker rather than a
    // warning: `requiredLabels` matches variants by their visible wood/finish/
    // cord labels and is BLIND to add-on axes. CH24 and CH24-H43 therefore
    // claim the SAME 21 EANs off the same label chains — measured — but price
    // them $145 apart. Since a product id is `ch-<EAN>`, importing under the
    // H43 would RESTATE the plain Wishbone's already-imported rows $145 higher:
    // a silent overcharge on the dealer's own catalogue, discovered at the
    // customer's quote.
    //
    // So the identity surcharge is exactly the thing that makes a configuration
    // unmintable until variant matching can tell the two apart. Browsing and
    // pricing stay open (the dealer can see what an H43 costs); only the WRITE
    // stops. Lifting this needs configuration-aware matching, not a wider id.
    const names = arr(priced.addOns).filter((a) => a?.kind === 'identity')
      .map((a) => a.label || a.code).join(', ');
    out.push(issue('config-identity-addon', 'blocker', 'configuration',
      `Esta configuración se distingue por un recargo obligatorio (${names}), y las variantes `
      + 'publicadas no lo mencionan: las que coinciden son de la configuración base y se importarían '
      + 'a un precio más alto. Se puede consultar el precio, pero no importar desde aquí.'));
  } else if (priced.matched === 'alt') {
    out.push(issue('price-matched-alt', 'info', 'price',
      `Precio resuelto por la codificación alterna (${priced.matchedKey}).`));
  }

  // ── the variant ───────────────────────────────────────────────────────────
  if (pageData && arr(pageData.Variants).length && !matches.length) {
    out.push(issue('variant-unmatched', 'blocker', 'variant',
      'Ninguna variante publicada corresponde a esta combinación — no hay EAN que importar.'));
  } else if (matches.length > 1) {
    out.push(issue('variant-ambiguous', 'warn', 'variant',
      `${matches.length} variantes corresponden a esta combinación; se importan todas.`));
  }

  return out;
}

/* ============================================================= import plan == */

/**
 * What pressing «Importar» would write, and everything standing in the way.
 *
 * Rows come from the Model (`buildCarlHansenProductRows`) — list price only,
 * and `cost` is not even a key on them. A single `level: 'blocker'` yields NO
 * rows: a plan that mints half a catalog at a price we can't stand behind is
 * worse than one that mints nothing and says why.
 */
export function resolveCarlHansenImportPlan(spec, page, priceRow, selection, {
  now = Date.now(), profileId = '', configId = null, rawAxes = null, probeAddOns = true, modelAxes = null,
} = {}) {
  const view = resolveCarlHansenConfigurator(spec, priceRow, page, {
    selection, now, configId, rawAxes, probeAddOns, modelAxes,
  });
  const issues = [...view.unresolved];

  if (!str(profileId)) {
    issues.push(issue('profile-missing', 'blocker', 'profile',
      'Falta el perfil destino; no se puede escribir en el catálogo.'));
  }

  const blockers = issues.filter((i) => i.level === 'blocker');
  const warnings = issues.filter((i) => i.level !== 'blocker');

  const rows = blockers.length ? [] : buildCarlHansenProductRows(
    {
      modelId: view.modelId || '',
      configId: view.configId,
      friendlyName: squish(spec?.friendlyName),
      // The caller's raw axes when it lent them (the bulk pass — stable
      // objects keep the matcher's per-axis caches warm across thousands of
      // combinations); the enriched view axes otherwise. Same match inputs
      // either way: enrichment only adds display fields.
      axes: Array.isArray(rawAxes) ? rawAxes : view.axes,
      modelAxes: view.modelAxes,
      configurations: Array.isArray(spec?.configurations) ? spec.configurations : null,
    },
    toPageData(page),
    view.priced,
    view.selection,
    { profileId: str(profileId), now },
  );

  return {
    rows,
    blockers,
    warnings,
    // Rides ALONGSIDE the rows: `products` has no lead-time column, and a
    // made-to-order catalog without "73 días" beside it is missing the only
    // availability figure that is true.
    leadTimes: blockers.length ? [] : view.leadTimes,
    leadTimeDays: blockers.length ? null : view.leadTimeDays,
    // The `carl_hansen_imports` audit row: which configuration, at which key,
    // at which price, against which validity. Six months from now this is what
    // answers "why does this product say $1,350".
    audit: {
      modelId: view.modelId,
      configId: view.configId,
      selection: view.selection,
      priceKey: view.priceKey.key,
      // The price that was WRITTEN (base + mandatory surcharges), and the raw
      // base beside it — a later reader must be able to see both.
      listPriceUsd: view.listPriceUsd,
      basePriceUsd: view.basePriceUsd,
      priceValidTo: view.priceValidTo,
      priceState: view.priceState,
    },
  };
}

/* ================================================================= 3D asset = */

const TIERS = new Set(['a', 'b', 'none']);

/**
 * Where one model stands in the 3D pipeline, from its page's asset links plus
 * whatever the `carl_hansen_assets` row already knows.
 *
 * `zipEntries` (the archive's central directory, which the browser can read
 * over a Range request before downloading 22 MB) upgrades a stored tier to a
 * live classification; `materialNames` / `textureNames` let the binding plan be
 * recomputed once the archive is open. Given none of them this still answers —
 * from the stored row — which is what the grid needs.
 *
 * `state` is a CODE, never prose:
 *   no-asset · revit-only · unclassified · not-web-usable · convertible ·
 *   needs-review · ready
 */
export function resolveCarlHansenAssets(page, assetRow, {
  now = Date.now(),
  zipEntries = null,
  materialNames = null,
  textureNames = null,
  axes = null,
} = {}) {
  const links = assetLinksOf(page);
  // Only a 3D/max archive is a conversion candidate. A Revit `.rfa` is not web
  // geometry and gets its own state instead of being offered as one.
  const pick = links.find((l) => l.kind === '3d') || links.find((l) => l.kind === 'max') || null;
  const revitOnly = !pick && links.some((l) => l.kind === 'revit');

  const zipUrl = pick?.url || squish(assetRow?.sourceZipUrl) || null;
  const zipName = pick?.name || squish(assetRow?.sourceZipName) || null;

  const classified = zipEntries ? classifyZip(zipEntries) : null;
  const storedTier = TIERS.has(str(assetRow?.meshTier)) ? str(assetRow.meshTier) : null;
  const tier = classified ? classified.tier : (pick || assetRow ? storedTier : null);

  const meshUrl = squish(assetRow?.meshUrl) || null;
  const reviewedAt = parseChDate(assetRow?.bindingReviewedAt);

  // A fresh plan when the archive is open; otherwise whatever was stored.
  const textures = textureNames || classified?.textures || null;
  const plan = (tier && (materialNames || textures))
    ? buildBindingPlan({
      tier,
      materialNames,
      textureNames: textures,
      axes: arr(axes).map((a) => ({ id: a?.id, kind: a?.kind ?? null, label: a?.label ?? null })),
    })
    : null;
  const stored = isObj(assetRow?.binding) ? assetRow.binding : null;
  const binding = plan || (stored ? { groups: arr(stored.groups), needsReview: !reviewedAt } : null);

  const needsBindingReview = reviewedAt
    ? false
    : plan ? plan.needsReview
      : stored ? true
        : !!meshUrl; // a converted mesh with no binding at all still needs a human

  const state = !zipUrl && !meshUrl
    ? (revitOnly ? 'revit-only' : 'no-asset')
    : meshUrl
      ? (needsBindingReview ? 'needs-review' : 'ready')
      : tier === 'none' ? 'not-web-usable'
        : tier ? 'convertible'
          : 'unclassified';

  const ingestedAt = parseChDate(assetRow?.ingestedAt);

  return {
    zipUrl,
    zipName,
    tier,
    meshUrl,
    needsBindingReview,
    state,
    binding,
    reason: classified?.reason ?? null,
    mesh: classified?.mesh ?? null,
    mtl: classified?.mtl ?? null,
    textures: classified?.textures ?? [],
    meshSourceUrl: squish(assetRow?.meshSourceUrl) || null,
    meshV: Number.isFinite(Number(assetRow?.meshV)) ? Number(assetRow.meshV) : null,
    ingestedAt: ingestedAt ?? null,
    ageDays: ingestedAt == null ? null : Math.max(0, Math.floor((now - ingestedAt) / DAY_MS)),
    // NO-VANISH: the 2D drawings and the Revit archive stay listed even though
    // the pipeline can't use them — somebody asks for the DWG eventually.
    assets: links,
  };
}

/* ================================================== the whole range at once = */

/**
 * THE BULK IMPORT PLAN — every model, every configuration, every combination.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The per-model flow (`resolveCarlHansenImportPlan`) imports ONE configuration:
 * the dealer opens a chair, picks a wood, picks a seat, imports that. That is
 * right when you are quoting one piece and wrong as a way to GET A CATALOG —
 * Carl Hansen publishes ~165 pages and the Wishbone alone is 41 buyable
 * variants, so "have the range ready to browse" was several hundred clicks.
 *
 * This walks it instead: for each model with a spec and a price list, every
 * configuration the master publishes, every selection those axes allow, through
 * the SAME resolver. It is a loop over the existing rule, not a second one —
 * every money rule (null price is a blocker, an identity add-on configuration
 * is refused, cost and stock are never written) is inherited by construction
 * rather than restated here, where it would drift.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 * A combination whose plan carries BLOCKERS is skipped and COUNTED. The two
 * that actually fire in bulk are worth naming:
 *   • no price for the composed key — writing a chair at a guessed price is
 *     the one outcome worse than not having it;
 *   • `config-identity-addon` — CH24 and CH24-H43 claim the SAME 21 EANs $145
 *     apart, so importing the tall chair would restate the plain one's rows
 *     higher. The per-model page already blocks this; the bulk pass must not
 *     quietly do what the careful path refuses.
 *
 * ── DEDUPE IS BY EAN, FIRST WRITER WINS ─────────────────────────────────────
 * One EAN can be reachable from more than one selection (an add-on axis that
 * does not change the piece). The FIRST plan to produce it keeps it, and
 * configurations are walked in the master's published order — so the model's
 * primary configuration wins over a later variant of it, which is the same
 * "page order is the supplier's answer" rule the Fredericia importer uses.
 *
 * Pure. `models` is [{ page, spec, priceRow }]; nothing here fetches.
 *
 * @returns { rows, leadTimes, audits, summary, skipped, truncated }
 */
