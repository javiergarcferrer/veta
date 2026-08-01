// @veta/api — the single Node service. Tenancy is enforced by Postgres RLS on
// every plane; nothing here runs with credentials that could bypass it.

export { createApp } from './app.ts';
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
export { priceBuild, piecesOf } from './pricing.ts';
export type { Build, BuildPiece, PricingSnapshot } from './pricing.ts';
export { deriveVerdict, COUNT_MAX, RULES_SCHEMA_VERSION } from './verdict.ts';
export type { Verdict, Violation } from './verdict.ts';
