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
 * That whole question — the canonical label form, the qualifier rule, the
 * fused-chain rule, the unspoken-axis waiver, the configuration claim gate,
 * and the inverse resolver — lives in `variantMatch.ts`, one module over. This
 * file consumes ONE gate (`matchingVariants` below) and never re-derives any
 * of it: matching decides WHAT a variant is; the builders here decide what a
 * ROW says. The shared safety property is pinned in tests/carlHansen.test.js —
 * a variant whose configuration we cannot place must NOT inherit somebody
 * else's price — and its coverage is raised only by measuring again.
 *
 * Rows are built per selection; an empty selection matches everything and
 * yields unpriced rows — the no-vanish sweep, for getting every EAN into the
 * catalog before the prices are worked out.
 *
 * Pure module — no React, no fetch, no DB.
 */
import type { Product } from '../../types/domain';
import type { ChAxis } from './selectionTree.js';
import type { ChPageVariant, ChPageData } from './variantMatch.js';
import { variantMatchContext, variantMatchesSelection } from './variantMatch.js';
import type { ChResolvedPrice } from './price.js';

/** Brand id for Carl Hansen rows. Mirrors the registry in `lib/constants`
 *  (`BRAND_*`); kept literal here so this Model stays dependency-free. */
export const CARL_HANSEN_BRAND = 'carl-hansen';

/** The model master side of the join. */
export interface ChModelSpec {
  /** PIM model id, e.g. `CH24`. */
  modelId: string;
  /** Configuration the axes belong to, e.g. `CH24` / `CH24-CHSColors`. */
  configId?: string | null;
  /** `friendlyName` from the model master, e.g. `Wishbone Chair`. */
  friendlyName?: string | null;
  axes: ChAxis[];
  /** EVERY configuration's axes — the sibling proof the unspoken-axis waiver
   *  needs (see `variantMatchContext`). Absent ⇒ no axis is ever waived. */
  modelAxes?: ChAxis[] | null;
  /** The master's `configurations` array, verbatim — the claim gate reads
   *  each configuration's `nameInUrl`. Absent ⇒ no claim gate. */
  configurations?: unknown[] | null;
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
  modelAxes: ChAxis[] | null = null,
  config: { configurations?: unknown[] | null; configId?: string | null } | null = null,
): Array<{ reference: string; variant: ChPageVariant }> {
  const out: Array<{ reference: string; variant: ChPageVariant }> = [];
  const seen = new Set<string>();
  const context = variantMatchContext(page, axes, modelAxes, config);
  for (const variant of page?.Variants || []) {
    const reference = squish(variant?.Sku);
    if (!reference || seen.has(reference)) continue;
    if (!variantMatchesSelection(variant, axes, selection, context)) continue;
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

  for (const { reference, variant } of matchingVariants(page, axes, sel, spec?.modelAxes ?? null, {
    configurations: spec?.configurations ?? null,
    configId: spec?.configId ?? null,
  })) {
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
  return matchingVariants(page, axes, selection || {}, spec?.modelAxes ?? null, {
    configurations: spec?.configurations ?? null,
    configId: spec?.configId ?? null,
  }).map(({ reference, variant }) => {
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
