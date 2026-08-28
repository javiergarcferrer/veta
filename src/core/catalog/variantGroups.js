/**
 * VARIANT GROUPS — the catalog as MODELS with layers under them, not as a flat
 * cross-product of every configuration.
 *
 * ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
 * An imported Carl Hansen or Fredericia catalog is one row per buyable
 * configuration, and that is correct: each has its own EAN/SKU and its own
 * price. But it is not how anybody SHOPS. The browser showed:
 *
 *   Klint Armchair · Oak Oiled · Natural Paper Cord     Klint Armchair
 *   Klint Armchair · Oak Soap  · Natural Paper Cord     Klint Armchair
 *
 * — two rows, one chair, and the dealer reading them has to diff two strings
 * to find the one word that moved. The Wishbone is 41 such rows; the Fredericia
 * Spine is 66. A picker built this way asks a person to do set arithmetic.
 *
 * This resolver collapses them: ONE entry per model, carrying the LAYERS its
 * variants differ along (`lib/variantFacets`) and the price range they span.
 * The variants are still there, under it, for the moment a concrete SKU is
 * needed.
 *
 * ── THE GROUPING KEY, AND WHY IT IS `family` ────────────────────────────────
 * Both importers already write the model's own name into `family`:
 *   • Carl Hansen — `spec.friendlyName || page.ProductName` ("Klint Armchair").
 *   • Fredericia  — the store's product TITLE ("Spine Barstool (w/ Back)").
 * That is the manufacturer's own answer to "what is this piece called", so it
 * is the honest key. `familyCode` (the model number) joins it when present, so
 * two genuinely different pieces that happen to share a title do not merge —
 * but a MISSING code never splits a model, because most rows in one family
 * carry the same code and a blank is absence of data, not a distinction.
 *
 * ── WHY THE CONFIGURATION IS READ OFF `name`, NOT `subtype` ─────────────────
 * `subtype` means different things in the two catalogs: for Carl Hansen it is
 * the configuration text, for Fredericia it is the GRADE ("Grade FG3") — a
 * price ladder that `lib/catalog groupFamilies` already models and that must
 * NOT be flattened into the finish layers. `name`, by contrast, is written the
 * same way by both importers: the model, then its non-material options, joined.
 * So the configuration is `name` with the `family` prefix removed, and the
 * grade travels separately in `grades`.
 *
 * A row whose name does NOT start with its family keeps its whole name as the
 * configuration. That is the honest fallback: a hand-edited row is still shown,
 * under its model, with whatever it says.
 *
 * Pure ViewModel: no React, no db.
 */

import { facetLayers, splitConfiguration } from '../../lib/variantFacets.js';
import { parseSubtype } from '../../lib/subtype.js';

const str = (v) => String(v ?? '').trim();
/** A real number, or null. `Number(null)` is 0 and `Number('')` is 0 — both
 *  FINITE — so a blank price would otherwise enter a model's range as a $0
 *  floor and the browser would advertise a free chair. Absence is checked
 *  before the cast, never after. */
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** How far into a name the family may start and still be the family — long
 *  enough for `CH24 | `, `BM1106 | ` or `MG501-PAPERCORD | `, short enough that
 *  a repeat of the family word deep in a configuration is not mistaken for it. */
const LEAD_MAX = 24;

/** Fold a grouping key: case- and space-insensitive, so a re-keyed row joins
 *  its own model instead of opening a second one. */
const keyOf = (family, familyCode) =>
  `${str(family).toLowerCase().replace(/\s+/g, ' ')}|${str(familyCode).toLowerCase()}`;

/**
 * The configuration text of one row — what it chose, without repeating what it
 * IS. `name` minus the `family` prefix, with the joining separator eaten.
 *
 *   family 'Klint Armchair'
 *   name   'Klint Armchair · Oak Oiled · Natural Paper Cord'
 *   →      'Oak Oiled · Natural Paper Cord'
 */
export function configurationOf(row) {
  const name = str(row?.name);
  const family = str(row?.family);
  if (!name || !family) return name;
  // THE FAMILY DOES NOT ALWAYS START THE NAME. Fredericia writes
  // `Spanish Chair · Oak Oiled · Natural Saddle`, but Carl Hansen puts the
  // model code first: `CH24 | Wishbone Chair · oak, oil, natural paper cord`.
  // Requiring a prefix match made every Carl Hansen row report its WHOLE name
  // as the configuration, so `CH24` and `Wishbone Chair` were offered as if
  // they were choices the dealer could make.
  //
  // Found anywhere in the LEADING part of the name, then: a code plus a
  // separator is a handful of characters, and bounding it is what stops a
  // family word that recurs inside the configuration ("Chair" in "Chair Base")
  // from eating the real answer.
  const at = name.toLowerCase().indexOf(family.toLowerCase());
  if (at < 0 || at > LEAD_MAX) return name;
  return name.slice(at + family.length).replace(/^\s*[·,\-–—/|]\s*/, '').trim();
}

/**
 * Catalog rows → model groups.
 *
 * Groups come back in the order their first row appeared, which for a
 * category-ordered read is the supplier's own merchandising order. Within a
 * group the variants keep their read order too — an importer writes them in
 * the order the manufacturer published them, and re-sorting by price would put
 * a stripped-down configuration ahead of the piece people actually buy.
 *
 * @param products catalog rows (`products` shape; only name/family/
 *                 familyCode/reference/subtype/priceUsd/category/imageSrc read)
 * @returns [{ key, model, familyCode, brand, category, count, priceMin,
 *             priceMax, layers, grades, imageSrc, variants }]
 */
export function resolveVariantGroups(products) {
  const groups = new Map();

  for (const row of products || []) {
    const family = str(row?.family) || str(row?.name);
    if (!family && !str(row?.reference)) continue;
    const familyCode = str(row?.familyCode);
    const key = keyOf(family, familyCode);

    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        model: family,
        familyCode,
        brand: str(row?.brand),
        category: str(row?.category),
        count: 0,
        priceMin: null,
        priceMax: null,
        imageSrc: '',
        /** Every configuration string in the group — the input to the layers. */
        _configs: [],
        /** Distinct grade rungs, first-seen order (Fredericia's ladder). */
        grades: [],
        variants: [],
      };
      groups.set(key, g);
    }

    const configuration = configurationOf(row);
    const price = num(row?.priceUsd);
    // The grade is the price LADDER, not a finish — it never enters the layers.
    const grade = str(parseSubtype(str(row?.subtype)).grade);

    g.count += 1;
    g._configs.push(configuration);
    if (!g.category) g.category = str(row?.category);
    if (!g.brand) g.brand = str(row?.brand);
    if (!g.imageSrc) g.imageSrc = str(row?.imageSrc);
    if (grade && !g.grades.includes(grade)) g.grades.push(grade);
    if (price != null) {
      g.priceMin = g.priceMin == null ? price : Math.min(g.priceMin, price);
      g.priceMax = g.priceMax == null ? price : Math.max(g.priceMax, price);
    }
    g.variants.push({
      reference: str(row?.reference),
      configuration,
      grade,
      priceUsd: price,
      imageSrc: str(row?.imageSrc),
      /** The tokens of THIS variant, so a row can render its own chips. */
      tokens: splitConfiguration(configuration),
    });
  }

  const out = [];
  for (const g of groups.values()) {
    const { _configs, ...rest } = g;
    out.push({ ...rest, layers: facetLayers(_configs) });
  }
  return out;
}

/**
 * A one-line human summary of what a model varies in — for the collapsed row.
 *
 *   'Madera: Oak Oiled · Oak Soap   ·   Asiento: Natural Paper Cord'
 *
 * Only layers that actually VARY are named (`values.length > 1`); a layer every
 * variant shares is not a choice and saying so is noise on a list. When nothing
 * varies — a model with one configuration — the answer is '' and the caller
 * shows the configuration itself.
 */
export function variesIn(group, { max = 3 } = {}) {
  const varying = (group?.layers || []).filter((l) => l.values.length > 1);
  if (!varying.length) return '';
  return varying
    .slice(0, max)
    .map((l) => `${l.facet.label}: ${l.values.slice(0, 4).join(' · ')}`)
    .join('   ·   ');
}

/**
 * The same collapse, one level up: `CatalogFamily[]` → model groups.
 *
 * `lib/catalog groupFamilies` turns SKU rows into FAMILIES by SKU root. For
 * Ligne Roset that already IS the model (an 8-digit root with its grade
 * ladder). For the two imported houses it is not:
 *
 *   • Carl Hansen prices per EAN and has no grade ladder, so every variant
 *     becomes its own single-member family — the 41 Wishbone rows the picker
 *     was listing side by side.
 *   • Fredericia's root carries the frame and height, so one Spine Barstool is
 *     several roots, each with its own ladder.
 *
 * Both are collapsed here by the model's own name (`family`) + `familyCode`,
 * the same key `resolveVariantGroups` uses. The member families are kept
 * INTACT underneath, so whatever the caller does with one — pick it, price it,
 * read its grades — is unchanged. This only decides what a person sees first.
 *
 * NOT for Ligne Roset, and the caller must not apply it there: an LR
 * `products.family` is a RANGE ("TOGO"), not a model, so grouping by it would
 * merge the Togo sofa with the Togo armchair — different pieces at different
 * prices. The two imported catalogs write the model's own name into `family`;
 * Ligne Roset writes something else, and that difference is the whole reason
 * this is opt-in rather than applied in `groupFamilies`.
 */
export function groupModelFamilies(families) {
  const groups = new Map();

  for (const fam of families || []) {
    const label = str(fam?.family) || str(fam?.name);
    const sample = fam?.byGrade ? [...fam.byGrade.values()][0] : null;
    const familyCode = str(sample?.familyCode);
    const key = keyOf(label || str(fam?.root), familyCode);

    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        model: label || str(fam?.root),
        familyCode,
        priceMin: null,
        priceMax: null,
        count: 0,
        _configs: [],
        grades: [],
        families: [],
      };
      groups.set(key, g);
    }

    g.families.push(fam);
    g.count += 1;
    for (const p of fam?.byGrade ? fam.byGrade.values() : []) {
      const price = num(p?.priceUsd);
      if (price != null) {
        g.priceMin = g.priceMin == null ? price : Math.min(g.priceMin, price);
        g.priceMax = g.priceMax == null ? price : Math.max(g.priceMax, price);
      }
      const cfg = configurationOf(p);
      if (cfg) g._configs.push(cfg);
    }
    for (const grade of fam?.grades || []) {
      if (grade && !g.grades.includes(grade)) g.grades.push(grade);
    }
  }

  const out = [];
  for (const g of groups.values()) {
    const { _configs, ...rest } = g;
    out.push({ ...rest, layers: facetLayers(_configs) });
  }
  return out;
}
