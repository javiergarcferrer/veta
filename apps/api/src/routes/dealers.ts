// THE STORE LOCATOR — the one public read of the dealer network.
//
// What a visitor's browser is allowed to know about a dealer is: it exists,
// what it is called, where it is, and when it is open. That is the WHOLE
// payload, assembled field by field below.
//
// What is structurally absent — not filtered out downstream, not "not selected
// yet", but never fetched:
//
//   · `dealers.pricing` — the per-dealer multiplier is the brand's commercial
//     arrangement with its network. It reaches a browser only as ALREADY
//     APPLIED prices, through `/v1/catalog?dealer=…`; the raw lever never does.
//   · `dealers.contact` — the internal routing contacts (the inbox address, the
//     phone the brand calls). A showroom's PUBLIC phone belongs in the
//     location's `address` document, which is authored to be published.
//   · `dealer_locations.territory` — a competitor's map of who owns which
//     postcode is exactly the kind of thing that leaks once and forever.
//
// Inactive dealers are excluded here rather than by policy: a retired dealer's
// rows must stay readable to the members and the sk plane (its leads still
// exist), so "do not show it on the map" is a presentation rule and lives at
// the presentation edge — the same call `loadDealer` makes for pricing.

import { Hono } from 'hono';
import { requireScope, type AuthEnv } from '../auth.ts';
import { withTenant } from '../db.ts';
import { loadDealerLocations, loadDealers } from '../context.ts';
import type { DealerLocationRow } from '../context.ts';

/** A location as the map reads it. Coordinates are numbers or null — a
 *  location without them is still a listing (an address, hours), just not a
 *  pin, and dropping it would hide a real showroom. */
export interface StoreLocationView {
  id: string;
  dealerSlug: string;
  dealerName: string;
  name: string;
  lat: number | null;
  lng: number | null;
  address: Record<string, unknown>;
  hours: Record<string, unknown>;
}

/** `Number(null)` is 0 — and 0,0 is a real place in the Gulf of Guinea. An
 *  absent coordinate has to stay absent, or every un-geocoded showroom appears
 *  on the map off the coast of Africa. */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function shapeStoreLocation(
  row: DealerLocationRow,
  dealer: { slug: string; name: string },
): StoreLocationView {
  return {
    id: row.id,
    dealerSlug: dealer.slug,
    dealerName: dealer.name,
    name: row.name,
    lat: num(row.lat),
    lng: num(row.lng),
    address: obj(row.address),
    hours: obj(row.hours),
  };
}

export const dealerRoutes = new Hono<AuthEnv>()
  .get('/locations', requireScope('catalog:read'), async (c) => {
    const { orgId, kind } = c.get('identity');

    const locations = await withTenant(orgId, kind, async (client) => {
      const dealers = await loadDealers(client);
      const active = new Map(
        dealers.filter((d) => d.status === 'active').map((d) => [d.id, { slug: d.slug, name: d.name }]),
      );
      const rows = await loadDealerLocations(client);
      return rows
        .filter((row) => active.has(row.dealer_id))
        .map((row) => shapeStoreLocation(row, active.get(row.dealer_id)!));
    });

    return c.json({ locations });
  });
