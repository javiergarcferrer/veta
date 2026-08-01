/**
 * DEALERS — the network editor.
 *
 * Pinned: the money levers can never be written junk (the form says no AND the
 * engine's own sanitizer decides what is stored), a slug is an address (unique,
 * shaped, and renaming WARNS instead of silently breaking embeds), half a
 * coordinate is not a place, and the board's counts come from the same rows the
 * other panels render.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dealerDraftOf,
  emptyDealerDraft,
  emptyLocationDraft,
  locationDraftOf,
  locationsOf,
  parsePolygonText,
  pricingLabel,
  resolveDealerList,
  slugify,
  validateDealer,
  validateLocation,
} from '../src/vm/index.ts';
import type { AdminDealer, AdminLead, AdminLocation } from '../src/vm/index.ts';

const dealer = (over: Partial<AdminDealer> = {}): AdminDealer => ({
  id: 'd-1',
  slug: 'santo-domingo',
  name: 'Santo Domingo',
  status: 'active',
  locale: 'es',
  currency: 'USD',
  pricing: { mode: 'full', multiplier: 1 },
  contact: {},
  updatedAt: 0,
  ...over,
});

const draft = (over: Partial<ReturnType<typeof emptyDealerDraft>> = {}) => ({
  ...emptyDealerDraft('d-1'),
  name: 'Santo Domingo',
  slug: 'santo-domingo',
  ...over,
});

/* --------------------------------- slugify --------------------------------- */

test('slugify makes an address out of a name — accents folded, spaces hyphened', () => {
  assert.equal(slugify('Muebles Peña & Cía'), 'muebles-pena-cia');
  assert.equal(slugify('  Santo   Domingo  '), 'santo-domingo');
  assert.equal(slugify('---'), '');
  assert.equal(slugify('A'.repeat(80)).length, 60);
});

/* ------------------------------ validateDealer ----------------------------- */

test('a dealer needs a name and a slug', () => {
  const result = validateDealer(draft({ name: '', slug: '' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.name);
  assert.ok(result.errors.slug);
  assert.equal(result.value, null);
});

test('a slug is lower-case, hyphenated and unique in the brand', () => {
  assert.ok(validateDealer(draft({ slug: 'Santo Domingo' })).errors.slug);
  assert.ok(validateDealer(draft({ slug: '-leading' })).errors.slug);
  const taken = validateDealer(draft({ id: 'd-2', slug: 'santo-domingo' }), [dealer()]);
  assert.equal(taken.ok, false);
  assert.match(taken.errors.slug!, /already uses/);
  // …and an edit never collides with itself.
  assert.equal(validateDealer(draft(), [dealer()]).ok, true);
});

test('renaming a slug WARNS about live embeds instead of refusing the edit', () => {
  const result = validateDealer(draft({ slug: 'sd-nuevo' }), [dealer()]);
  assert.equal(result.ok, true);
  assert.equal(result.value!.slug, 'sd-nuevo');
  assert.match(result.warnings.join(' '), /breaks existing embeds/);
});

test('the multiplier is refused at the form AND sanitized on the way out', () => {
  for (const bad of ['', '0', '-2', 'gratis']) {
    assert.equal(validateDealer(draft({ multiplier: bad })).ok, false, `${bad} was accepted`);
  }
  const ok = validateDealer(draft({ multiplier: '1.35' }));
  assert.equal(ok.value!.pricing.multiplier, 1.35);
  // A big-but-valid markup is a warning, not a wall — some networks really do
  // sell at ×3, and a false refusal is worse than a flagged save.
  const large = validateDealer(draft({ multiplier: '9' }));
  assert.equal(large.ok, true);
  assert.match(large.warnings.join(' '), /very large markup/);
});

test('the pricing mode goes through the engine’s own validator', () => {
  const result = validateDealer(draft({ pricingMode: 'invented' as never }));
  assert.equal(result.ok, true);
  assert.equal(result.value!.pricing.mode, 'full', 'an unknown mode must fall back, never be stored');
  assert.equal(validateDealer(draft({ pricingMode: 'hidden' })).value!.pricing.mode, 'hidden');
});

test('a currency is a three-letter ISO code', () => {
  assert.ok(validateDealer(draft({ currency: 'dollars' })).errors.currency);
  assert.equal(validateDealer(draft({ currency: 'dop' })).value!.currency, 'DOP');
});

test('an empty contact stays empty — no null holes in the stored document', () => {
  const value = validateDealer(draft()).value!;
  assert.deepEqual(value.contact, {});
  const withEmail = validateDealer(draft({ contactEmail: ' ventas@sd.do ' })).value!;
  assert.deepEqual(withEmail.contact, { email: 'ventas@sd.do' });
});

test('dealerDraftOf ∘ validateDealer round-trips a stored dealer', () => {
  const stored = dealer({ pricing: { mode: 'from', multiplier: 1.5 }, contact: { email: 'a@b.do' } });
  const result = validateDealer(dealerDraftOf(stored), [stored], { now: 99 });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.value!, updatedAt: 0 }, { ...stored, updatedAt: 0 });
  assert.equal(result.value!.updatedAt, 99);
});

/* ----------------------------- validateLocation ---------------------------- */

const locDraft = (over: Partial<ReturnType<typeof emptyLocationDraft>> = {}) => ({
  ...emptyLocationDraft('l-1', 'd-1'),
  name: 'Showroom',
  ...over,
});

test('half a coordinate is not a place', () => {
  assert.ok(validateLocation(locDraft({ lat: '18.47' })).errors.lat);
  assert.ok(validateLocation(locDraft({ lng: '-69.9' })).errors.lat);
  const both = validateLocation(locDraft({ lat: '18.47', lng: '-69.9' }));
  assert.equal(both.ok, true);
  assert.deepEqual([both.value!.lat, both.value!.lng], [18.47, -69.9]);
  // …and no coordinates at all is fine: an address-only listing.
  assert.equal(validateLocation(locDraft()).ok, true);
  assert.equal(validateLocation(locDraft()).value!.lat, null);
});

test('coordinates are refused outside the globe', () => {
  assert.ok(validateLocation(locDraft({ lat: '91', lng: '0' })).errors.lat);
  assert.ok(validateLocation(locDraft({ lat: '0', lng: '181' })).errors.lng);
});

test('a radius territory needs a positive radius AND the location’s position', () => {
  assert.ok(validateLocation(locDraft({ territoryKind: 'radiusKm', radiusKm: '0' })).errors.radiusKm);
  assert.ok(validateLocation(locDraft({ territoryKind: 'radiusKm', radiusKm: '25' })).errors.radiusKm,
    'a radius with no centre was accepted');
  const ok = validateLocation(locDraft({ lat: '18.47', lng: '-69.9', territoryKind: 'radiusKm', radiusKm: '25' }));
  assert.deepEqual(ok.value!.territory, { kind: 'radiusKm', radiusKm: 25 });
});

test('a polygon needs three readable points, and a junk line is NAMED', () => {
  const bad = validateLocation(locDraft({ territoryKind: 'polygon', polygon: '18,-69\nnorth a bit\n19,-70' }));
  assert.match(bad.errors.polygon!, /line 2/);
  const short = validateLocation(locDraft({ territoryKind: 'polygon', polygon: '18,-69\n19,-70' }));
  assert.match(short.errors.polygon!, /three points/);
  const ok = validateLocation(locDraft({ territoryKind: 'polygon', polygon: '18,-69\n19,-70\n19,-69' }));
  assert.equal(ok.value!.territory!.kind, 'polygon');
  assert.equal((ok.value!.territory as { polygon: unknown[] }).polygon.length, 3);
});

test('parsePolygonText skips blanks and reports only real junk', () => {
  const { points, bad } = parsePolygonText('18,-69\n\n  \n19 -70\n99,-70');
  assert.deepEqual(points, [{ lat: 18, lng: -69 }, { lat: 19, lng: -70 }]);
  assert.deepEqual(bad, [5]);
});

test('a location that can never win a routing decision says so', () => {
  const result = validateLocation(locDraft());
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /never wins a routing decision/);
});

test('locationDraftOf ∘ validateLocation round-trips a polygon', () => {
  const stored: AdminLocation = {
    id: 'l-1',
    dealerId: 'd-1',
    name: 'Zona Colonial',
    lat: 18.47,
    lng: -69.88,
    territory: { kind: 'polygon', polygon: [{ lat: 18, lng: -70 }, { lat: 19, lng: -70 }, { lat: 19, lng: -69 }] },
    address: { line1: 'El Conde 1', city: 'Santo Domingo' },
    hours: { text: '9-18' },
    routingPriority: 3,
    updatedAt: 0,
  };
  const result = validateLocation(locationDraftOf(stored), { now: 7 });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.value!, updatedAt: 0 }, stored);
});

/* -------------------------------- the board -------------------------------- */

const lead = (over: Partial<AdminLead> = {}): AdminLead => ({
  id: 'lead-1',
  dealerId: 'd-1',
  contact: { name: 'Ana' },
  note: null,
  status: 'pending',
  verdict: null,
  estimate: null,
  build: null,
  source: {},
  createdAt: 1,
  ...over,
});

test('the dealers board counts locations, routable locations and open leads', () => {
  const dealers = [dealer(), dealer({ id: 'd-2', slug: 'punta-cana', name: 'Punta Cana' })];
  const locations: AdminLocation[] = [
    { id: 'l-1', dealerId: 'd-1', name: 'A', lat: 18, lng: -69, territory: null, address: {}, hours: {}, routingPriority: 0, updatedAt: 0 },
    { id: 'l-2', dealerId: 'd-1', name: 'B', lat: null, lng: null, territory: null, address: {}, hours: {}, routingPriority: 0, updatedAt: 0 },
  ];
  const leads = [lead(), lead({ id: 'lead-2', status: 'converted' }), lead({ id: 'lead-3', dealerId: null })];

  const board = resolveDealerList(dealers, locations, leads);
  const [first, second] = board.rows;
  assert.equal(board.total, 2);
  assert.equal(board.unrouted, 1);
  assert.equal(first!.dealer.id, 'd-2', 'rows sort by name');
  assert.equal(second!.locations, 2);
  assert.equal(second!.routable, 1, 'a location without coordinates or a polygon cannot route');
  assert.equal(second!.leads, 2);
  assert.equal(second!.openLeads, 1);
});

test('the board filters by search and status without touching the totals', () => {
  const dealers = [dealer(), dealer({ id: 'd-2', slug: 'pc', name: 'Punta Cana', status: 'inactive' })];
  const searched = resolveDealerList(dealers, [], [], { search: 'punta' });
  assert.equal(searched.rows.length, 1);
  assert.equal(searched.total, 2);
  const active = resolveDealerList(dealers, [], [], { status: 'active' });
  assert.deepEqual(active.rows.map((r) => r.dealer.id), ['d-1']);
});

test('the pricing label reads as money, and a junk stored lever still reads sanely', () => {
  assert.equal(pricingLabel(dealer()), 'full prices · list price');
  assert.equal(pricingLabel(dealer({ pricing: { mode: 'from', multiplier: 1.5 } })), '“from” prices · ×1.5');
  assert.equal(pricingLabel(dealer({ pricing: { mode: 'hidden', multiplier: 1 } })), 'no prices · list price');
  assert.equal(
    pricingLabel(dealer({ pricing: { mode: 'nonsense', multiplier: 0 } as never })),
    'full prices · list price',
  );
});

test('locationsOf walks a dealer’s locations in routing order', () => {
  const locations: AdminLocation[] = [
    { id: 'l-1', dealerId: 'd-1', name: 'B', lat: null, lng: null, territory: null, address: {}, hours: {}, routingPriority: 1, updatedAt: 0 },
    { id: 'l-2', dealerId: 'd-1', name: 'A', lat: null, lng: null, territory: null, address: {}, hours: {}, routingPriority: 9, updatedAt: 0 },
    { id: 'l-3', dealerId: 'd-2', name: 'C', lat: null, lng: null, territory: null, address: {}, hours: {}, routingPriority: 9, updatedAt: 0 },
  ];
  assert.deepEqual(locationsOf(locations, 'd-1').map((l) => l.id), ['l-2', 'l-1']);
});
