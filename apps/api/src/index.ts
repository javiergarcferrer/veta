// @veta/api — the single Node service. Tenancy is enforced by Postgres RLS on
// every plane; nothing here runs with credentials that could bypass it.
//
// The two engines are IMPORTED, never mirrored: `deriveVerdict` runs
// `@veta/rules` and `priceBuild` runs `@veta/catalog` — the same modules the
// widget bundles, which is why the HTTP parity test can replay the rules
// fixtures through these routes and expect the fixture's own Verdict back.

export { createApp } from './app.ts';
export type { AppOptions } from './app.ts';
export { configureDb, getPool, closeDb, withTenant, withApiRole } from './db.ts';
export type { DbConfig, KeyKind } from './db.ts';
export {
  apiKeyAuth,
  requireScope,
  resolveApiKey,
  extractKey,
  keyKindOf,
  lookupValueFor,
  originAllowed,
} from './auth.ts';
export type { ApiIdentity, ApiKeyRow, AuthEnv } from './auth.ts';

export { createRateLimiter, DEFAULT_RATE_LIMIT } from './rateLimit.ts';
export type { RateLimitConfig, RateLimitDecision, RateLimiter } from './rateLimit.ts';

export { piecesOf, modelIdsOf, buildTooLarge, MAX_BUILD_PIECES, UUID_RE } from './build.ts';
export type { Build } from './build.ts';

export {
  DEFAULT_CURRENCY,
  grammarFor,
  layoutParamsOf,
  loadActiveRuleset,
  loadCollectionById,
  loadCollectionBySlug,
  loadCollectionContext,
  loadCollections,
  loadDealer,
  loadDealerBySlug,
  loadDealerLocations,
  loadDealers,
  loadModels,
  loadPriceContext,
  loadRoutingPolicy,
  mountOf,
  productsFrom,
  ruleCatalogOf,
} from './context.ts';
export type {
  CollectionContext,
  CollectionRow,
  DealerLocationRow,
  DealerNetworkRow,
  DealerRow,
  ModelRow,
  PriceContext,
  RulesetRow,
} from './context.ts';

// Lead routing: the DECISION is `@veta/catalog`'s pure cascade; this is the
// seam that feeds it the tenant's own network and stamps the answer.
export {
  routableDealer,
  routableLead,
  routableLocation,
  routeLeadInTenant,
  sourceWithRouting,
} from './routing.ts';
export type { LeadRoutingBody, RoutingDecision } from './routing.ts';

export { dealerRoutes, shapeStoreLocation } from './routes/dealers.ts';
export type { StoreLocationView } from './routes/dealers.ts';

export { priceBuild, resolvePieces, sanitizeMaterial, toPlacement } from './pricing.ts';
export type { BuildPiece, PricingLine, PricingPart, PricingSnapshot } from './pricing.ts';

export {
  blocksSave,
  deriveVerdict,
  isStrictRuleset,
  parseStoredRuleset,
  COUNT_MAX,
  RULES_SCHEMA_VERSION,
} from './verdict.ts';
export type { ParsedRuleset, StoredVerdict, Verdict, Violation } from './verdict.ts';

export {
  dealerPresentation,
  shapeCollection,
  shapeMaterials,
  shapeModel,
  shapeRuleset,
} from './catalogView.ts';
export type { CatalogView, CollectionView, FamilyView, ModelView } from './catalogView.ts';

export { eventsOf, normalizeEvent, MAX_EVENT_BATCH } from './routes/events.ts';
