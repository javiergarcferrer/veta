// THE ROUTING SEAM, WITHOUT A DATABASE.
//
// The decision itself is pinned in `@veta/catalog`'s own suite; what is pinned
// here is the WIRE: what a lead POST may contribute to routing (and what it may
// never), how the answer is stamped onto the row, and what the store locator is
// allowed to publish about a dealer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { routeLead } from '@veta/catalog';
import { routableDealer, routableLead, routableLocation, sourceWithRouting } from '../src/routing.ts';
import { shapeStoreLocation } from '../src/routes/dealers.ts';
import type { DealerLocationRow, DealerNetworkRow } from '../src/context.ts';

const LEAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/* ------------------------------- routableLead ------------------------------ */

test('routableLead reads the position from the body, or from the contact form', () => {
  assert.deepEqual(routableLead({ geo: { lat: 18.5, lng: -69.9 } }, LEAD_ID).geo, { lat: 18.5, lng: -69.9 });
  assert.deepEqual(routableLead({ contact: { geo: { lat: 1, lng: 2 } } }, LEAD_ID).geo, { lat: 1, lng: 2 });
  // The explicit field wins over the nested one.
  assert.deepEqual(
    routableLead({ geo: { lat: 9, lng: 9 }, contact: { geo: { lat: 1, lng: 2 } } }, LEAD_ID).geo,
    { lat: 9, lng: 9 },
  );
  assert.equal(routableLead({ geo: 'somewhere' }, LEAD_ID).geo, null);
  assert.equal(routableLead({}, LEAD_ID).geo, null);
});

test('routableLead reads a postal code under any of the three names a form uses', () => {
  assert.equal(routableLead({ postalCode: ' 10101 ' }, LEAD_ID).postalCode, '10101');
  assert.equal(routableLead({ contact: { postal_code: '10102' } }, LEAD_ID).postalCode, '10102');
  assert.equal(routableLead({ contact: { zip: '10103' } }, LEAD_ID).postalCode, '10103');
  assert.equal(routableLead({ contact: { postalCode: '' } }, LEAD_ID).postalCode, null);
});

test('routableLead carries the dedupe key, and falls back to the row id for round-robin', () => {
  assert.equal(routableLead({ dedupeKey: 'k-1' }, LEAD_ID).dedupeKey, 'k-1');
  assert.equal(routableLead({}, LEAD_ID).id, LEAD_ID);
  assert.equal(routableLead({ dedupeKey: '   ' }, LEAD_ID).dedupeKey, null);
});

test('routableLead accepts a dealer SLUG and never a dealer id', () => {
  const lead = routableLead({ dealerSlug: 'santo-domingo', source: { dealer: 'ignored' } }, LEAD_ID);
  assert.equal(lead.dealerSlug, 'santo-domingo');
  // A widget embedded by a dealer may also name itself through `source.dealer`.
  assert.equal(routableLead({ source: { dealer: 'punta-cana' } }, LEAD_ID).dealerSlug, 'punta-cana');
  // …but nothing in the projection can point at a dealer by id.
  assert.equal(Object.keys(lead).includes('dealerId'), false);
  assert.equal(
    JSON.stringify(routableLead({ dealerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } as never, LEAD_ID))
      .includes('dddddddd'),
    false,
    'a body-asserted dealer_id reached the routing input',
  );
});

/* ------------------------------- the row shapes ---------------------------- */

const dealerRow = (over: Partial<DealerNetworkRow> = {}): DealerNetworkRow => ({
  id: 'd-1', slug: 'sd', name: 'Santo Domingo', status: 'active', brand_id: 'b-1', ...over,
});

const locationRow = (over: Partial<DealerLocationRow> = {}): DealerLocationRow => ({
  id: 'l-1',
  dealer_id: 'd-1',
  name: 'Showroom',
  lat: '18.47',
  lng: '-69.9',
  territory: { kind: 'radiusKm', radiusKm: 30 },
  address: { line1: 'Av. Winston Churchill 1099', city: 'Santo Domingo' },
  hours: { mon: '9-18' },
  routing_priority: 5,
  ...over,
});

test('the row→engine mapping is the only place the column spellings live', () => {
  assert.deepEqual(routableDealer(dealerRow()), { id: 'd-1', slug: 'sd', status: 'active', brandId: 'b-1' });
  const loc = routableLocation(locationRow());
  assert.equal(loc.dealerId, 'd-1');
  assert.equal(loc.routingPriority, 5);
  // Numeric columns arrive as STRINGS from pg — the engine's own coercion is
  // what keeps that from silently becoming "no position".
  const decision = routeLead(
    { geo: { lat: 18.47, lng: -69.9 } },
    [routableDealer(dealerRow())],
    [loc],
    { cascade: ['territory'] },
  );
  assert.equal(decision.dealerId, 'd-1');
});

/* ------------------------------ the stored stamp --------------------------- */

test('sourceWithRouting keeps the widget’s provenance and adds OUR verdict', () => {
  const decision = routeLead(
    { geo: { lat: 18.47, lng: -69.9 } },
    [routableDealer(dealerRow())],
    [routableLocation(locationRow())],
    { cascade: ['nearest'] },
  );
  const source = sourceWithRouting({ utm_source: 'ig', fbc: 'fb.1.2.3' }, decision);
  assert.equal(source.utm_source, 'ig');
  assert.equal(source.fbc, 'fb.1.2.3');
  assert.deepEqual((source.routing as Record<string, unknown>).reason, 'nearest:routed');
});

test('a client-asserted routing stamp is OVERWRITTEN, never merged', () => {
  const decision = routeLead({}, [], [], { cascade: ['manual'] });
  const source = sourceWithRouting({ routing: { policy: 'nearest', outcome: 'routed', dealerId: 'theirs' } }, decision);
  const stamp = source.routing as Record<string, unknown>;
  assert.equal(stamp.outcome, 'manual');
  assert.equal(stamp.dealerId, undefined);
});

test('a routing FAILURE is stamped as an error — the lead is stored either way', () => {
  const source = sourceWithRouting({ utm_source: 'ig' }, null, 'connection terminated');
  const stamp = source.routing as Record<string, unknown>;
  assert.equal(source.utm_source, 'ig');
  assert.equal(stamp.outcome, 'error');
  assert.equal(stamp.reason, 'error:connection terminated');
  assert.equal(stamp.policy, null);
});

test('sourceWithRouting survives a junk source without losing the stamp', () => {
  for (const junk of [null, undefined, 'string', 42, ['a']]) {
    const source = sourceWithRouting(junk, null, 'boom');
    assert.equal((source.routing as Record<string, unknown>).outcome, 'error');
  }
});

/* ------------------------------ the store locator -------------------------- */

test('the store locator publishes a place, and NOTHING commercial', () => {
  const view = shapeStoreLocation(locationRow(), { slug: 'sd', name: 'Santo Domingo' });
  assert.deepEqual(Object.keys(view).sort(), [
    'address', 'dealerName', 'dealerSlug', 'hours', 'id', 'lat', 'lng', 'name',
  ]);
  assert.equal(view.lat, 18.47);
  assert.equal(view.lng, -69.9);

  // The three things that must never cross: the pricing lever, the internal
  // contact, and the territory map.
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('territory'), false);
  assert.equal(serialized.includes('radiusKm'), false);
  assert.equal(serialized.includes('pricing'), false);
  assert.equal(serialized.includes('multiplier'), false);
});

test('a location without coordinates is still a listing, not a dropped showroom', () => {
  const view = shapeStoreLocation(locationRow({ lat: null, lng: null }), { slug: 'sd', name: 'SD' });
  assert.equal(view.lat, null);
  assert.equal(view.lng, null);
  assert.deepEqual(view.address, { line1: 'Av. Winston Churchill 1099', city: 'Santo Domingo' });
});

test('junk address/hours documents shape into empty objects, never null holes', () => {
  const view = shapeStoreLocation(
    locationRow({ address: null, hours: 'closed' as never }),
    { slug: 'sd', name: 'SD' },
  );
  assert.deepEqual(view.address, {});
  assert.deepEqual(view.hours, {});
});
