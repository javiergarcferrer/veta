// SERVER-SIDE PRICING — the money authority.
//
// A price the client asserts is data about the client, not about the product:
// every stored amount is recomputed HERE from the tenant's own `price_lists`,
// read through the same RLS the caller is subject to, with the ported money
// rules of `@veta/catalog` doing the arithmetic (one engine, two callers — the
// widget quotes with the same functions over the same catalogue payload).
//
// Three things are load-bearing and easy to undo by accident:
//
//   · THE WIRE NEVER SUPPLIES A NUMBER. A placement's fabric pick is trimmed to
//     its IDENTITY (`code`/`grade`/`fabric`) before it reaches the engine, and
//     the unit price is then resolved from the price list BY that grade. The
//     reference app overlays the pick's own `unitPrice` — legitimate there,
//     because the pick came from the dealer's palette; fatal here, because it
//     comes from a browser. `sanitizeMaterial` is that door.
//
//   · THE STORED SNAPSHOT IS UNSCALED SERVER TRUTH, in integer MINOR units plus
//     an ISO currency. The dealer's presentation (`applyDealerPricing` /
//     `applyPricingMode`) belongs to catalogue READS — scaling what we store
//     would make one dealer's markup the customer's invoice.
//
//   · THE ITEMIZATION FOOTS TO THE TOTAL. `placementBreakdown` is pinned to
//     `placementTotal` inside `@veta/catalog`; storing both is what lets a
//     dealer explain a number instead of defending it.

import {
  buildPriceIndex,
  familyFor,
  partFamiliesFrom,
  placementBreakdown,
  placementTotal,
  productForGrade,
  sanitizePartMaterials,
  toMinor,
} from '@veta/catalog';
import type {
  FamilyLookup,
  MaterialPick,
  Placement,
  PriceFamily,
  ResolvedPiece,
} from '@veta/catalog';
import type { PartsMap } from '@veta/materials';
import type { PlacedPiece } from '@veta/rules';
import { piecesOf } from './build.ts';
import { DEFAULT_CURRENCY } from './context.ts';
import type { CollectionContext } from './context.ts';

export { piecesOf } from './build.ts';
export type { Build } from './build.ts';

/** A placed piece as the API reads it — the rules engine's shape, verbatim. */
export type BuildPiece = PlacedPiece;

/** One itemized row of a piece's price, in minor units. */
export interface PricingPart {
  role: string;
  qty: number;
  unit_minor: number | null;
  total_minor: number | null;
  /** Listed but not charged: a zone, or a componente folded into the element. */
  included?: boolean;
  /** This line IS the whole piece (a monocolor elemento completo). */
  complete?: boolean;
  /** Nothing was picked — the price is the family's cheapest grade. */
  default_grade?: boolean;
  /** A pick whose grade its own ladder never priced — «sin precio», kept
   *  visible (upstream 3e1ea3e no-vanish), distinguishable from a model the
   *  collection simply carries no price for. */
  unresolved?: boolean;
}

export interface PricingLine {
  uid: string;
  model_id: string;
  amount_minor: number | null;
  parts?: PricingPart[];
}

export interface PricingSnapshot {
  amount_minor: number;
  currency: string;
  priced_at: string;
  priced_pieces: number;
  /** Models a piece named that this collection could not price (or does not carry). */
  unpriced_models: string[];
  price_list_id: string | null;
  lines: PricingLine[];
}

export interface PriceBuildOptions {
  /** Injectable clock — a snapshot's stamp is data, not a wall-clock read. */
  now?: () => Date;
}

/* ------------------------------ the wire door ------------------------------ */

const MAX_CODE = 32;
const MAX_GRADE = 8;
const MAX_FABRIC = 200;

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * A placement's own fabric pick, trimmed to identity. Returns undefined when the
 * pick names nothing, so a piece with no fabric reads as unpicked (the base
 * grade prices it) rather than as an empty materialization.
 *
 * Everything else the payload attached — `unitPrice`, `reference`, a fabricated
 * family — is DROPPED here. That is the whole reason this function exists.
 */
export function sanitizeMaterial(raw: unknown): MaterialPick | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const pick = raw as Record<string, unknown>;
  const code = text(pick.code, MAX_CODE);
  const grade = text(pick.grade, MAX_GRADE);
  const fabric = text(pick.fabric, MAX_FABRIC);
  if (!code && !grade && !fabric) return undefined;
  return { code, grade, fabric };
}

/** The placement the money engine sees: identity picks and nothing else. */
export function toPlacement(piece: PlacedPiece): Placement {
  const placement: Placement = {
    uid: piece.uid === undefined || piece.uid === null ? '' : String(piece.uid),
    pieceId: String(piece.modelId ?? ''),
  };
  const material = sanitizeMaterial(piece.material);
  if (material) placement.material = material;
  const partMaterials = sanitizePartMaterials(piece.partMaterials);
  // `PartMaterial` is the narrower, closed shape of a `MaterialPick` — the cast
  // widens a sanitized pick back to what the engine reads, never the reverse.
  if (partMaterials) placement.partMaterials = partMaterials as Record<string, MaterialPick>;
  return placement;
}

/* ------------------------------ the catalogue ------------------------------ */

/**
 * The collection's models as priced pieces: the base SKU's ladder (`familyFor`),
 * its cheapest priced rung (`buildPriceIndex`, the quoted base), and the shared
 * SKUs its tagged parts bill on.
 *
 * Exported because the catalogue route publishes the same families to the widget
 * — one binding, so what a browser quotes and what the server stores cannot
 * disagree.
 */
export function resolvePieces(
  ctx: Pick<CollectionContext, 'models' | 'products' | 'grammar'>,
): Record<string, ResolvedPiece> {
  const families = new Map<string, PriceFamily | null>();
  const familyOf = (root: string): PriceFamily | null => {
    if (!families.has(root)) families.set(root, familyFor(root, ctx.products, undefined, ctx.grammar));
    return families.get(root) ?? null;
  };
  const lookup: FamilyLookup = { get: (root: string) => familyOf(root) };

  const index = buildPriceIndex(
    ctx.models.map((m) => ({ id: m.id, product_root: m.sku, parts: m.parts })),
    ctx.products,
    undefined,
    { grammar: ctx.grammar },
  );

  const resolved: Record<string, ResolvedPiece> = {};
  for (const model of ctx.models) {
    const root = model.sku ? String(model.sku) : '';
    const family = root ? familyOf(root) : null;
    const parts = (model.parts ?? null) as PartsMap | null;
    resolved[model.id] = {
      unitPrice: index[model.id]?.baseUsd ?? null,
      reference: baseReferenceOf(family),
      parts,
      baseFamily: family,
      partFamilies: partFamiliesFrom(parts, lookup),
    };
  }
  return resolved;
}

/** The cheapest rung's SKU — `familyFor` sorts grades by price ascending. */
function baseReferenceOf(family: PriceFamily | null): string {
  if (!family) return '';
  const grade = family.grades[0];
  return (grade !== undefined && family.byGrade[grade]?.reference) || '';
}

/**
 * A piece's model, RE-GRADED by the piece's own fabric pick. The reference app
 * gets this by overlaying the palette's `unitPrice`; the server resolves it from
 * the price list instead, which is the same arithmetic with the client's number
 * removed. A grade the ladder doesn't carry falls back to the model's base — an
 * invented grade can never invent a price.
 */
function gradedFor(
  model: ResolvedPiece | undefined,
  pick: MaterialPick | undefined,
): ResolvedPiece | undefined {
  if (!model) return undefined;
  const grade = pick?.grade ? String(pick.grade).trim().toUpperCase() : '';
  if (!grade || !model.baseFamily) return model;
  const product = productForGrade(model.baseFamily, grade);
  if (!product || product.priceUsd == null) return model;
  return { ...model, unitPrice: Number(product.priceUsd), reference: product.reference || model.reference };
}

/* -------------------------------- pricing --------------------------------- */

/**
 * Price a submitted build against the collection's own catalogue. Pure: the
 * context is loaded once by the caller (see context.ts), so this is the function
 * the parity and unit tests can run without a database.
 *
 * A piece whose model this collection does not carry, or which nothing in the
 * price list prices, contributes NOTHING and is named in `unpriced_models` — it
 * never silently costs zero and it never borrows another tenant's price.
 */
export function priceBuild(
  build: unknown,
  ctx: CollectionContext | null | undefined,
  opts: PriceBuildOptions = {},
): PricingSnapshot {
  const now = opts.now ?? (() => new Date());
  const pieces = piecesOf(build);
  const snapshot: PricingSnapshot = {
    amount_minor: 0,
    currency: ctx?.currency ?? DEFAULT_CURRENCY,
    priced_at: now().toISOString(),
    priced_pieces: 0,
    unpriced_models: [],
    price_list_id: ctx?.priceListId ?? null,
    lines: [],
  };
  if (!ctx || !pieces.length) return snapshot;

  const resolved = resolvePieces(ctx);
  for (const piece of pieces) {
    const modelId = String(piece.modelId ?? '');
    const placement = toPlacement(piece);
    const model = gradedFor(resolved[modelId], placement.material as MaterialPick | undefined);
    // A one-entry lookup per piece: `placementTotal` reads the model by the
    // placement's own pieceId, and the grade resolution above is per placement.
    const byId: Record<string, ResolvedPiece> = model ? { [modelId]: model } : {};
    const total = placementTotal(placement, byId);
    const uid = String(placement.uid ?? '');

    if (total == null) {
      if (modelId && !snapshot.unpriced_models.includes(modelId)) snapshot.unpriced_models.push(modelId);
      snapshot.lines.push({ uid, model_id: modelId, amount_minor: null });
      continue;
    }
    const minor = toMinor(total, snapshot.currency);
    snapshot.amount_minor += minor;
    snapshot.priced_pieces += 1;
    snapshot.lines.push({
      uid,
      model_id: modelId,
      amount_minor: minor,
      parts: breakdownOf(placement, byId, snapshot.currency),
    });
  }
  return snapshot;
}

/**
 * The itemization, in minor units. Labels are deliberately NOT stored: a role is
 * data, its label is presentation, and a snapshot that freezes Spanish strings
 * is a snapshot that has to be migrated to add a locale.
 */
function breakdownOf(
  placement: Placement,
  resolved: Record<string, ResolvedPiece>,
  currency: string,
): PricingPart[] {
  const { lines } = placementBreakdown(placement, resolved);
  return lines.map((line) => {
    const part: PricingPart = {
      role: line.role,
      qty: line.qty,
      unit_minor: line.unitUsd == null ? null : toMinor(line.unitUsd, currency),
      total_minor: line.totalUsd == null ? null : toMinor(line.totalUsd, currency),
    };
    if (line.included) part.included = true;
    if (line.complete) part.complete = true;
    if (line.defaultGrade) part.default_grade = true;
    if (line.unresolved) part.unresolved = true;
    return part;
  });
}
