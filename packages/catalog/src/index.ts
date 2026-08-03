// @veta/catalog — what a piece IS and what it COSTS, brand-agnostically.
//
// The money rules are ported to the cent from the reference dealer/configurator
// chain, with every grade decision routed through an injected `SkuGrammar` — so
// a catalogue with an 8-digit graded ladder and one with bare SKUs run the same
// arithmetic. Depends on `@veta/materials` for the part-role taxonomy (the
// count ceiling and the never-bills list live THERE, and are never restated
// here). No React, no three.js, no siblings beyond materials.
//
// Prices are MAJOR-unit numbers throughout (see `money.ts` for the DB boundary).

// ── The grade grammar (the three reference mirrors, unified) ──────────────
export { LR_GRADE_LADDER, lr8DigitGrade, simpleSku, splitSkuOrRoot } from './skuGrammar.ts';
export type { SkuGrammar, SkuSplit } from './skuGrammar.ts';

// ── Catalogue pricing ─────────────────────────────────────────────────────
export {
  listPriceOf,
  baseProductFor,
  familyFor,
  productForGrade,
  buildPriceIndex,
  priceItems,
  isCompleteElement,
  safeMultiplier,
  clampPct,
  validPricingMode,
  applyDealerPricing,
  applyPricingMode,
} from './pricing.ts';
export type {
  PriceProduct,
  GradeProduct,
  PriceFamily,
  RetailFn,
  PartPriceEntry,
  PriceEntry,
  PriceIndexOptions,
  PricingMode,
  PayloadFamily,
  CatalogModel,
} from './pricing.ts';

// ── One placed piece's price, and its itemization ─────────────────────────
export {
  partFamiliesFrom,
  partPricesFor,
  materializedBase,
  resolveCompleteSku,
  unresolvedPartRoles,
  unresolvedWholePiece,
  offeredMaterials,
  piecePartsTotal,
  placementTotal,
  placementBreakdown,
  isPricedComponent,
  componentSubtotal,
  compoundSubtotal,
  firstWithoutFabric,
} from './placementPricing.ts';
export type {
  MaterialPick,
  ResolvedPiece,
  Placement,
  ResolvedById,
  FamilyLookup,
  MaterializedBase,
  CompleteSku,
  OfferableMaterial,
  BreakdownLine,
  PlacementBreakdown,
  LineComponent,
} from './placementPricing.ts';

// ── The materialization label (grade + fabric ⇄ one string) ───────────────
export {
  GRADE_GROUPS,
  SPECIAL_GRADES,
  LEGACY_NAMED_GRADES,
  ALPHA_GRADES,
  parseSubtype,
  composeSubtype,
} from './subtype.ts';
export type { ParsedSubtype, GradeGroup } from './subtype.ts';

// ── Stored-pick sanitizers (finishes re-exported from @veta/materials) ────
export { sanitizePartMaterials, sanitizePartFinishes } from './sanitize.ts';
export type { PartMaterial } from './sanitize.ts';

// ── Lead routing (the dealer network's decision, as a pure cascade) ───────
export {
  ROUTING_POLICIES,
  DEFAULT_ROUTING_CASCADE,
  DEFAULT_ROUTING_CONFIG,
  EARTH_RADIUS_KM,
  parseRoutingConfig,
  parsePolygon,
  parseTerritory,
  pointInPolygon,
  haversineKm,
  lngDelta,
  geoOf,
  postalKey,
  hash32,
  leadGeo,
  routingKeyOf,
  routeLead,
  routingStamp,
} from './routing.ts';
export type {
  GeoPoint,
  RoutableDealer,
  RoutableLead,
  RoutableLocation,
  RoutingConfig,
  RoutingDecision,
  RoutingOutcome,
  RoutingPolicy,
  RoutingStage,
  RoutingStamp,
  RoutingStep,
  Territory,
} from './routing.ts';

// ── The DB money boundary ─────────────────────────────────────────────────
export {
  ZERO_DECIMAL_CURRENCIES,
  DEFAULT_CURRENCY_EXPONENT,
  currencyExponent,
  toMinor,
  fromMinor,
} from './money.ts';
