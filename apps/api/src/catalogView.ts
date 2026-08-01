// THE CATALOGUE PROJECTION — pure shaping of tenant rows into the payload a
// widget renders and quotes from.
//
// Two rules decide everything in this file:
//
//   · WHAT a plane may see is a POLICY, never a filter here. The publishable
//     plane sees published collections/models, active rulesets and the active
//     price list because RLS says so (migration 0001 + 0002). This module never
//     re-derives that gate — a route that forgot it would return nothing, not
//     someone's drafts.
//
//   · HOW MUCH of a price reaches the browser is the DEALER's presentation:
//     `applyDealerPricing` (× the dealer's multiplier, on a COPY — the catalogue
//     is shared and re-priced per request) then `applyPricingMode`
//     (full | from | hidden). It applies to READS ONLY; what the server STORES
//     is the unscaled list price (see pricing.ts).
//
// Money leaves in MINOR units + an ISO currency, the same representation the
// database holds. The presentation arithmetic runs in the engine's MAJOR units
// and is converted once, here, on the way out.

import { applyDealerPricing, applyPricingMode, safeMultiplier, toMinor, validPricingMode } from '@veta/catalog';
import type { CatalogModel, PayloadFamily, PricingMode, ResolvedPiece } from '@veta/catalog';
import { mountOf } from './context.ts';
import type {
  CollectionRow,
  DealerRow,
  MaterialColorRow,
  MaterialRow,
  ModelRow,
  PartRoleRow,
  RulesetRow,
} from './context.ts';

/* --------------------------------- shapes --------------------------------- */

export interface MoneyView {
  amountMinor: number;
  currency: string;
}

export interface FamilyView {
  root: string;
  graded: boolean;
  /** Grade keys in ASCENDING PRICE order — `grades[0]` is the quoted base. */
  grades: string[];
  byGrade: Record<string, { amountMinor: number; currency: string; reference: string }>;
}

export interface CollectionView {
  id: string;
  slug: string;
  name: string;
  status: string;
  renderParams: Record<string, unknown>;
  taxonomy: Record<string, unknown>;
  sortOrder: number;
}

export interface ModelView {
  id: string;
  collectionId: string;
  slug: string;
  name: string;
  status: string;
  tags: string[];
  widthCm: number;
  depthCm: number;
  heightCm: number | null;
  meshPath: string | null;
  meshParams: Record<string, unknown>;
  mount: 'seat' | null;
  defaultRot: number;
  sku: string | null;
  sortOrder: number;
  price: MoneyView | null;
  family: FamilyView | null;
  partFamilies: Record<string, FamilyView | null> | null;
}

export interface MaterialView {
  id: string;
  name: string;
  category: string | null;
  sourceAdapter: string;
  params: Record<string, unknown>;
  colors: Array<{
    id: string;
    name: string;
    code: string;
    grade: string;
    rgb: string | null;
    texturePath: string | null;
    normalPath: string | null;
    sortOrder: number;
  }>;
}

export interface RulesetView {
  collectionId: string;
  version: number;
  status: string;
  rules: unknown;
}

export interface DealerPresentation {
  slug: string | null;
  mode: PricingMode;
  multiplier: number;
}

export interface CatalogView {
  currency: string;
  dealer: DealerPresentation;
  collections: CollectionView[];
  models: ModelView[];
  materials: MaterialView[];
  rulesets: RulesetView[];
  partRoles: Array<{ key: string; label: Record<string, unknown>; billing: string; sortOrder: number }>;
}

/* -------------------------------- helpers --------------------------------- */

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The dealer's price presentation, or the brand's own (full price, no markup)
 * when the request names no dealer. A stored mode/multiplier that makes no sense
 * falls back to identity — a dealer's prices then read as the brand's, never as
 * zero.
 */
export function dealerPresentation(dealer: DealerRow | null | undefined): DealerPresentation {
  const pricing = obj(dealer?.pricing);
  return {
    slug: dealer?.slug ?? null,
    mode: validPricingMode(pricing.mode),
    multiplier: safeMultiplier(pricing.multiplier),
  };
}

export function shapeCollection(row: CollectionRow): CollectionView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    renderParams: obj(row.render_params),
    taxonomy: obj(row.taxonomy),
    sortOrder: row.sort_order,
  };
}

/** A `@veta/catalog` family (MAJOR units) → the wire's minor-unit shape. */
function shapeFamily(family: PayloadFamily | null | undefined, currency: string): FamilyView | null {
  if (!family || !family.byGrade || typeof family.byGrade !== 'object') return null;
  const byGrade: FamilyView['byGrade'] = {};
  for (const [grade, info] of Object.entries(family.byGrade)) {
    const entry = obj(info);
    byGrade[grade] = {
      amountMinor: toMinor(entry.priceUsd, currency),
      currency,
      reference: String(entry.reference ?? ''),
    };
  }
  const grades = Array.isArray(family.grades)
    ? (family.grades as unknown[]).map((g) => String(g))
    : Object.keys(byGrade);
  return {
    root: String(family.root ?? ''),
    graded: family.graded === true,
    grades,
    byGrade,
  };
}

/**
 * One model, priced FOR THIS DEALER. The presentation runs on a copy in major
 * units (that is where the ported rules live) and converts once on the way out,
 * so `hidden` really does mean no number reaches the browser — not a number the
 * client is asked politely not to render.
 */
export function shapeModel(
  row: ModelRow,
  resolved: ResolvedPiece | undefined,
  presentation: DealerPresentation,
  currency: string,
): ModelView {
  const priced = applyPricingMode(
    applyDealerPricing(
      {
        priceUsd: resolved?.unitPrice ?? null,
        family: (resolved?.baseFamily ?? null) as PayloadFamily | null,
        partFamilies: (resolved?.partFamilies ?? null) as Record<string, PayloadFamily | null> | null,
      } satisfies CatalogModel,
      presentation.multiplier,
    ),
    presentation.mode,
  );

  const partFamilies = priced.partFamilies
    ? Object.fromEntries(
        Object.entries(priced.partFamilies).map(([role, family]) => [role, shapeFamily(family, currency)]),
      )
    : null;

  return {
    id: row.id,
    collectionId: row.collection_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [],
    widthCm: num(row.width_cm),
    depthCm: num(row.depth_cm),
    heightCm: row.height_cm == null ? null : num(row.height_cm),
    meshPath: row.mesh_path,
    meshParams: obj(row.mesh_params),
    mount: mountOf(row.mount),
    defaultRot: num(row.default_rot),
    sku: row.sku,
    sortOrder: row.sort_order,
    price: priced.priceUsd == null ? null : { amountMinor: toMinor(priced.priceUsd, currency), currency },
    family: shapeFamily(priced.family, currency),
    partFamilies,
  };
}

export function shapeMaterials(
  materials: readonly MaterialRow[],
  colors: readonly MaterialColorRow[],
): MaterialView[] {
  const byMaterial = new Map<string, MaterialColorRow[]>();
  for (const color of colors) {
    const list = byMaterial.get(color.material_id) ?? [];
    list.push(color);
    byMaterial.set(color.material_id, list);
  }
  return materials.map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    sourceAdapter: m.source_adapter,
    params: obj(m.params),
    colors: (byMaterial.get(m.id) ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      grade: c.grade,
      rgb: c.rgb,
      texturePath: c.texture_path,
      normalPath: c.normal_path,
      sortOrder: c.sort_order,
    })),
  }));
}

export function shapeRuleset(row: RulesetRow): RulesetView {
  return { collectionId: row.collection_id, version: row.version, status: row.status, rules: row.rules };
}
