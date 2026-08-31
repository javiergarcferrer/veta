/**
 * Carl Hansen & Søn — product page variants → `products` rows.
 *
 * The catalog row a dealer quotes is a VARIANT: one EAN, one configuration,
 * one photo set, one stock figure. Those live on the product page's embedded
 * `__NEXT_DATA__` (`pageProps.pageData.Variants`), never in the blob — while
 * the price lives only in the blob. This module joins the two.
 *
 * ── THE MONEY RULE (owner-confirmed, 2026-08-06) ─────────────────────────────
 * This importer writes LIST PRICE ONLY. **`cost` is never set — the key is not
 * even written.** No margin, no placeholder, no derivation from price. Cost
 * arrives later from the landed-cost engine when the expediente is posted.
 * Precedent: the LSG `costInUsd` incident (CLAUDE.md) — a fabricated cost
 * poisoned every margin downstream and nobody saw it for weeks. Null reads as
 * "sin costo" and is recoverable. The absence of the key is pinned in
 * `tests/carlHansen.test.js`; do not "helpfully" add one.
 *
 * The page's own `Price` / `ListedPrice` fields are 0 on the international
 * market and are IGNORED outright (spec §3) — reading them would write a
 * catalog full of free chairs.
 *
 * ── AND `Stock` IS NOT WRITTEN EITHER ────────────────────────────────────────
 * Carl Hansen is a MADE-TO-ORDER Danish import: `Stock: 0` in Odense means
 * "wait 54 days", not "cannot sell". But writing `stockQty` is what makes a
 * product TRACKED (`lib/catalog` — `tracked = stockQty != null`), and a tracked
 * product with qty ≤ 0 is hard-refused by the quote builder (`isOutOfStock` at
 * CatalogPicker/InventoryPicker, and dropped outright by
 * `core/crm/views/productPicker`). Measured on the CH24 fixture: 17 of 41
 * variants report Stock ≤ 0 — 41% of the flagship Wishbone Chair, every one of
 * them with a real lead time — so mirroring the warehouse count would silently
 * make nearly half the range unquotable.
 *
 * So the key is ABSENT and the row is untracked, exactly like Ligne Roset's
 * special-order goods ("a TRACKED product with qty ≤ 0 is unquotable;
 * untracked LR is never gated", CLAUDE.md). What the dealer actually needs to
 * answer — *when does it arrive* — is `ProductionDays`, and that is served by
 * `buildCarlHansenLeadTimes` alongside the rows, because `products` has no
 * column for it and this package does not get to add one.
 *
 * ── WHICH VARIANTS BELONG TO A SELECTION ─────────────────────────────────────
 * One product page serves several CONFIGURATIONS (CH24 also hosts
 * CH24-CHSColors' painted frames), and each configuration prices differently.
 * A variant is matched to a selection by the LABEL CHAIN of the selected
 * choices: "Oil" alone is oak, walnut and beech, so the visible ancestors
 * ("FSC™-certified Oak") must match too. Measured over the 41 CH24 variants ×
 * 24 CH24 combos × 22 CH24-CHSColors combos: never once ambiguous — a variant
 * matches at most one combination. That non-ambiguity is the safety property;
 * coverage is deliberately partial, because a variant whose configuration we
 * cannot place must NOT inherit somebody else's price.
 *
 * ── …AND THE CHAIN IS COMPARED CANONICALLY, NOT LITERALLY ────────────────────
 * The first cut compared the label chain to the variant's configuration text
 * with plain lowercase equality, and MEASURED that way only 25 of CH24's 41
 * published EANs were reachable from ANY of the model's nine configurations.
 * The whole 16-EAN gap was one systematic spelling difference: under the hidden
 * group `CHS Soft Colors` the tree names the leaf `Blue`, and the page prints
 * `Soft Blue`. Every painted-beech Wishbone on the flagship page — a third of
 * the range — was therefore unimportable.
 *
 * The repair is `canonicalLabel` + a QUALIFIER rule, and both are deliberately
 * EXACT: fold case/diacritics/punctuation, canonicalise an explicit alias table
 * of observed abbreviations, drop a collection's version digit, and let a label
 * be prefixed by ONE word that the node's own HIDDEN ancestors publish. There
 * is no edit distance, no similarity score and no "closest match" anywhere —
 * a fuzzy matcher does not import the missing chair, it imports the WRONG one,
 * and at Carl Hansen's prices two adjacent finishes are $500 apart. Every
 * accepted spelling is generated from the model master's own published text,
 * so an alias can only ever unify two spellings of the SAME node.
 *
 * Residual gap and non-ambiguity are both pinned as numbers in
 * `tests/carlHansen.test.js`; raise the matcher's reach only by measuring again.
 *
 * So: rows are built per selection. Sweeping a model = calling this once per
 * combination and merging on `id`. An empty selection matches everything and
 * yields unpriced rows — the no-vanish sweep, for getting every EAN into the
 * catalog before the prices are worked out.
 *
 * Pure module — no React, no fetch, no DB.
 */
import type { Product } from '../../types/domain';
import type { ChAxis } from './selectionTree.js';
import { selectedChoice, chainFor } from './selectionTree.js';
import type { ChResolvedPrice } from './price.js';

/** Brand id for Carl Hansen rows. Mirrors the registry in `lib/constants`
 *  (`BRAND_*`); kept literal here so this Model stays dependency-free. */
export const CARL_HANSEN_BRAND = 'carl-hansen';

/** One `pageData.Variants[]` entry, narrowed to what a catalog row needs. */
export interface ChPageVariant {
  /** EAN/GTIN-13 — the catalog reference. */
  Sku?: string;
  Configuration?: string[];
  ConfigurationDictionary?: Record<string, string>;
  FormattedConfiguration?: string;
  Images?: Array<{ Url?: string }>;
  Stock?: number;
  ProductionDays?: number;
  PageUrl?: string;
}

/** `props.pageProps.pageData` of a product page. */
export interface ChPageData {
  ProductName?: string;
  ProductId?: string;
  Breadcrumb?: Array<{ Title?: string }>;
  Variants?: ChPageVariant[];
}

/** The model master side of the join. */
export interface ChModelSpec {
  /** PIM model id, e.g. `CH24`. */
  modelId: string;
  /** Configuration the axes belong to, e.g. `CH24` / `CH24-CHSColors`. */
  configId?: string | null;
  /** `friendlyName` from the model master, e.g. `Wishbone Chair`. */
  friendlyName?: string | null;
  axes: ChAxis[];
}

export interface ChRowContext {
  profileId: string;
  /** Stamp for `updatedAt`; defaults to now. */
  now?: number;
  /** Defaults to `CARL_HANSEN_BRAND`. */
  brand?: string;
  /** Defaults to true. */
  active?: boolean;
}

/* --------------------------------- helpers -------------------------------- */

const squish = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/* --------------------------- canonical label form -------------------------- */

/**
 * Observed spelling differences between the configurator tree and the product
 * page, as an EXPLICIT table: a folded word run → its canonical word run.
 * Rewriting BOTH sides means either spelling lands on the same string, so the
 * table never has to know which source it is reading.
 *
 * This list is short on purpose. It is not a place to make a stubborn match
 * work — an entry belongs here only when the two spellings are documented
 * names of the SAME thing, and each one carries a case in
 * `tests/carlHansen.test.js` so it cannot rot unnoticed.
 */
const LABEL_ALIASES: ReadonlyArray<readonly [readonly string[], string]> = [
  // Kvadrat collections the tree abbreviates and the page spells out.
  [['dm'], 'divina melange'],
  [['hall', 'dal'], 'hallingdal'],   // the page prints "Hall.dal" → folded "hall dal"
  [['re', 'wool'], 'rewool'],        // the tree hyphenates "Re-wool", the page doesn't
  // THE CERTIFICATION GOT RE-WORDED ON ONE SIDE ONLY, and it is live right now:
  // the blob master still says "FSC™-certified Oak" while the product page now
  // prints "FSC™ Mix-certified oak". With the two sides disagreeing, EVERY CH24
  // configuration matches zero variants — so the importer mints no rows for the
  // Wishbone Chair at all, and the configurator shows no EAN and no lead time
  // on a chair that is in stock.
  //
  // The fix is an alias and NOT a strip of the whole marker, which was the
  // first idea and is wrong: `FSC™-certified Oak` and `Oak FSC-70` are two
  // DIFFERENT leaves of the same axis (two certification chains, two prices),
  // and deleting "FSC…certified" would fold them into one and attach the wrong
  // EAN. Collapsing the one word that moved keeps them apart.
  [['fsc', 'mix'], 'fsc'],
];

/** Nordic letters NFD does NOT decompose — they are letters in their own right,
 *  not a base plus a mark. `å` decomposes and `ø` does not, so on a Danish
 *  manufacturer's catalogue the fold silently ATE the letter: "Søn" became
 *  "s n". Mapped explicitly instead. */
const LETTER_FOLD: Record<string, string> = {
  ø: 'o', æ: 'ae', œ: 'oe', ð: 'd', þ: 'th', ß: 'ss', ł: 'l', đ: 'd', ħ: 'h',
};

/**
 * Fold a published label to the form both sides are compared in: diacritics
 * decomposed away, trademark glyphs and punctuation reduced to spaces, case
 * dropped, runs collapsed ("FSC™-certified Oak" → "fsc certified oak").
 *
 * Same discipline as `foldSearchText` in `lib/productSearch`: fold both sides
 * with the SAME function or the comparison silently stops matching.
 */
function fold(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[øæœðþßłđħ]/g, (c) => LETTER_FOLD[c] || c)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Folded words of a label, empties dropped. */
function foldWords(v: unknown): string[] {
  const s = fold(v);
  return s ? s.split(' ') : [];
}

/** Rewrite every alias run in place. Longest table entries are few and short,
 *  so a linear scan is the whole algorithm. */
function applyAliases(words: string[]): string[] {
  let out = words;
  for (const [from, to] of LABEL_ALIASES) {
    if (!out.some((w) => w === from[0])) continue;
    const next: string[] = [];
    for (let i = 0; i < out.length; i += 1) {
      const hit = from.every((w, k) => out[i + k] === w);
      if (hit) { next.push(...to.split(' ')); i += from.length - 1; } else next.push(out[i]);
    }
    out = next;
  }
  return out;
}

/**
 * The comparable form of one label.
 *
 * Three normalisations on top of the fold, each justified by published data:
 *
 *  - a trailing `designed by …` credit is dropped. The tree names an Ilse
 *    Crawford colour `Soft Slate designed by Ilse Crawford`; the page prints
 *    the colour alone.
 *  - the alias table above.
 *  - a collection's VERSION digit is dropped ("Canvas" vs "Canvas 2", "Remix"
 *    vs "Remix 3", "Fiord" vs "Fiord 2"). Only a standalone single digit, and
 *    only when it is not the last word: a colourway code is never one digit
 *    (0224, 310, 20368) so two colourways can never fold together, and a
 *    genuinely numbered leaf ("Model 1" vs "Model 2") keeps its digit because
 *    there the digit IS the last word.
 */
export function canonicalLabel(v: unknown): string {
  const stripped = fold(v).replace(/\bdesigned by\b.*$/, '').trim();
  const words = applyAliases(stripped ? stripped.split(' ') : []);
  const kept = words.filter((w, i) => !(i < words.length - 1 && /^[1-9]$/.test(w)));
  return kept.join(' ');
}

/** The configuration phrases a variant advertises, canonicalised — both the
 *  flat array and the typed dictionary (whose values pack several axes:
 *  "FSC™-certified oak, oil"). */
function variantTokens(variant: ChPageVariant): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => { const t = canonicalLabel(v); if (t) out.add(t); };
  for (const c of variant.Configuration || []) add(c);
  for (const value of Object.values(variant.ConfigurationDictionary || {})) {
    for (const part of String(value ?? '').split(',')) add(part);
  }
  return out;
}

/* ------------------------------ label matching ----------------------------- */

/** One label a variant has to advertise, with the spellings the model master
 *  itself says the page may use for it. */
interface ChLabelMatcher {
  /** Canonical label of a VISIBLE node on the selected chain. */
  label: string;
  /** Single words the page may prefix the label with, taken from the HIDDEN
   *  ancestors ABOVE this node — nothing else is ever accepted. */
  qualifiers: string[];
}

/**
 * What a variant must advertise to count as this selection: every VISIBLE node
 * on the chain down to each selected choice, for the price axes only. Hidden
 * structural nodes (`Wood`, `Oak FSC-70`) never appear in a variant's
 * configuration text, and add-on axes (gliders, height) aren't part of a
 * variant at all.
 *
 * ── THE QUALIFIER RULE ───────────────────────────────────────────────────────
 * A hidden ancestor is invisible in the CONFIGURATOR, not necessarily in the
 * page's prose: under `CHS Soft Colors` the leaf is `Blue` and the page prints
 * `Soft Blue`. So a label also matches when the page spells it with ONE extra
 * leading word that one of its own hidden ancestors publishes — `soft` here
 * comes from the group's own name, never from a hardcoded vocabulary.
 *
 * It stays exactly one word, and only from ancestors ABOVE the node, because
 * that is the narrowest rule that closes the measured gap. Widening it is how
 * `Green` starts claiming `Soft Olive Green` — a different chair at a
 * different price. (With the rule as written, `Green` needs the qualifier
 * `olive`, which no ancestor publishes, so it correctly matches nothing.)
 */
function requiredMatchers(axes: ChAxis[], selection: Record<string, string>): ChLabelMatcher[] {
  const out: ChLabelMatcher[] = [];
  for (const axis of axes || []) {
    if (!axis.isPriceAxis) continue;
    const choice = selectedChoice(axis, selection);
    if (!choice) continue;
    const chain = chainFor(axis, choice.key) || [];
    const qualifiers: string[] = [];
    for (const node of chain) {
      if (node.hidden) {
        // Accumulated BEFORE the visible nodes below it are emitted, so a
        // qualifier can only ever come from an ancestor.
        for (const w of foldWords(node.label)) if (!qualifiers.includes(w)) qualifiers.push(w);
        continue;
      }
      const label = canonicalLabel(node.label);
      if (label) out.push({ label, qualifiers: [...qualifiers] });
    }
  }
  return out;
}

/**
 * The canonical labels of `selection` — the debugging/diagnostic view of
 * `requiredMatchers`, kept because the audit surfaces quote it when they
 * explain why a variant was not claimed.
 */
export function requiredLabels(axes: ChAxis[], selection: Record<string, string>): string[] {
  return requiredMatchers(axes, selection).map((m) => m.label);
}

/** True when the variant advertises every required label. An EMPTY
 *  requirement set matches everything (the unpriced sweep). */
export function variantMatchesSelection(
  variant: ChPageVariant,
  axes: ChAxis[],
  selection: Record<string, string>,
): boolean {
  const required = requiredMatchers(axes, selection);
  if (!required.length) return true;
  const tokens = variantTokens(variant);
  return required.every(
    (m) => tokens.has(m.label) || m.qualifiers.some((q) => tokens.has(`${q} ${m.label}`)),
  );
}

/**
 * The variants of `page` that belong to `selection`, deduped by EAN.
 *
 * ONE definition, shared by the row builder and the lead-time builder, so the
 * two can never disagree about which pieces the plan covers — a lead time
 * quoted for a piece that isn't in the import would be worse than none.
 */
function matchingVariants(
  page: ChPageData | null | undefined,
  axes: ChAxis[],
  selection: Record<string, string>,
): Array<{ reference: string; variant: ChPageVariant }> {
  const out: Array<{ reference: string; variant: ChPageVariant }> = [];
  const seen = new Set<string>();
  for (const variant of page?.Variants || []) {
    const reference = squish(variant?.Sku);
    if (!reference || seen.has(reference)) continue;
    if (!variantMatchesSelection(variant, axes, selection)) continue;
    seen.add(reference);
    out.push({ reference, variant });
  }
  return out;
}

/* ------------------------------- the builder ------------------------------- */

/**
 * What one variant of this configuration costs: the base, plus the add-ons
 * that are part of the product rather than bolted onto it.
 *
 * Returns null — no price at all — whenever anything is unclear: no base, an
 * add-on of unknown kind, or an add-on whose axis isn't in this spec (which
 * means `priced` and `spec` were computed from different axis sets and nothing
 * here can be trusted). Refusing to price is the safe answer; emitting the
 * bare base while a mandatory surcharge is selected is an under-bill.
 */
export function rowPriceUsd(
  priced: ChResolvedPrice | null | undefined,
  axes: ChAxis[],
): number | null {
  const base = priced?.priceUsd ?? null;
  if (base == null) return null;

  const known = new Set((axes || []).map((a) => a.id));
  let total = base;
  for (const addOn of priced?.addOns || []) {
    if (!addOn || !known.has(addOn.axisId)) return null;
    if (addOn.kind === 'accessory') continue;
    if (addOn.kind !== 'identity') return null;
    if (!Number.isFinite(addOn.amount)) return null;
    total += addOn.amount;
  }
  return total > 0 ? total : null;
}

/**
 * Build catalog rows for the variants of `page` that match `selection`.
 *
 * `priced` is what `resolveListPrice` answered for that selection. The row's
 * price is its BASE plus every IDENTITY add-on:
 *
 *  - accessory add-ons (felt gliders) are excluded — the EAN is the same chair
 *    with or without them, and the dealer adds the fitting on the quote line;
 *  - identity add-ons ARE included, because they name a different product.
 *    CH24-H43 shares plain CH24's `priceString` and is separated from it ONLY
 *    by a mandatory `Height: LOW` surcharge; writing the base alone would sell
 *    a $2,450 chair for $2,305.
 *
 * If ANY selected add-on can't be classified — or belongs to an axis this spec
 * doesn't even carry — the row gets NO price rather than a base that might be
 * $145 short. A null is recoverable; an under-billed product is not.
 */
export function buildCarlHansenProductRows(
  spec: ChModelSpec,
  page: ChPageData | null | undefined,
  priced: ChResolvedPrice | null | undefined,
  selection: Record<string, string>,
  ctx: ChRowContext,
): Product[] {
  const axes = spec?.axes || [];
  const sel = selection || {};
  const now = ctx?.now ?? Date.now();
  const brand = ctx?.brand || CARL_HANSEN_BRAND;
  const active = ctx?.active !== false;

  const productName = squish(page?.ProductName);
  const crumbs = page?.Breadcrumb || [];
  const category = squish(crumbs[crumbs.length - 1]?.Title);
  const family = squish(spec?.friendlyName) || productName;
  const familyCode = squish(spec?.modelId);
  const priceUsd = rowPriceUsd(priced, axes);

  const rows: Product[] = [];

  for (const { reference, variant } of matchingVariants(page, axes, sel)) {
    const config = squish(variant.FormattedConfiguration);
    const gallery = (variant.Images || [])
      .map((img) => squish(img?.Url))
      .filter((url) => !!url);

    const row: Product = {
      id: `ch-${reference}`,
      profileId: ctx.profileId,
      brand,
      reference,
      // The variant axis is part of what the dealer quotes, so it joins the
      // name; `subtype` carries it alone (the catalog's "Description 2").
      name: config ? `${productName} · ${config}` : productName,
      subtype: config,
      family,
      familyCode,
      category,
      // `stockQty` IS DELIBERATELY ABSENT — see the module header. A Danish
      // warehouse count is not a Santo Domingo sales gate.
      imageSrc: gallery[0] || '',
      imageSrcs: gallery,
      active,
      updatedAt: now,
    };
    // Only ever written when a key actually matched a published price.
    if (priceUsd != null) row.priceUsd = priceUsd;
    // `cost` IS DELIBERATELY ABSENT — see the module header.
    rows.push(row);
  }
  return rows;
}

/* -------------------------------- lead times -------------------------------- */

/** Manufacturing lead time for one variant of an import plan. */
export interface ChLeadTime {
  /** EAN — the row's `reference` (its id is `ch-<reference>`), so the UI and
   *  the audit row join these to the rows without a second match pass. */
  reference: string;
  /** Days from order to dispatch, as published. Null when the page is silent —
   *  never 0, which would read as "ships today". */
  productionDays: number | null;
  /** What the dealer sees next to it. */
  label: string;
}

/**
 * Lead times for exactly the variants `buildCarlHansenProductRows` returns for
 * the same `(spec, page, selection)`.
 *
 * This rides ALONGSIDE the rows rather than on them: `products` has no lead-time
 * column, and adding one is a shared-table change this package doesn't own. It
 * is the field that answers the question `Stock` was misleadingly answering —
 * for a made-to-order import, "73 días" is the truth, "0 disponibles" is not.
 */
export function buildCarlHansenLeadTimes(
  spec: ChModelSpec,
  page: ChPageData | null | undefined,
  selection: Record<string, string>,
): ChLeadTime[] {
  const axes = spec?.axes || [];
  return matchingVariants(page, axes, selection || {}).map(({ reference, variant }) => {
    const days = intOrNull(variant.ProductionDays);
    return {
      reference,
      productionDays: days != null && days > 0 ? days : null,
      label: squish(variant.FormattedConfiguration),
    };
  });
}

/** The slowest piece in a plan — what the dealer can honestly promise for the
 *  whole order. Null when nothing published a lead time. */
export function maxProductionDays(leadTimes: ChLeadTime[] | null | undefined): number | null {
  let max: number | null = null;
  for (const lt of leadTimes || []) {
    if (lt?.productionDays == null) continue;
    if (max == null || lt.productionDays > max) max = lt.productionDays;
  }
  return max;
}
