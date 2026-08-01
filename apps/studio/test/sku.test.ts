// SKU BINDING — the allocation rules, and the one thing that must never leak:
// a PRICE-NEUTRAL role can never hold a billed slot. The slot list is DERIVED
// from the taxonomy (`UNPRICED_ROLES`), so adding a price-neutral role keeps it
// out of billing for free — and this test is what stops someone restating the
// list by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNT_MAX, MATERIALIZATION_ROLES, UNPRICED_ROLES, partCount } from '@veta/materials';

import { billedSlots, bindBaseProduct, planSkuSlot, resolveSkuBinding, setPartCount, writeSlot } from '../src/vm/sku.ts';
import { emptyModel } from '../src/vm/types.ts';
import type { PartsDraft } from '../src/vm/types.ts';

test('the billed slots are the taxonomy minus base minus the unpriced roles', () => {
  const slots = billedSlots();
  assert.ok(!slots.includes('base'));
  for (const role of UNPRICED_ROLES) assert.ok(!slots.includes(role), `${role} must never bill`);
  for (const zone of MATERIALIZATION_ROLES) assert.ok(!slots.includes(zone));
  assert.deepEqual(slots, ['cushion', 'bolster', 'armCushion']);
});

test('binding takes the first free slot', () => {
  const plan = planSkuSlot({ mats: { legs: 'base' } }, ['cloth'], 'base', 'PART-1');
  assert.equal(plan.role, 'cushion');
});

test('two groups billing the SAME SKU share one slot — one billed line', () => {
  const parts: PartsDraft = { mats: { left: 'cushion', right: 'base' }, roots: { cushion: 'SET-2' } };
  const plan = planSkuSlot(parts, ['right'], 'base', 'SET-2');
  assert.equal(plan.role, 'cushion');
});

test('a group alone in its slot keeps it and rewrites the root', () => {
  const parts: PartsDraft = { mats: { cloth: 'bolster' }, roots: { bolster: 'OLD' } };
  const plan = planSkuSlot(parts, ['cloth'], 'bolster', 'NEW');
  assert.equal(plan.role, 'bolster');
  const next = writeSlot(parts, ['cloth'], plan.role!, 'NEW');
  assert.deepEqual(next.roots, { bolster: 'NEW' });
});

test('a group SHARING a slot detaches instead of re-SKUing its sibling', () => {
  const parts: PartsDraft = { mats: { a: 'cushion', b: 'cushion' }, roots: { cushion: 'SET-2' } };
  const plan = planSkuSlot(parts, ['b'], 'cushion', 'OTHER');
  assert.equal(plan.role, 'bolster', 'it moves to a free slot; the sibling keeps its SKU');
});

test('no slot free is a REFUSAL, and nothing is written', () => {
  const parts: PartsDraft = {
    mats: { a: 'cushion', b: 'bolster', c: 'armCushion', d: 'base' },
    roots: { cushion: '1', bolster: '2', armCushion: '3' },
  };
  const plan = planSkuSlot(parts, ['d'], 'base', 'X');
  assert.ok(plan.error, 'refused');
  assert.match(plan.error!, /At most 3 part SKUs/);
});

test('vacating a slot nobody else holds drops its root AND its count', () => {
  const parts: PartsDraft = {
    mats: { cloth: 'cushion', legs: 'structure' },
    roots: { cushion: 'SET-2' },
    counts: { cushion: 2 },
  };
  const next = writeSlot(parts, ['cloth'], 'base', null);
  assert.equal(next.roots, undefined, 'a stale SKU can never bill on a model without the part');
  assert.equal(next.counts, undefined);
  assert.deepEqual(next.mats, { cloth: 'base', legs: 'structure' });
});

test('a sibling still holding the slot keeps the root', () => {
  const parts: PartsDraft = { mats: { a: 'cushion', b: 'cushion' }, roots: { cushion: 'SET-2' } };
  const next = writeSlot(parts, ['a'], 'base', null);
  assert.deepEqual(next.roots, { cushion: 'SET-2' });
});

test('the typed count SATURATES at the ceiling — a typo can never be staged', () => {
  assert.equal((setPartCount({}, 'cushion', 100000).counts as Record<string, number>).cushion, COUNT_MAX);
  assert.equal((setPartCount({}, 'cushion', -5).counts as Record<string, number>).cushion, 0);
  assert.equal((setPartCount({}, 'cushion', 2.4).counts as Record<string, number>).cushion, 2);
});

test('an unpriced role never bills, whatever is bound or typed', () => {
  const parts: PartsDraft = {
    mats: { legs: 'structure', body: 'exterior' },
    roots: { structure: 'STRUCT-1', exterior: 'ZONE-1' },
    counts: { structure: 4, exterior: 2 },
  };
  assert.equal(partCount(parts, 'structure'), 0);
  assert.equal(partCount(parts, 'exterior'), 0);
  const view = resolveSkuBinding({ ...emptyModel('m', 'M', 1), parts });
  assert.deepEqual(view.slots.map((s) => s.role), ['cushion', 'bolster', 'armCushion']);
});

test('the binding view answers the one question that matters: can this piece price', () => {
  const model = { ...emptyModel('m', 'Prado', 1), parts: { mats: { cloth: 'cushion' }, roots: { cushion: 'SET-2' } } };
  const unbound = resolveSkuBinding(model);
  assert.equal(unbound.quotable, false, 'a part SKU is not a base SKU');
  assert.equal(unbound.boundSlots, 1);
  assert.deepEqual(unbound.freeSlots, ['bolster', 'armCushion']);

  const bound = resolveSkuBinding(bindBaseProduct(model, '10574010', 2));
  assert.equal(bound.quotable, true);
  assert.equal(bound.baseRoot, '10574010');
});
