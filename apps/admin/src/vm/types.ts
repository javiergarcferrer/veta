/**
 * THE ADMIN DOMAIN — what a brand admin and a dealer actually work with.
 *
 * Two surfaces share these shapes: the BRAND ADMIN (the whole org's dealers,
 * keys, leads) and the DEALER PORTAL (one dealer's own inbox). They are the
 * same data seen through different plane rules, which is exactly why the rules
 * live in `vm/*` rather than in whichever screen happens to render them.
 *
 * Deliberately NOT the storage schema — the store adapter maps to columns
 * (`store/supabase.ts`); nothing in `vm/*` or `ui/*` learns a column name.
 *
 * The one shape that is defined by ABSENCE: `AdminApiKey`. There is no field
 * for a secret's hash and none for its plaintext, because the view model must
 * never be able to hold either — see `vm/keys.ts`.
 */
import type { PricingMode } from '@veta/catalog';

export type { PricingMode };

/* --------------------------------- dealers -------------------------------- */

export type DealerStatus = 'active' | 'inactive';

/** How much of the brand's price a dealer's widget shows, and at what markup. */
export interface DealerPricing {
  mode: PricingMode;
  multiplier: number;
}

/** The internal contact — how the BRAND reaches this dealer. Never published;
 *  a showroom's public phone belongs on the location's address document. */
export interface DealerContact {
  email?: string;
  phone?: string;
  notes?: string;
}

export interface AdminDealer {
  id: string;
  slug: string;
  name: string;
  status: DealerStatus;
  locale: string;
  currency: string;
  pricing: DealerPricing;
  contact: DealerContact;
  updatedAt: number;
}

/** A radius territory is authored in km around the location; a polygon is
 *  authored as a ring. Both are `@veta/catalog`'s `Territory` once parsed. */
export type AdminTerritory =
  | { kind: 'radiusKm'; radiusKm: number }
  | { kind: 'polygon'; polygon: { lat: number; lng: number }[] };

export interface AdminLocation {
  id: string;
  dealerId: string;
  name: string;
  lat: number | null;
  lng: number | null;
  territory: AdminTerritory | null;
  address: Record<string, unknown>;
  hours: Record<string, unknown>;
  routingPriority: number;
  updatedAt: number;
}

/* ---------------------------------- leads --------------------------------- */

export type LeadStatus = 'pending' | 'contacted' | 'converted' | 'dismissed';

export interface LeadContact {
  name?: string;
  email?: string;
  phone?: string;
  postalCode?: string;
}

/** The engine's judgement, as stored on the lead. `ok:false` is a FLAG, never a
 *  rejection — the lead exists because the law says it always does. */
export interface LeadVerdict {
  ok: boolean;
  violations?: { severity?: string; message?: string; ruleId?: string }[];
}

export interface LeadEstimate {
  amountMinor: number;
  currency: string;
}

/** One placed piece of the build the visitor configured. */
export interface LeadPiece {
  uid: string;
  modelId: string;
  x?: number;
  y?: number;
  rot?: number;
}

export interface LeadBuild {
  pieces: LeadPiece[];
}

/** The routing stamp the API wrote (`@veta/catalog`'s `RoutingStamp`). */
export interface LeadRoutingStamp {
  policy: string | null;
  outcome: string;
  reason: string;
  distanceKm?: number | null;
  at?: string;
}

export interface AdminLead {
  id: string;
  dealerId: string | null;
  contact: LeadContact;
  note: string | null;
  status: LeadStatus;
  verdict: LeadVerdict | null;
  estimate: LeadEstimate | null;
  build: LeadBuild | null;
  source: { routing?: LeadRoutingStamp; [k: string]: unknown };
  createdAt: number;
}

/* --------------------------------- catalogue ------------------------------- */

/** The sliver of a model the portal needs: a name for the line, a footprint
 *  for the plan, and the plan symbol itself when one was authored. */
export interface AdminModel {
  id: string;
  name: string;
  slug: string;
  widthCm: number;
  depthCm: number;
  planSvg: string | null;
}

/* --------------------------------- api keys -------------------------------- */

export type ApiKeyKind = 'publishable' | 'secret';

/**
 * A key as the ADMIN may see it: enough to recognise, revoke and audit, and
 * not one byte of credential material. There is no `keyHash` and no `token`
 * field to populate — the redaction is the TYPE, not a discipline.
 */
export interface AdminApiKey {
  id: string;
  kind: ApiKeyKind;
  /** The human handle (`pk_live_a1b2…`), never the rest of the key. */
  prefix: string;
  scopes: string[];
  allowedOrigins: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * The ONE moment a secret exists in the UI: the RPC's reply. It is deliberately
 * a different type from `AdminApiKey` so it cannot be stored in the same list —
 * it is shown once, copied, and dropped.
 */
export interface IssuedApiKey {
  key: AdminApiKey;
  token: string;
}
