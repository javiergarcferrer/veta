/**
 * THE STORE SEAM.
 *
 * The in-memory store is a real implementation, so the whole admin workflow is
 * testable without a project or a credential. What is pinned here is the
 * behaviour the workflow can tell the difference about:
 *
 *   • a save returns the STORED row and reads hand out COPIES (a caller that
 *     mutates what it listed must not silently edit the store);
 *   • deleting a dealer takes its locations and UNROUTES its leads — never
 *     deletes them, exactly like the `on delete set null` server-side;
 *   • issuing a key is the ONLY call that yields a token, and what the store
 *     keeps afterwards has no credential material in it;
 *   • revoking stamps, it does not delete.
 *
 * The supabase adapter is exercised through its row MAPPING only — that is the
 * part that must agree with the types; nothing here pretends it has run against
 * a live project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdminStore } from '../src/store/index.ts';
import { dealerFromRow, dealerToRow, leadFromRow, locationFromRow, locationToRow } from '../src/store/index.ts';
import { validateRoutingDraft, routingDraftOf } from '../src/vm/index.ts';
import type { AdminDealer, AdminLead, AdminLocation } from '../src/vm/index.ts';

const dealer = (over: Partial<AdminDealer> = {}): AdminDealer => ({
  id: 'd-1',
  slug: 'sd',
  name: 'Santo Domingo',
  status: 'active',
  locale: 'es',
  currency: 'USD',
  pricing: { mode: 'full', multiplier: 1 },
  contact: { email: 'ventas@sd.do' },
  updatedAt: 0,
  ...over,
});

const location = (over: Partial<AdminLocation> = {}): AdminLocation => ({
  id: 'l-1',
  dealerId: 'd-1',
  name: 'Naco',
  lat: 18.47,
  lng: -69.93,
  territory: { kind: 'radiusKm', radiusKm: 30 },
  address: { city: 'Santo Domingo' },
  hours: { text: '9-18' },
  routingPriority: 0,
  updatedAt: 0,
  ...over,
});

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

const store = (over: Parameters<typeof createMemoryAdminStore>[0] = {}) =>
  createMemoryAdminStore({ now: () => 1000, uid: () => 'abcd1234', ...over });

/* --------------------------------- the rows -------------------------------- */

test('a save returns the STORED row, stamped', async () => {
  const s = store();
  const saved = await s.saveDealer(dealer());
  assert.equal(saved.updatedAt, 1000);
  assert.deepEqual((await s.listDealers()).map((d) => d.id), ['d-1']);
});

test('reads hand out copies — a caller cannot edit the store by mutating a list', async () => {
  const s = store({ dealers: [dealer()] });
  const [row] = await s.listDealers();
  row!.name = 'Mutated';
  row!.pricing.multiplier = 99;
  const [again] = await s.listDealers();
  assert.equal(again!.name, 'Santo Domingo');
  assert.equal(again!.pricing.multiplier, 1);
});

test('deleting a dealer takes its locations and UNROUTES its leads', async () => {
  const s = store({
    dealers: [dealer(), dealer({ id: 'd-2', slug: 'pc' })],
    locations: [location(), location({ id: 'l-2', dealerId: 'd-2' })],
    leads: [lead(), lead({ id: 'lead-2', dealerId: 'd-2' })],
  });
  await s.deleteDealer('d-1');
  const snapshot = s.snapshot();
  assert.deepEqual(snapshot.dealers.map((d) => d.id), ['d-2']);
  assert.deepEqual(snapshot.locations.map((l) => l.id), ['l-2']);
  // The lead outlives the dealer — it just becomes unrouted.
  assert.equal(snapshot.leads.length, 2);
  assert.equal(snapshot.leads.find((l) => l.id === 'lead-1')!.dealerId, null);
});

test('a status move and an assignment both return the row as stored', async () => {
  const s = store({ leads: [lead()] });
  assert.equal((await s.setLeadStatus('lead-1', 'contacted')).status, 'contacted');
  assert.equal((await s.assignLead('lead-1', 'd-9')).dealerId, 'd-9');
  assert.equal((await s.assignLead('lead-1', null)).dealerId, null);
  await assert.rejects(() => s.setLeadStatus('ghost', 'contacted'), /No lead ghost/);
});

test('the routing config round-trips through the store as the engine’s document', async () => {
  const s = store();
  const config = validateRoutingDraft(routingDraftOf({ cascade: ['nearest', 'manual'], maxDistanceKm: 60 })).value!;
  await s.saveRoutingConfig(config);
  assert.deepEqual(await s.loadRoutingConfig(), config);
  assert.deepEqual(routingDraftOf(await s.loadRoutingConfig()).maxDistanceKm, '60');
});

/* -------------------------------- the keys --------------------------------- */

test('issuing is the ONE call that yields a token — and the store keeps none of it', async () => {
  const s = store();
  const issued = await s.issueApiKey({ kind: 'secret', scopes: ['leads:read'], allowedOrigins: [] });
  assert.match(issued.token, /^sk_live_/);
  assert.equal(issued.key.kind, 'secret');

  const kept = await s.listApiKeys();
  assert.equal(kept.length, 1);
  const serialized = JSON.stringify(kept);
  assert.equal(serialized.includes(issued.token), false, 'the stored row carries the whole token');
  assert.equal(serialized.includes('keyHash'), false);
  assert.ok(issued.token.startsWith(kept[0]!.prefix.replace('…', '')));
});

test('a publishable key is issued with a pk_ token, and its scopes are kept verbatim', async () => {
  const s = store();
  const issued = await s.issueApiKey({
    kind: 'publishable',
    scopes: ['catalog:read', 'leads:write'],
    allowedOrigins: ['https://shop.example'],
  });
  assert.match(issued.token, /^pk_live_/);
  assert.deepEqual(issued.key.scopes, ['catalog:read', 'leads:write']);
  assert.deepEqual(issued.key.allowedOrigins, ['https://shop.example']);
});

test('revoking stamps, it does not delete', async () => {
  const s = store();
  const issued = await s.issueApiKey({ kind: 'publishable', scopes: ['catalog:read'], allowedOrigins: [] });
  await s.revokeApiKey(issued.key.id);
  const [row] = await s.listApiKeys();
  assert.equal(row!.id, issued.key.id);
  assert.equal(row!.revokedAt, 1000);
  await assert.rejects(() => s.revokeApiKey('ghost'), /No api key ghost/);
});

/* ------------------------------ the row mapping ---------------------------- */

test('the supabase adapter maps a dealer row both ways', () => {
  const row = {
    id: 'd-1',
    slug: 'sd',
    name: 'Santo Domingo',
    status: 'inactive',
    locale: 'es',
    currency: 'DOP',
    pricing: { mode: 'from', multiplier: 1.4 },
    contact: { email: 'a@b.do' },
    updated_at: '2026-07-01T00:00:00.000Z',
  };
  const mapped = dealerFromRow(row);
  assert.equal(mapped.status, 'inactive');
  assert.deepEqual(mapped.pricing, { mode: 'from', multiplier: 1.4 });
  assert.equal(mapped.updatedAt, Date.parse(row.updated_at));

  const back = dealerToRow(mapped, 'org-1', 'brand-1');
  assert.equal(back.org_id, 'org-1');
  assert.equal(back.brand_id, 'brand-1');
  assert.deepEqual(back.pricing, mapped.pricing);
});

test('an unknown pricing mode from the database reads as full, never as junk', () => {
  assert.equal(dealerFromRow({ id: 'd', pricing: { mode: 'wholesale' } }).pricing.mode, 'full');
  assert.equal(dealerFromRow({ id: 'd', status: 'weird' }).status, 'active');
});

test('a location row keeps null coordinates null — Number(null) is 0, and 0,0 is a real place', () => {
  const mapped = locationFromRow({ id: 'l', dealer_id: 'd', lat: null, lng: null, routing_priority: 3 });
  assert.equal(mapped.lat, null);
  assert.equal(mapped.lng, null);
  assert.equal(mapped.routingPriority, 3);
  assert.equal(mapped.territory, null);
  assert.equal(locationFromRow({ id: 'l', dealer_id: 'd', lat: '18.47' }).lat, 18.47);
  assert.equal(locationToRow(location(), 'org-1').org_id, 'org-1');
  assert.deepEqual(locationToRow(location(), 'org-1').territory, { kind: 'radiusKm', radiusKm: 30 });
});

test('a lead row maps its minor-unit estimate and its unknown status defensively', () => {
  const mapped = leadFromRow({
    id: 'lead-1',
    dealer_id: null,
    contact: { name: 'Ana' },
    status: 'unheard-of',
    estimate: { amount_minor: 12_345, currency: 'DOP' },
    source: { routing: { reason: 'nearest:routed' } },
    created_at: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(mapped.dealerId, null);
  assert.equal(mapped.status, 'pending');
  assert.deepEqual(mapped.estimate, { amountMinor: 12_345, currency: 'DOP' });
  assert.equal(mapped.source.routing!.reason, 'nearest:routed');
  assert.equal(leadFromRow({ id: 'x', estimate: {} }).estimate, null);
});
