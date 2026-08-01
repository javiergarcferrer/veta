/**
 * LEAD ROUTING — the dealer network's decision, pinned.
 *
 * What must hold no matter who edits `routing.ts` next:
 *   • the cascade is ORDERED and the first decider wins; `manual` terminates it;
 *   • an unroutable lead is `null` WITH a reason — never a plausible guess;
 *   • round-robin is a HASH, so the same lead routes to the same dealer on
 *     every instance and on every retry (a counter would not);
 *   • the globe is round: haversine survives the antimeridian, and so does
 *     point-in-polygon;
 *   • a boundary point is INSIDE (a street-line territory must own its street);
 *   • junk (NaN coords, a garbage territory, a garbage config) costs the RULE,
 *     never the lead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ROUTING_CASCADE,
  EARTH_RADIUS_KM,
  geoOf,
  hash32,
  haversineKm,
  leadGeo,
  lngDelta,
  parsePolygon,
  parseRoutingConfig,
  parseTerritory,
  pointInPolygon,
  postalKey,
  routeLead,
  routingKeyOf,
  routingStamp,
} from '../src/index.ts';
import type { RoutableDealer, RoutableLocation, RoutingConfig } from '../src/index.ts';

/* --------------------------------- fixtures -------------------------------- */

const dealers: RoutableDealer[] = [
  { id: 'd-north', slug: 'north', status: 'active' },
  { id: 'd-south', slug: 'south', status: 'active' },
  { id: 'd-closed', slug: 'closed', status: 'inactive' },
];

// Santo Domingo (north) and Punta Cana (south) — ~180 km apart.
const SD = { lat: 18.4861, lng: -69.9312 };
const PC = { lat: 18.582, lng: -68.4055 };

const locations: RoutableLocation[] = [
  { id: 'l-north', dealerId: 'd-north', lat: SD.lat, lng: SD.lng },
  { id: 'l-south', dealerId: 'd-south', lat: PC.lat, lng: PC.lng },
  { id: 'l-closed', dealerId: 'd-closed', lat: 18.5, lng: -69.0 },
];

const cfg = (over: Partial<RoutingConfig> = {}): RoutingConfig => ({
  ...parseRoutingConfig({}),
  ...over,
});

/* --------------------------------- geometry -------------------------------- */

test('haversine is antimeridian-safe: 179.9E → 179.9W is ~22 km, not half the planet', () => {
  const km = haversineKm({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
  assert.ok(km > 20 && km < 24, `expected ~22 km, got ${km}`);
  // …and the same pair the "obvious" way round.
  assert.ok(Math.abs(km - haversineKm({ lat: 0, lng: -179.9 }, { lat: 0, lng: 179.9 })) < 1e-9);
});

test('haversine agrees with the known scale: a degree of latitude is ~111 km, the equator ~40 030 km', () => {
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.1);
  const half = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
  assert.ok(Math.abs(half - Math.PI * EARTH_RADIUS_KM) < 1e-6);
  assert.equal(haversineKm(SD, SD), 0);
});

test('lngDelta folds into (-180,180] — the wrap handled once, for everyone', () => {
  assert.equal(lngDelta(179, -179), 2);
  assert.equal(lngDelta(-179, 179), -2);
  assert.equal(lngDelta(0, 180), 180);
  assert.equal(lngDelta(0, -180), 180);   // -180 and 180 are the same meridian
  assert.equal(lngDelta(10, 20), 10);
});

test('geoOf refuses junk and out-of-range coordinates — a bad row is not a place', () => {
  assert.deepEqual(geoOf({ lat: 18.5, lng: -69.9 }), { lat: 18.5, lng: -69.9 });
  assert.deepEqual(geoOf({ lat: '18.5', lng: '-69.9' }), { lat: 18.5, lng: -69.9 });
  assert.deepEqual(geoOf({ latitude: 1, longitude: 2 }), { lat: 1, lng: 2 });
  assert.equal(geoOf({ lat: 91, lng: 0 }), null);
  assert.equal(geoOf({ lat: 0, lng: 181 }), null);
  assert.equal(geoOf({ lat: Number.NaN, lng: 0 }), null);
  assert.equal(geoOf({ lat: null, lng: null }), null);
  assert.equal(geoOf(null), null);
  assert.equal(geoOf('18,-69'), null);
});

/* ------------------------------ point in polygon --------------------------- */

const square = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 10, lng: 10 },
  { lat: 10, lng: 0 },
];

test('pointInPolygon: interior in, exterior out', () => {
  assert.equal(pointInPolygon({ lat: 5, lng: 5 }, square), true);
  assert.equal(pointInPolygon({ lat: 15, lng: 5 }, square), false);
  assert.equal(pointInPolygon({ lat: 5, lng: 15 }, square), false);
  assert.equal(pointInPolygon({ lat: -0.001, lng: 5 }, square), false);
});

test('pointInPolygon: a boundary point and a vertex are INSIDE', () => {
  // A territory edge that runs down a street must own the addresses on it —
  // "inside" flickering with float noise is the worst possible answer.
  assert.equal(pointInPolygon({ lat: 0, lng: 5 }, square), true);    // on an edge
  assert.equal(pointInPolygon({ lat: 5, lng: 10 }, square), true);   // on an edge
  assert.equal(pointInPolygon({ lat: 0, lng: 0 }, square), true);    // a vertex
  assert.equal(pointInPolygon({ lat: 10, lng: 10 }, square), true);  // a vertex
});

test('pointInPolygon: a ray through a vertex crosses ONCE (no double count)', () => {
  const diamond = [
    { lat: 0, lng: 0 },
    { lat: 5, lng: 5 },
    { lat: 10, lng: 0 },
    { lat: 5, lng: -5 },
  ];
  assert.equal(pointInPolygon({ lat: 5, lng: 0 }, diamond), true);
  // Probe exactly at the y of the left/right vertices, outside the shape.
  assert.equal(pointInPolygon({ lat: 5, lng: -6 }, diamond), false);
  assert.equal(pointInPolygon({ lat: 0, lng: -1 }, diamond), false);
});

test('pointInPolygon: concave shapes do not become convex', () => {
  const u = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 10 },
    { lat: 10, lng: 10 },
    { lat: 10, lng: 7 },
    { lat: 3, lng: 7 },
    { lat: 3, lng: 3 },
    { lat: 10, lng: 3 },
    { lat: 10, lng: 0 },
  ];
  assert.equal(pointInPolygon({ lat: 1, lng: 5 }, u), true);    // in the base
  assert.equal(pointInPolygon({ lat: 8, lng: 5 }, u), false);   // in the notch
  assert.equal(pointInPolygon({ lat: 8, lng: 8 }, u), true);    // in the right arm
});

test('pointInPolygon: a territory spanning the antimeridian stays ONE shape', () => {
  const fiji = [
    { lat: -18, lng: 178 },
    { lat: -18, lng: -178 },
    { lat: -16, lng: -178 },
    { lat: -16, lng: 178 },
  ];
  assert.equal(pointInPolygon({ lat: -17, lng: 179.9 }, fiji), true);
  assert.equal(pointInPolygon({ lat: -17, lng: -179.9 }, fiji), true);
  assert.equal(pointInPolygon({ lat: -17, lng: 170 }, fiji), false);
  assert.equal(pointInPolygon({ lat: -17, lng: 0 }, fiji), false);
});

test('pointInPolygon: a degenerate ring is never a territory', () => {
  assert.equal(pointInPolygon({ lat: 1, lng: 1 }, []), false);
  assert.equal(pointInPolygon({ lat: 1, lng: 1 }, [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]), false);
});

test('parsePolygon reads both authored shapes, and GeoJSON is [lng,lat]', () => {
  assert.deepEqual(parsePolygon([[0, 1], [2, 3], [4, 5]]), [
    { lat: 1, lng: 0 }, { lat: 3, lng: 2 }, { lat: 5, lng: 4 },
  ]);
  assert.equal(parsePolygon([[0, 1], [2, 3]]), null);       // fewer than 3 points
  assert.equal(parsePolygon('nope'), null);
  // A junk vertex is DROPPED; the rest of the ring still stands (junk costs the
  // rule, never the lead) — unless too little is left to be a shape.
  assert.equal(parsePolygon([[0, 1], [2, 3], ['x', 'y'], [4, 5]])!.length, 3);
});

test('parseTerritory is defensive: junk is NO territory, never a throw', () => {
  assert.deepEqual(parseTerritory({ kind: 'radiusKm', radiusKm: 25 }), { kind: 'radiusKm', radiusKm: 25 });
  assert.equal(parseTerritory({ kind: 'radiusKm', radiusKm: 0 }), null);
  assert.equal(parseTerritory({ kind: 'radiusKm', radiusKm: -5 }), null);
  assert.equal(parseTerritory({ kind: 'radiusKm', radiusKm: 'wide' }), null);
  assert.equal(parseTerritory({ kind: 'polygon', polygon: [] }), null);
  assert.equal(parseTerritory({ kind: 'wormhole' }), null);
  assert.equal(parseTerritory(null), null);
  assert.equal(parseTerritory('{}'), null);
  assert.equal(parseTerritory({ polygon: [[0, 0], [1, 0], [1, 1]] })!.kind, 'polygon');
});

/* ---------------------------------- config --------------------------------- */

test('parseRoutingConfig falls back to the conservative default cascade', () => {
  assert.deepEqual(parseRoutingConfig(null).cascade, DEFAULT_ROUTING_CASCADE);
  assert.deepEqual(parseRoutingConfig({}).cascade, DEFAULT_ROUTING_CASCADE);
  assert.deepEqual(parseRoutingConfig({ cascade: [] }).cascade, DEFAULT_ROUTING_CASCADE);
  assert.deepEqual(parseRoutingConfig({ cascade: ['teleport'] }).cascade, DEFAULT_ROUTING_CASCADE);
  // Round-robin is opt-in — spreading leads at random is a decision a brand
  // makes, never a default the platform assumes.
  assert.equal(DEFAULT_ROUTING_CASCADE.includes('round-robin'), false);
});

test('parseRoutingConfig keeps order, drops unknowns and de-duplicates', () => {
  const parsed = parseRoutingConfig({ cascade: ['nearest', 'lunar', 'territory', 'nearest', 'manual'] });
  assert.deepEqual(parsed.cascade, ['nearest', 'territory', 'manual']);
});

test('parseRoutingConfig: a junk maxDistanceKm reverts to uncapped, never clamped', () => {
  assert.equal(parseRoutingConfig({ maxDistanceKm: 50 }).maxDistanceKm, 50);
  assert.equal(parseRoutingConfig({ maxDistanceKm: 0 }).maxDistanceKm, null);
  assert.equal(parseRoutingConfig({ maxDistanceKm: -1 }).maxDistanceKm, null);
  assert.equal(parseRoutingConfig({ maxDistanceKm: 'far' }).maxDistanceKm, null);
  assert.equal(parseRoutingConfig({ max_distance_km: 20 }).maxDistanceKm, 20);
});

test('parseRoutingConfig normalizes postal centroids and drops unusable ones', () => {
  const parsed = parseRoutingConfig({
    postalCentroids: { 'a1b 2c3': { lat: 1, lng: 2 }, 'X9': { lat: 999, lng: 0 }, '': { lat: 1, lng: 1 } },
  });
  assert.deepEqual(parsed.postalCentroids, { A1B2C3: { lat: 1, lng: 2 } });
  assert.equal(postalKey(' a1b-2c3 '), 'A1B2C3');
});

/* ---------------------------------- hash ----------------------------------- */

test('hash32 is FNV-1a and stable — the whole determinism argument rests on it', () => {
  assert.equal(hash32(''), 0x811c9dc5);
  assert.equal(hash32('a'), 0xe40c292c);
  assert.equal(hash32('foobar'), 0xbf9cf968);
  assert.equal(hash32('lead-1'), hash32('lead-1'));
  assert.notEqual(hash32('lead-1'), hash32('lead-2'));
});

/* --------------------------------- nearest --------------------------------- */

test('nearest picks the closest location and reports the distance', () => {
  const decision = routeLead(
    { geo: { lat: 18.5, lng: -68.5 } },
    dealers,
    locations,
    cfg({ cascade: ['nearest'] }),
  );
  assert.equal(decision.dealerId, 'd-south');
  assert.equal(decision.locationId, 'l-south');
  assert.equal(decision.stage, 'nearest');
  assert.equal(decision.reason, 'nearest:routed');
  assert.ok(decision.distanceKm !== null && decision.distanceKm < 20);
});

test('nearest never routes to an INACTIVE dealer, however close it is', () => {
  // l-closed sits between the two and would win on distance alone.
  const decision = routeLead({ geo: { lat: 18.5, lng: -69.0 } }, dealers, locations, cfg({ cascade: ['nearest'] }));
  assert.notEqual(decision.dealerId, 'd-closed');
  assert.equal(decision.outcome, 'routed');
});

test('nearest without a position falls THROUGH — geo is optional, not assumed', () => {
  const decision = routeLead({}, dealers, locations, cfg({ cascade: ['nearest'] }));
  assert.equal(decision.dealerId, null);
  assert.equal(decision.reason, 'nearest:no-geo');
});

test('nearest resolves a postal code through the brand centroid table', () => {
  const config = cfg({
    cascade: ['nearest'],
    postalCentroids: { '23000': { lat: 18.58, lng: -68.40 } },
  });
  assert.deepEqual(leadGeo({ postalCode: '23 000' }, config), { lat: 18.58, lng: -68.4 });
  const decision = routeLead({ postalCode: '23000' }, dealers, locations, config);
  assert.equal(decision.dealerId, 'd-south');
  // An unknown code is still no position — never the table's first entry.
  assert.equal(routeLead({ postalCode: '99999' }, dealers, locations, config).reason, 'nearest:no-geo');
});

test('nearest beyond maxDistanceKm is OUT OF RANGE, not "close enough"', () => {
  const config = cfg({ cascade: ['nearest', 'manual'], maxDistanceKm: 50 });
  const decision = routeLead({ geo: { lat: 40.7, lng: -74.0 } }, dealers, locations, config);
  assert.equal(decision.dealerId, null);
  assert.equal(decision.reason, 'manual:manual');
  const step = decision.trace.find((s) => s.stage === 'nearest')!;
  assert.equal(step.outcome, 'out-of-range');
  assert.ok(step.distanceKm !== null && step.distanceKm! > 50, 'the rejected distance is reported, not hidden');
});

test('nearest ignores locations with junk coordinates instead of crashing on them', () => {
  const broken: RoutableLocation[] = [
    { id: 'l-junk', dealerId: 'd-north', lat: Number.NaN, lng: 0 },
    { id: 'l-null', dealerId: 'd-north', lat: null, lng: null },
    { id: 'l-south', dealerId: 'd-south', lat: PC.lat, lng: PC.lng },
  ];
  const decision = routeLead({ geo: SD }, dealers, broken, cfg({ cascade: ['nearest'] }));
  assert.equal(decision.dealerId, 'd-south');
  assert.equal(decision.locationId, 'l-south');
});

test('nearest ties break by routingPriority, then by id — never by row order', () => {
  const twins: RoutableLocation[] = [
    { id: 'l-b', dealerId: 'd-south', lat: 0, lng: 0, routingPriority: 5 },
    { id: 'l-a', dealerId: 'd-north', lat: 0, lng: 0, routingPriority: 5 },
  ];
  const first = routeLead({ geo: { lat: 0, lng: 0 } }, dealers, twins, cfg({ cascade: ['nearest'] }));
  const second = routeLead({ geo: { lat: 0, lng: 0 } }, dealers, [...twins].reverse(), cfg({ cascade: ['nearest'] }));
  assert.equal(first.locationId, 'l-a');
  assert.deepEqual(first.dealerId, second.dealerId);

  const ranked: RoutableLocation[] = [
    { id: 'l-a', dealerId: 'd-north', lat: 0, lng: 0, routingPriority: 1 },
    { id: 'l-b', dealerId: 'd-south', lat: 0, lng: 0, routingPriority: 9 },
  ];
  assert.equal(routeLead({ geo: { lat: 0, lng: 0 } }, dealers, ranked, cfg({ cascade: ['nearest'] })).dealerId, 'd-south');
});

/* -------------------------------- territory -------------------------------- */

const territoryLocations: RoutableLocation[] = [
  {
    id: 'l-north',
    dealerId: 'd-north',
    lat: SD.lat,
    lng: SD.lng,
    territory: { kind: 'polygon', polygon: [[-70.2, 18.3], [-69.6, 18.3], [-69.6, 18.7], [-70.2, 18.7]] },
  },
  { id: 'l-south', dealerId: 'd-south', lat: PC.lat, lng: PC.lng, territory: { kind: 'radiusKm', radiusKm: 40 } },
];

test('territory: a polygon claims its own, a radius claims its circle', () => {
  const north = routeLead({ geo: SD }, dealers, territoryLocations, cfg({ cascade: ['territory'] }));
  assert.equal(north.dealerId, 'd-north');
  assert.equal(north.reason, 'territory:routed');

  const south = routeLead({ geo: { lat: 18.6, lng: -68.5 } }, dealers, territoryLocations, cfg({ cascade: ['territory'] }));
  assert.equal(south.dealerId, 'd-south');
  assert.equal(south.locationId, 'l-south');
});

test('territory: outside every territory is `no-territory`, and the cascade continues', () => {
  const only = routeLead({ geo: { lat: 19.8, lng: -71.7 } }, dealers, territoryLocations, cfg({ cascade: ['territory'] }));
  assert.equal(only.dealerId, null);
  assert.equal(only.reason, 'territory:no-territory');

  // …and with a fallback stage behind it the lead still lands somewhere.
  const chained = routeLead(
    { geo: { lat: 19.8, lng: -71.7 } },
    dealers,
    territoryLocations,
    cfg({ cascade: ['territory', 'nearest'] }),
  );
  assert.equal(chained.stage, 'nearest');
  assert.equal(chained.dealerId, 'd-north');
  assert.deepEqual(chained.trace.map((s) => `${s.stage}:${s.outcome}`), ['territory:no-territory', 'nearest:routed']);
});

test('territory: overlapping claims resolve by priority, then by distance — deterministically', () => {
  const overlapping: RoutableLocation[] = [
    { id: 'l-far', dealerId: 'd-north', lat: 0.5, lng: 0.5, territory: { kind: 'radiusKm', radiusKm: 500 } },
    { id: 'l-near', dealerId: 'd-south', lat: 0.01, lng: 0.01, territory: { kind: 'radiusKm', radiusKm: 500 } },
  ];
  const byDistance = routeLead({ geo: { lat: 0, lng: 0 } }, dealers, overlapping, cfg({ cascade: ['territory'] }));
  assert.equal(byDistance.dealerId, 'd-south');

  const ranked = overlapping.map((l) => (l.id === 'l-far' ? { ...l, routingPriority: 10 } : l));
  const byPriority = routeLead({ geo: { lat: 0, lng: 0 } }, dealers, ranked, cfg({ cascade: ['territory'] }));
  assert.equal(byPriority.dealerId, 'd-north');
});

test('territory: a junk territory is simply not a claim', () => {
  const junk: RoutableLocation[] = [
    { id: 'l-north', dealerId: 'd-north', lat: SD.lat, lng: SD.lng, territory: { kind: 'radiusKm', radiusKm: -1 } },
    { id: 'l-south', dealerId: 'd-south', lat: PC.lat, lng: PC.lng, territory: 'everything' },
  ];
  assert.equal(routeLead({ geo: SD }, dealers, junk, cfg({ cascade: ['territory'] })).reason, 'territory:no-territory');
});

test('territory: a polygon drawn across the antimeridian still claims its leads', () => {
  const pacific: RoutableLocation[] = [{
    id: 'l-pac',
    dealerId: 'd-north',
    lat: -17,
    lng: 179.5,
    territory: { kind: 'polygon', polygon: [[178, -18], [-178, -18], [-178, -16], [178, -16]] },
  }];
  const inside = routeLead({ geo: { lat: -17, lng: -179.5 } }, dealers, pacific, cfg({ cascade: ['territory'] }));
  assert.equal(inside.dealerId, 'd-north');
  const outside = routeLead({ geo: { lat: -17, lng: 100 } }, dealers, pacific, cfg({ cascade: ['territory'] }));
  assert.equal(outside.dealerId, null);
});

/* ------------------------------- round-robin ------------------------------- */

test('round-robin is deterministic: the same key always lands on the same dealer', () => {
  const config = cfg({ cascade: ['round-robin'] });
  const first = routeLead({ dedupeKey: 'lead-42' }, dealers, locations, config);
  for (let i = 0; i < 25; i++) {
    assert.equal(routeLead({ dedupeKey: 'lead-42' }, dealers, locations, config).dealerId, first.dealerId);
  }
  assert.equal(first.reason, 'round-robin:routed');
  assert.equal(first.locationId, null, 'a round-robin decision names a dealer, not a showroom');
});

test('round-robin does not depend on the order the dealers came back', () => {
  const config = cfg({ cascade: ['round-robin'] });
  const forward = routeLead({ dedupeKey: 'lead-7' }, dealers, locations, config);
  const reversed = routeLead({ dedupeKey: 'lead-7' }, [...dealers].reverse(), locations, config);
  assert.equal(forward.dealerId, reversed.dealerId);
});

test('round-robin actually SPREADS — a hash that always answered the same is not one', () => {
  const config = cfg({ cascade: ['round-robin'] });
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const d = routeLead({ dedupeKey: `lead-${i}` }, dealers, locations, config).dealerId;
    if (d) seen.add(d);
  }
  assert.deepEqual([...seen].sort(), ['d-north', 'd-south']);
});

test('round-robin without a stable key falls through — it never invents one', () => {
  const config = cfg({ cascade: ['round-robin', 'manual'] });
  const decision = routeLead({ geo: SD }, dealers, locations, config);
  assert.equal(decision.dealerId, null);
  assert.equal(decision.trace[0]!.outcome, 'no-key');
  assert.equal(decision.reason, 'manual:manual');
  // The lead's own id serves when there is no dedupe key.
  assert.equal(routingKeyOf({ id: 'lead-x' }), 'lead-x');
  assert.equal(routingKeyOf({ dedupeKey: '  ' }), null);
  assert.equal(routeLead({ id: 'lead-x' }, dealers, locations, config).outcome, 'routed');
});

/* ---------------------------------- manual --------------------------------- */

test('manual terminates the cascade — a stage behind it is never run', () => {
  const decision = routeLead(
    { geo: SD },
    dealers,
    locations,
    cfg({ cascade: ['manual', 'nearest'] }),
  );
  assert.equal(decision.dealerId, null);
  assert.equal(decision.outcome, 'manual');
  assert.deepEqual(decision.trace.map((s) => s.stage), ['manual']);
});

/* --------------------------------- the pin --------------------------------- */

test('a lead that names its dealer is honoured before the cascade', () => {
  const decision = routeLead({ dealerSlug: 'south', geo: SD }, dealers, locations, cfg({ cascade: ['nearest'] }));
  assert.equal(decision.dealerId, 'd-south');
  assert.equal(decision.stage, 'pinned');
  assert.equal(decision.locationId, 'l-south');
  assert.ok(decision.distanceKm !== null);
});

test('an unresolvable or inactive pin falls THROUGH to the cascade, and says so', () => {
  const typo = routeLead({ dealerSlug: 'sout', geo: SD }, dealers, locations, cfg({ cascade: ['nearest'] }));
  assert.equal(typo.dealerId, 'd-north');
  assert.equal(typo.trace[0]!.stage, 'pinned');
  assert.equal(typo.trace[0]!.outcome, 'no-dealers');

  const retired = routeLead({ dealerSlug: 'closed', geo: SD }, dealers, locations, cfg({ cascade: ['nearest'] }));
  assert.equal(retired.dealerId, 'd-north');
});

test('honorPinnedDealer:false ignores the pin entirely', () => {
  const decision = routeLead(
    { dealerSlug: 'south', geo: SD },
    dealers,
    locations,
    cfg({ cascade: ['nearest'], honorPinnedDealer: false }),
  );
  assert.equal(decision.dealerId, 'd-north');
  assert.deepEqual(decision.trace.map((s) => s.stage), ['nearest']);
});

/* ------------------------------- the failures ------------------------------ */

test('an empty dealer list routes NOTHING, with a reason', () => {
  const decision = routeLead({ geo: SD }, [], [], cfg({ cascade: ['territory', 'nearest'] }));
  assert.equal(decision.dealerId, null);
  assert.equal(decision.dealerSlug, null);
  assert.equal(decision.locationId, null);
  assert.equal(decision.stage, null);
  assert.equal(decision.reason, 'nearest:no-dealers');
  assert.deepEqual(decision.trace.map((s) => s.outcome), ['no-dealers', 'no-dealers']);
});

test('dealers with no locations at all: `no-location`, never a coin flip', () => {
  const decision = routeLead({ geo: SD }, dealers, [], cfg({ cascade: ['nearest'] }));
  assert.equal(decision.dealerId, null);
  assert.equal(decision.reason, 'nearest:no-location');
});

test('an empty cascade cannot silently disable routing — it falls back to the default', () => {
  // A config with no stages is a config someone broke, not a brand asking for
  // every lead to be dropped on the floor. The default cascade takes over.
  const decision = routeLead({ geo: SD }, dealers, locations, { ...cfg(), cascade: [] });
  assert.equal(decision.dealerId, 'd-north');
  assert.deepEqual(decision.trace.map((s) => s.stage), DEFAULT_ROUTING_CASCADE.slice(0, 2));
});

test('routeLead never throws, whatever it is handed', () => {
  const junk = [null, undefined, {}, { id: 1 }, 'dealer'] as unknown as RoutableDealer[];
  const junkLocations = [null, { id: 'x' }, { dealerId: 'd-north' }] as unknown as RoutableLocation[];
  assert.doesNotThrow(() => routeLead(null, null, null, null));
  assert.doesNotThrow(() => routeLead({} as never, junk, junkLocations, 'nonsense'));
  assert.doesNotThrow(() => routeLead({ geo: { lat: 'x' } as never }, dealers, junkLocations, { cascade: 42 }));
  assert.equal(routeLead(null, null, null, null).dealerId, null);
});

/* --------------------------------- the stamp ------------------------------- */

test('routingStamp is the compact, storable reason — never the whole trace', () => {
  const decision = routeLead({ geo: { lat: 18.5, lng: -68.5 } }, dealers, locations, cfg({ cascade: ['nearest'] }));
  const stamp = routingStamp(decision, new Date('2026-08-01T12:00:00.000Z'));
  assert.equal(stamp.policy, 'nearest');
  assert.equal(stamp.outcome, 'routed');
  assert.equal(stamp.reason, 'nearest:routed');
  assert.equal(stamp.at, '2026-08-01T12:00:00.000Z');
  assert.equal(stamp.distanceKm, Math.round(decision.distanceKm! * 100) / 100);
  assert.deepEqual(Object.keys(stamp).sort(), ['at', 'distanceKm', 'outcome', 'policy', 'reason']);
  // It survives a JSON round trip — it is stored as jsonb on the lead.
  assert.deepEqual(JSON.parse(JSON.stringify(stamp)), stamp);
});

test('routingStamp of an unrouted lead still carries WHY', () => {
  const decision = routeLead({}, dealers, locations, cfg({ cascade: ['territory', 'manual'] }));
  const stamp = routingStamp(decision, 0);
  assert.equal(stamp.policy, null);
  assert.equal(stamp.outcome, 'manual');
  assert.equal(stamp.reason, 'manual:manual');
  assert.equal(stamp.at, new Date(0).toISOString());
});
