/**
 * VIEWMODEL — EL CONFIGURADOR DE CARL HANSEN.
 *
 * The second configurator in this product, and the first one that is not Togo.
 * They answer different questions and that is the whole reason the seam exists:
 *
 *   TOGO      composes GEOMETRY. You place modules on a floor, and the price is
 *             the sum of the pieces you placed (`core/quote/views/configurator`).
 *   CARL HANSEN composes a SINGLE PIECE. A Wishbone Chair is one chair; what
 *             you choose is its wood, its finish, its seat — axes, not modules
 *             — and the answer is one composed SKU at one list price.
 *
 * A floor-plan canvas would be the wrong instrument for a chair, and an axis
 * picker would be the wrong instrument for a modular sofa. So each brand brings
 * its own (see `brands/configurators`).
 *
 * ── WHY THIS IS PORTED AND NOT WRITTEN ──────────────────────────────────────
 * The pricing grammar underneath it was MEASURED against the manufacturer's own
 * data, not inferred: `CH24_01_020101` is Seat-then-Frame while
 * `CH07_<Frame>_<SeatBack>` is Frame-then-SeatBack, so the key order is not a
 * rule anyone may hardcode — each configuration publishes its own mustache
 * template and we render THAT. Rewriting it from the shape of the JSON would
 * have quietly lost that, and a wrong price key is a wrong quote.
 *
 * ── THE MONEY RULES IT INHERITS ─────────────────────────────────────────────
 *   • A key that resolves to nothing prices NOTHING. Never interpolate, never
 *     nearest-match. A null reads as "sin precio" and is recoverable; a
 *     plausible wrong number travels into a quote before anybody notices.
 *   • `listPriceUsd` is the base PLUS every mandatory surcharge. CH24-H43
 *     shares plain CH24's price key and is separated from it only by a
 *     mandatory `Height: LOW` charge — showing the bare base sells a $2,450
 *     chair for $2,305.
 *   • Stock is deliberately not projected. Carl Hansen is made to order: a zero
 *     in Odense means "wait 54 days", not "cannot sell".
 *
 * Pure projection: no React, no db, no network.
 */

import {
  parseSelectionTree,
  defaultSelection,
} from '../../brands/carl-hansen/selectionTree.js';
import {
  composePriceKey,
  resolveListPrice,
  priceListStateOf,
  priceListValidity,
  parseChDate,
} from '../../brands/carl-hansen/price.js';
import { swatchUrlFor, slugifyMaterial } from '../../brands/carl-hansen/swatches.js';
import { materialKindOf } from '../../brands/carl-hansen/materialKind.js';
import {
  buildCarlHansenLeadTimes,
  maxProductionDays,
  rowPriceUsd,
} from '../../brands/carl-hansen/productRows.js';
import { variantMatchContext, variantMatchesSelection } from '../../brands/carl-hansen/variantMatch.js';

const DAY_MS = 86_400_000;


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

/**
 * `"CH24 | Wishbone Chair"` → code + name. The pipe is the site's own
 * convention and the code half is what a dealer types into a search box, so
 * they are split ONCE, here, and never re-split at a render site.
 */
export function chModelName(productName) {
  const full = squish(productName);
  const at = full.indexOf('|');
  if (at < 0) return { code: '', name: full, fullName: full };
  return { code: squish(full.slice(0, at)), name: squish(full.slice(at + 1)), fullName: full };
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
export function chAxisKind(axis) {
  const declared = materialKindOf(`${str(axis?.label)} ${str(axis?.name)}`);
  if (declared) return declared;
  let level = arr(axis?.choices);
  while (level.length) {
    const next = [];
    for (const node of level) {
      if (!node?.children?.length) continue; // a branch, not a leaf
      const kind = materialKindOf(node.label);
      if (kind) return kind;
      next.push(...node.children);
    }
    level = next;
  }
  return null;
}

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

/** EVERY configuration's axes for a model — the sibling proof the matcher's
 *  unspoken-axis waiver needs (`variantMatchContext`). Cached per spec row:
 *  a master carries up to 29 trees and the configurator re-runs per click. */
const allAxesCache = new WeakMap();
function allModelAxes(spec, master) {
  if (!master) return [];
  const key = isObj(spec) ? spec : null;
  const hit = key ? allAxesCache.get(key) : null;
  if (hit) return hit;
  const all = parseSelectionTree(master);
  if (key) allAxesCache.set(key, all);
  return all;
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
 * ONE model's configurator, priced.
 *
 *   spec     — a `carl_hansen_specs` row (or the published model master).
 *   priceRow — the `carl_hansen_prices` row for VAT0-USD (or the published file).
 *   page     — the `carl_hansen_pages` row, for the matched variant + imagery.
 *   selection — partial; every unset axis takes the model's own default.
 *
 * Returns the axes with their options resolved (labels, swatches, add-on
 * surcharges, what is selected), the composed price key, the ex-VAT USD list
 * price, the surcharges, the price list's freshness, the matched EAN variant,
 * the imagery, and `unresolved` — every check as data.
 */
export function resolveCarlHansenConfigurator(spec, priceRow, page, {
  selection = null,
  now = Date.now(),
  configId = null,
  collectionSlugs = null,
  // PERF SEAMS FOR THE BULK WALK, defaults keep every existing caller intact.
  // `rawAxes` skips re-parsing the master (the bulk pass already parsed this
  // configuration's axes and calls this once PER COMBINATION — re-parsing a
  // ~200 KB master thousands of times was most of why «Importar todo» crawled);
  // `probeAddOns: false` skips the per-OPTION surcharge probes, which exist
  // only so the configurator UI can print "+$145" next to unselected options —
  // the plan itself prices the SELECTION through `resolveListPrice` regardless.
  rawAxes: prebuiltAxes = null,
  probeAddOns = true,
  // EVERY configuration's axes, for the matcher's sibling-aware waiver. The
  // bulk pass hands its own (it parsed each configuration once anyway);
  // otherwise they're derived here, cached per spec row.
  modelAxes: prebuiltModelAxes = null,
} = {}) {
  const master = isObj(spec)
    ? { selectionTrees: spec.selectionTrees ?? spec.selection_trees, configurations: spec.configurations }
    : null;
  const modelId = str(spec?.id || spec?.modelId);
  // A named configuration is parsed directly (a master carries up to 29 trees
  // and this re-runs on every click); otherwise parse all, then pick.
  const allAxes = Array.isArray(prebuiltAxes)
    ? prebuiltAxes
    : master ? parseSelectionTree(master, configId || undefined) : [];
  const modelAxes = Array.isArray(prebuiltModelAxes)
    ? prebuiltModelAxes
    : (!configId && !Array.isArray(prebuiltAxes)) ? allAxes : allModelAxes(spec, master);
  const cfg = pickConfigId(spec, allAxes, configId);
  const rawAxes = cfg ? allAxes.filter((a) => a.configId === cfg) : allAxes;

  const sel = { ...defaultSelection(rawAxes), ...normalizeSelection(rawAxes, selection) };
  const priceList = toPriceList(priceRow);
  const priceKey = composePriceKey(modelId, rawAxes, sel);
  const priced = resolveListPrice(priceList, priceKey.key, priceKey.altKeys, sel, rawAxes);
  const state = priceList ? priceListStateOf(priceList, now) : 'unknown';
  // THE PIECE'S list price, not the key's raw base: a MANDATORY surcharge is
  // part of the product (CH24-H43 shares plain CH24's price key and is only
  // $145 of `Height: LOW` away from it), while a declinable fitting is not.
  // The Model draws that line (`rowPriceUsd`) and refuses to price at all when
  // it can't — showing the bare base would under-bill by exactly the surcharge.
  const listPriceUsd = rowPriceUsd(priced, rawAxes);

  // Axes, enriched. The spread keeps every `ChAxis` field intact, so these
  // objects stay valid input for composePriceKey / buildCarlHansenProductRows —
  // there is no second, thinner axis shape to keep in sync.
  const axes = rawAxes.map((axis) => {
    const chains = leafChains(axis.choices);
    const selectedKey = sel[axis.id] ?? null;
    const options = chains.map((chain) => {
      const leaf = chain[chain.length - 1];
      const option = {
        key: leaf.key,
        label: leaf.label,
        fullLabel: leaf.fullLabel,
        description: leaf.description,
        priceCode: leaf.priceCode,
        // The nearest VISIBLE ancestor — "Canvas", "Loke", "FSC™-certified Oak"
        // — is how 32 upholstery leaves render as groups instead of a wall.
        groupLabel: squish([...chain.slice(0, -1)].reverse().find((n) => !n.hidden)?.label),
        swatch: swatchFor(chain, collectionSlugs),
        isDefault: leaf.isDefault,
        selected: leaf.key === selectedKey,
        addOnUsd: null,
        addOnKind: null,
      };
      return option;
    });

    // An add-on axis prices through `addOnPrices`, so each option carries its
    // own surcharge. It is read back out of `resolveListPrice` — the same code
    // path that prices the SELECTED one — rather than re-implemented here,
    // which is the only way the label and the money can't drift apart.
    if (!axis.isPriceAxis && priceList && probeAddOns) {
      for (const option of options) {
        const probe = resolveListPrice(priceList, '', [], { ...sel, [axis.id]: option.key }, rawAxes);
        const hit = probe.addOns.find((a) => a.axisId === axis.id) || null;
        option.addOnUsd = hit?.amount ?? null;
        // `identity` = the surcharge names a different product (it is already
        // inside `listPriceUsd`); `accessory` = a declinable extra.
        option.addOnKind = hit?.kind ?? null;
      }
    }

    return {
      ...axis,
      kind: chAxisKind(axis),
      isAddOnAxis: !axis.isPriceAxis,
      selectedKey,
      selected: options.find((o) => o.selected) || null,
      options,
    };
  });

  // The variant (EAN, lead time, renders) this configuration IS.
  const pageData = toPageData(page);
  const configurations = Array.isArray(spec?.configurations) ? spec.configurations : null;
  const matches = matchingVariants(pageData, rawAxes, sel, modelAxes, { configurations, configId: cfg });
  const variant = matches[0] ? toVariant(matches[0]) : null;
  const images = variant?.images?.length ? variant.images : toImages(page?.media);
  // Lead time is the made-to-order answer to "when do I get it" — built by the
  // Model over the SAME (spec, page, selection) that builds the rows, so a
  // promised date can never belong to a piece the import doesn't cover.
  const leadTimes = buildCarlHansenLeadTimes(
    { modelId, axes: rawAxes, modelAxes, configurations, configId: cfg },
    pageData,
    sel,
  );

  const unresolved = configuratorIssues({
    spec, page, pageData, priceList, priceKey, priced, listPriceUsd, state, matches, modelId, axes: rawAxes,
  });

  return {
    modelId: modelId || null,
    configId: cfg || null,
    modelName: squish(spec?.friendlyName) || chModelName(page?.name).name,
    axes,
    /** Every configuration's axes — input for the matcher's sibling-aware
     *  waiver; the import plan hands it on to the row builder. */
    modelAxes,
    selection: sel,
    priceKey,
    /** What the product row carries: base + every MANDATORY surcharge. */
    listPriceUsd,
    /** The price key's raw base, for the audit trail — never a display figure
     *  on its own, or an H43 chair reads $145 cheap. */
    basePriceUsd: priced.priceUsd,
    addOns: priced.addOns,
    /** …plus the declinable extras the dealer ticked (felt gliders). */
    totalUsd: priced.totalUsd,
    /** The Model's RAW answer. Pass it to `buildCarlHansenProductRows`
     *  verbatim — reassembling one from `listPriceUsd` re-adds every mandatory
     *  surcharge a second time (a $2,450 chair priced $2,595). */
    priced,
    matchedKey: priced.matchedKey,
    matched: priced.matched,
    priceState: state,
    priceValidFrom: priceListValidity(priceList).validFrom,
    priceValidTo: priceListValidity(priceList).validTo,
    currency: priceList?.currency || 'USD',
    variant,
    variantMatches: matches.length,
    leadTimes,
    leadTimeDays: maxProductionDays(leadTimes),
    images,
    unresolved,
    ready: !unresolved.some((i) => i.level === 'blocker'),
  };
}

/** Variants of the page that ARE this selection — the Model's own gate
 *  (`variantMatchesSelection`: the visible LABEL CHAIN, never a fuzzy string),
 *  so what the configurator shows and what the import mints can't disagree.
 *  The page context rides along so the unspoken-axis waiver and the
 *  configuration claim gate apply HERE exactly as they do in the row builder
 *  — one gate, two callers. */
function matchingVariants(pageData, axes, selection, modelAxes = null, config = null) {
  const context = variantMatchContext(pageData, axes, modelAxes, config);
  return arr(pageData?.Variants)
    .filter((v) => squish(v?.Sku) && variantMatchesSelection(v, axes, selection, context));
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