/**
 * THE MEMBER-PLANE ADAPTER — ⚠️ TYPED AND MOCKED, NOT YET VERIFIED.
 *
 * The admin is a MEMBER-plane app: every request rides the signed-in user's
 * JWT and lands under RLS, never a service-role key. That is not a convention
 * here, it is the design (`docs/design-phase1.md` §2.1) — and it is why this
 * adapter reads `api_keys_public`, the redacted VIEW, rather than `api_keys`:
 * the hash is not merely "not selected", it is not grantable.
 *
 * WHAT IS REAL HERE: the mapping — which table, which columns, which RPC, how
 * a row becomes an `AdminDealer` and back. That is the part the types have to
 * agree with, and the part a live wiring will not have to redesign.
 *
 * WHAT IS NOT: none of it has run against a live project. The queries are
 * written against a STRUCTURAL client interface (`SupabaseLike`) rather than
 * `@supabase/supabase-js` — the package is not a dependency of this app, and
 * inventing one to type a stub would be a lie in the manifest. Pass the real
 * client (it satisfies the interface structurally) once a project exists, and
 * only then delete this warning.
 */
import { redactKey } from '../vm/keys.ts';
import type { IssueKeyRequest } from '../vm/keys.ts';
import type {
  AdminApiKey,
  AdminDealer,
  AdminLead,
  AdminLocation,
  AdminModel,
  IssuedApiKey,
  LeadBuild,
  LeadPiece,
  LeadStatus,
  LeadVerdict,
} from '../vm/types.ts';
import type { RoutingConfig } from '../vm/routing.ts';
import type { AdminStore } from './types.ts';

/* ------------------------------ the client shape --------------------------- */

/** What every PostgREST call resolves to. Errors arrive in the payload, not as
 *  a rejection — which is why `rows()` below is the ONE place that raises. */
export interface PostgrestResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

/** A builder that is also a promise — supabase-js's own shape: you may chain
 *  `.eq(...)` or simply await it. */
export interface QueryLike extends PromiseLike<PostgrestResult> {
  eq(column: string, value: unknown): QueryLike;
}

export interface TableLike {
  select(columns?: string): QueryLike;
  upsert(rows: unknown, options?: { onConflict?: string }): { select(columns?: string): QueryLike };
  update(values: unknown): { eq(column: string, value: unknown): { select(columns?: string): QueryLike } };
  delete(): { eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }> };
}

export interface SupabaseLike {
  from(table: string): TableLike;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface SupabaseAdminStoreOptions {
  /** The org this session administers. RLS enforces it server-side; sending it
   *  is what lets an insert land in the right tenant at all. */
  orgId: string;
  brandId: string;
  now?: () => number;
}

/* --------------------------------- mapping --------------------------------- */

const ms = (v: unknown): number => {
  const t = v ? Date.parse(String(v)) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function dealerFromRow(row: unknown): AdminDealer {
  const r = obj(row);
  const pricing = obj(r.pricing);
  return {
    id: String(r.id ?? ''),
    slug: String(r.slug ?? ''),
    name: String(r.name ?? ''),
    status: r.status === 'inactive' ? 'inactive' : 'active',
    locale: String(r.locale ?? 'es'),
    currency: String(r.currency ?? 'USD'),
    pricing: {
      mode: (pricing.mode === 'from' || pricing.mode === 'hidden' ? pricing.mode : 'full'),
      multiplier: Number(pricing.multiplier ?? 1),
    },
    contact: obj(r.contact) as AdminDealer['contact'],
    updatedAt: ms(r.updated_at),
  };
}

export function dealerToRow(dealer: AdminDealer, orgId: string, brandId: string): Record<string, unknown> {
  return {
    id: dealer.id,
    org_id: orgId,
    brand_id: brandId,
    slug: dealer.slug,
    name: dealer.name,
    status: dealer.status,
    locale: dealer.locale,
    currency: dealer.currency,
    pricing: dealer.pricing,
    contact: dealer.contact,
  };
}

export function locationFromRow(row: unknown): AdminLocation {
  const r = obj(row);
  const territory = obj(r.territory);
  return {
    id: String(r.id ?? ''),
    dealerId: String(r.dealer_id ?? ''),
    name: String(r.name ?? ''),
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    territory: territory.kind === 'radiusKm' || territory.kind === 'polygon'
      ? (territory as AdminLocation['territory'])
      : null,
    address: obj(r.address),
    hours: obj(r.hours),
    routingPriority: Number(r.routing_priority ?? 0),
    updatedAt: ms(r.updated_at),
  };
}

export function locationToRow(location: AdminLocation, orgId: string): Record<string, unknown> {
  return {
    id: location.id,
    org_id: orgId,
    dealer_id: location.dealerId,
    name: location.name,
    lat: location.lat,
    lng: location.lng,
    territory: location.territory,
    address: location.address,
    hours: location.hours,
    routing_priority: location.routingPriority,
  };
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

const num0 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Only an EXPLICIT `ok:false` is a flag — a verdict that arrived without the
 *  field is not evidence of a broken build (see `vm/leads`.isFlagged). */
export function verdictFromRow(raw: unknown): LeadVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = obj(raw);
  const violations = Array.isArray(v.violations)
    ? v.violations.map((item) => {
        const entry = obj(item);
        return {
          severity: str(entry.severity),
          message: str(entry.message),
          ruleId: str(entry.ruleId ?? entry.rule_id),
        };
      })
    : [];
  return { ok: v.ok !== false, violations };
}

export function buildFromRow(raw: unknown): LeadBuild | null {
  if (!raw || typeof raw !== 'object') return null;
  const pieces = obj(raw).pieces;
  if (!Array.isArray(pieces)) return { pieces: [] };
  return {
    pieces: pieces.map((item): LeadPiece => {
      const piece = obj(item);
      return {
        uid: String(piece.uid ?? ''),
        modelId: String(piece.modelId ?? piece.model_id ?? ''),
        x: num0(piece.x),
        y: num0(piece.y),
        rot: num0(piece.rot),
      };
    }),
  };
}

export function leadFromRow(row: unknown): AdminLead {
  const r = obj(row);
  const estimate = obj(r.estimate);
  const amountMinor = Number(estimate.amount_minor ?? estimate.amountMinor);
  return {
    id: String(r.id ?? ''),
    dealerId: r.dealer_id ? String(r.dealer_id) : null,
    contact: obj(r.contact) as AdminLead['contact'],
    note: r.note === null || r.note === undefined ? null : String(r.note),
    status: (['pending', 'contacted', 'converted', 'dismissed'] as const)
      .find((s) => s === r.status) ?? 'pending',
    verdict: verdictFromRow(r.verdict),
    estimate: Number.isFinite(amountMinor)
      ? { amountMinor, currency: String(estimate.currency ?? 'USD') }
      : null,
    build: buildFromRow(r.build),
    source: obj(r.source) as AdminLead['source'],
    createdAt: ms(r.created_at),
  };
}

export function modelFromRow(row: unknown): AdminModel {
  const r = obj(row);
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    slug: String(r.slug ?? ''),
    widthCm: Number(r.width_cm ?? 0),
    depthCm: Number(r.depth_cm ?? 0),
    planSvg: r.plan_svg ? String(r.plan_svg) : null,
  };
}

/* ---------------------------------- store ---------------------------------- */

function rows(result: { data: unknown[] | null; error: { message: string } | null }): unknown[] {
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

export function createSupabaseAdminStore(
  client: SupabaseLike,
  { orgId, brandId }: SupabaseAdminStoreOptions,
): AdminStore {
  return {
    async listDealers() {
      return rows(await client.from('dealers').select('*')).map(dealerFromRow);
    },
    async saveDealer(dealer) {
      const result = await client.from('dealers')
        .upsert(dealerToRow(dealer, orgId, brandId), { onConflict: 'id' })
        .select('*');
      return dealerFromRow(rows(result)[0] ?? dealer);
    },
    async deleteDealer(id) {
      const { error } = await client.from('dealers').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async listLocations() {
      return rows(await client.from('dealer_locations').select('*')).map(locationFromRow);
    },
    async saveLocation(location) {
      const result = await client.from('dealer_locations')
        .upsert(locationToRow(location, orgId), { onConflict: 'id' })
        .select('*');
      return locationFromRow(rows(result)[0] ?? location);
    },
    async deleteLocation(id) {
      const { error } = await client.from('dealer_locations').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async loadRoutingConfig() {
      const brands = rows(await client.from('brands').select('routing_policy').eq('id', brandId));
      return obj(brands[0]).routing_policy ?? {};
    },
    async saveRoutingConfig(config: RoutingConfig) {
      const result = await client.from('brands')
        .update({ routing_policy: config })
        .eq('id', brandId)
        .select('id');
      rows(result);
    },

    async listLeads() {
      return rows(await client.from('leads').select('*')).map(leadFromRow);
    },
    async setLeadStatus(id, status: LeadStatus) {
      const result = await client.from('leads').update({ status }).eq('id', id).select('*');
      const row = rows(result)[0];
      if (!row) throw new Error(`No lead ${id}`);
      return leadFromRow(row);
    },
    async assignLead(id, dealerId) {
      const result = await client.from('leads').update({ dealer_id: dealerId }).eq('id', id).select('*');
      const row = rows(result)[0];
      if (!row) throw new Error(`No lead ${id}`);
      return leadFromRow(row);
    },

    async listModels() {
      return rows(await client.from('models').select('id,name,slug,width_cm,depth_cm,plan_svg')).map(modelFromRow);
    },

    async listApiKeys() {
      // The REDACTED view, not the table. The hash is not grantable here.
      const list = rows(await client.from('api_keys_public').select('*'));
      return list.map(redactKey).filter((k): k is AdminApiKey => k !== null);
    },
    async issueApiKey(request: IssueKeyRequest): Promise<IssuedApiKey> {
      const { data, error } = await client.rpc('issue_api_key', {
        p_org_id: orgId,
        p_kind: request.kind,
        p_scopes: request.scopes,
        p_allowed_origins: request.allowedOrigins,
      });
      if (error) throw new Error(error.message);
      const reply = obj(Array.isArray(data) ? data[0] : data);
      const key = redactKey({
        id: reply.key_id,
        kind: request.kind,
        prefix: String(reply.key_token ?? '').slice(0, 12),
        scopes: request.scopes,
        allowedOrigins: request.allowedOrigins,
        createdAt: Date.now(),
        lastUsedAt: null,
        revokedAt: null,
      });
      if (!key) throw new Error('issue_api_key returned no key');
      // The token crosses ONCE, here, on its way to being shown and dropped.
      return { key, token: String(reply.key_token ?? '') };
    },
    async revokeApiKey(id) {
      const { error } = await client.rpc('revoke_api_key', { p_key_id: id });
      if (error) throw new Error(error.message);
    },
  };
}
