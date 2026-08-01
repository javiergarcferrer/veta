// LEAD ROUTING, wired.
//
// The decision itself is `@veta/catalog`'s `routeLead` — pure, deterministic,
// unit-tested, and shared with the admin app so a brand admin previewing a
// cascade sees exactly what the API will do with the next lead. This module is
// only the seam: read the org's network through the caller's own RLS plane,
// read the brand's policy, hand both to the engine, and turn the answer into
// the row's stamp.
//
// TWO LAWS, both carried from the reference's lead handling:
//
//   · ROUTING NEVER COSTS THE LEAD. Every failure mode here — no network rows,
//     a garbage policy, a database hiccup mid-read — resolves to "unrouted,
//     with a reason". A lead is captured or it is not; which showroom owns it
//     is a question that can be answered later by a human, and `routeError`
//     says so on the row instead of throwing the POST away.
//
//   · THE REASON IS STORED. `leads.source.routing` carries the deciding policy
//     and the outcome, so "why did this land in Santiago?" is answerable from
//     the row alone, months later, without replaying anything.
//
// The lead's ROUTABLE half is parsed from the request body in `routableLead`,
// which is pure and therefore testable without a database — a widget cannot
// name a dealer that is not the tenant's (the pin is matched against rows the
// tenant's own plane returned), and cannot assert a dealer_id at all.

import type { PoolClient } from 'pg';
import { routeLead, routingStamp } from '@veta/catalog';
import type { RoutableDealer, RoutableLead, RoutableLocation, RoutingDecision } from '@veta/catalog';
import { loadDealerLocations, loadDealers, loadRoutingPolicy } from './context.ts';
import type { DealerLocationRow, DealerNetworkRow } from './context.ts';

export type { RoutingDecision };

/** The body fields routing reads. Everything else on a lead is none of its
 *  business — and `dealerId` is deliberately NOT among them. */
export interface LeadRoutingBody {
  dedupeKey?: unknown;
  dealerSlug?: unknown;
  postalCode?: unknown;
  geo?: unknown;
  contact?: unknown;
  source?: unknown;
}

function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The routable projection of a lead POST. Position may arrive three ways — an
 * explicit `geo`, a `postalCode`, or the same two nested inside `contact`
 * (where a form naturally collects them) — and the explicit one always wins.
 * The geometry itself is validated in the engine (`geoOf`), so junk here is
 * simply no position, never a 400.
 */
export function routableLead(body: LeadRoutingBody | null | undefined, id: string): RoutableLead {
  const contact = obj(body?.contact);
  const geo = body?.geo ?? contact.geo ?? null;
  return {
    id,
    dedupeKey: str(body?.dedupeKey),
    dealerSlug: str(body?.dealerSlug) ?? str(obj(body?.source).dealer),
    postalCode: str(body?.postalCode) ?? str(contact.postalCode) ?? str(contact.postal_code) ?? str(contact.zip),
    geo: geo && typeof geo === 'object' ? (geo as RoutableLead['geo']) : null,
  };
}

/** Row → the engine's shape. The only place the column spellings appear. */
export function routableDealer(row: DealerNetworkRow): RoutableDealer {
  return { id: row.id, slug: row.slug, status: row.status, brandId: row.brand_id };
}

export function routableLocation(row: DealerLocationRow): RoutableLocation {
  return {
    id: row.id,
    dealerId: row.dealer_id,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    territory: row.territory,
    routingPriority: row.routing_priority,
  };
}

/**
 * Route one lead against the tenant's own network. Reads ride the caller's
 * transaction, so RLS decides which dealers exist exactly as it does everywhere
 * else — there is no org filter here to forget.
 */
export async function routeLeadInTenant(
  client: PoolClient,
  lead: RoutableLead,
): Promise<RoutingDecision> {
  // Sequential: one pooled client, one statement at a time (see context.ts).
  const dealers = await loadDealers(client);
  const locations = await loadDealerLocations(client);
  const policy = await loadRoutingPolicy(client);
  return routeLead(lead, dealers.map(routableDealer), locations.map(routableLocation), policy);
}

/**
 * The stored provenance: whatever the widget sent, plus OUR routing verdict
 * under a reserved key. Client-supplied `source.routing` is overwritten, never
 * merged — the stamp is the server's account of what it did.
 */
export function sourceWithRouting(
  source: unknown,
  decision: RoutingDecision | null,
  error?: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj(source) };
  if (decision) out.routing = routingStamp(decision);
  if (error) out.routing = { policy: null, outcome: 'error', reason: `error:${error}`, distanceKm: null, at: new Date().toISOString() };
  return out;
}
