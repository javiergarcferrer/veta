import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PLANS,
  METER_KINDS,
  isActivatablePlan,
  moneyFromMajor,
  moneyToMajor,
  parsePlan,
  parsePlans,
  planById,
  rateFromMajor,
  MAX_BASE_MINOR,
} from '../src/index.ts';
import type { Plan } from '../src/index.ts';

// ── The price sheet itself ───────────────────────────────────────────────

test('DEFAULT_PLANS are placeholder-flagged and denominated in integer minor units', () => {
  assert.equal(DEFAULT_PLANS.length, 3);
  for (const plan of DEFAULT_PLANS) {
    assert.equal(plan.placeholderPricing, true, `${plan.id} must be marked placeholder`);
    assert.equal(plan.base.currency, 'USD');
    assert.ok(Number.isSafeInteger(plan.base.amount), `${plan.id} base must be an integer`);
    for (const rate of Object.values(plan.overage)) {
      assert.ok(Number.isSafeInteger(rate), `${plan.id} rates must be integers`);
    }
    for (const allowance of Object.values(plan.included)) {
      assert.ok(Number.isSafeInteger(allowance) && allowance >= 0);
    }
  }
});

test('the ladder is coherent: allowances rise, per-unit rates fall', () => {
  const [starter, growth, scale] = DEFAULT_PLANS as readonly Plan[];
  assert.ok(starter.base.amount < growth.base.amount);
  assert.ok(growth.base.amount < scale.base.amount);
  assert.ok(starter.included.sessions < growth.included.sessions);
  assert.ok(growth.included.renders < scale.included.renders);
  // A bigger plan must never charge MORE per overage unit than a smaller one —
  // that would make the cheaper plan cheaper at every volume.
  assert.ok(starter.overage.session >= growth.overage.session);
  assert.ok(growth.overage.session >= scale.overage.session);
  assert.ok(starter.overage.render >= growth.overage.render);
  assert.ok(growth.overage.modelLive >= scale.overage.modelLive);
});

test('every shipped plan survives its own validator with nothing dropped', () => {
  for (const plan of DEFAULT_PLANS) {
    const parsed = parsePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(parsed.dropped, [], `${plan.id}: ${JSON.stringify(parsed.dropped)}`);
    assert.deepEqual(parsed.plan, plan);
    assert.equal(isActivatablePlan(parsed), true);
  }
});

test('planById finds by id and refuses junk', () => {
  assert.equal(planById('growth')?.name, 'Growth');
  assert.equal(planById('nope'), null);
  assert.equal(planById(''), null);
  assert.equal(planById(null), null);
  assert.equal(planById(undefined), null);
});

// ── Money at the authoring boundary ──────────────────────────────────────

test('major↔minor crossing delegates to @veta/catalog and round-trips', () => {
  assert.deepEqual(moneyFromMajor(99, 'USD'), { amount: 9900, currency: 'USD' });
  assert.deepEqual(moneyFromMajor(1_499, 'usd'), { amount: 149_900, currency: 'USD' });
  // Zero-decimal currency: 1 unit IS the smallest amount.
  assert.deepEqual(moneyFromMajor(990, 'JPY'), { amount: 990, currency: 'JPY' });
  assert.equal(moneyToMajor({ amount: 9900, currency: 'USD' }), 99);
  assert.equal(rateFromMajor(0.05, 'USD'), 5);
  assert.equal(rateFromMajor(0.22, 'USD'), 22);
  // The binary-dust case the shared helper exists to get right.
  assert.equal(rateFromMajor(1.115, 'USD'), 112);
});

// ── Validation: refusals ─────────────────────────────────────────────────

const GOOD: Record<string, unknown> = {
  id: 'test',
  name: 'Test',
  base: { amount: 1000, currency: 'USD' },
  included: { sessions: 10, renders: 5, modelsLive: 2 },
  overage: { session: 1, render: 2, modelLive: 3 },
  limits: { seats: 2, collections: 1, hardModelsLive: 9, overageCapMinor: 500 },
};

function withBase(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...GOOD, ...patch };
}

test('a plan we cannot price is refused outright', () => {
  const cases: [unknown, string][] = [
    [null, ''],
    ['starter', ''],
    [[], ''],
    [withBase({ id: '' }), 'id'],
    [withBase({ id: 'has space' }), 'id'],
    [withBase({ base: undefined }), 'base'],
    [withBase({ base: { amount: 1000 } }), 'base.currency'],
    [withBase({ base: { amount: 1000, currency: 'DOLLARS' } }), 'base.currency'],
    [withBase({ base: { amount: 99.5, currency: 'USD' } }), 'base.amount'],
    [withBase({ base: { amount: -1, currency: 'USD' } }), 'base.amount'],
    [withBase({ base: { amount: MAX_BASE_MINOR + 1, currency: 'USD' } }), 'base.amount'],
    [withBase({ interval: 'year' }), 'interval'],
  ];
  for (const [raw, path] of cases) {
    const res = parsePlan(raw);
    assert.equal(res.plan, null, `expected refusal for ${JSON.stringify(raw)}`);
    assert.ok(res.dropped.length > 0);
    assert.equal(res.dropped[res.dropped.length - 1].path, path);
    assert.equal(isActivatablePlan(res), false);
  }
});

test('a float base amount is refused, never rounded — that would launder a 100x error', () => {
  const res = parsePlan(withBase({ base: { amount: 99.0001, currency: 'USD' } }));
  assert.equal(res.plan, null);
  assert.match(res.dropped[0].reason, /non-negative integer of minor units/);
});

// ── Validation: lenient at read, never silent ────────────────────────────

test('a junk field falls back AND is reported', () => {
  const res = parsePlan({
    id: 'lenient',
    base: { amount: 500, currency: 'USD' },
    included: { sessions: -4, renders: 'lots', modelsLive: 3 },
    overage: { session: 1.5, render: 2, modelLive: 3 },
    limits: { seats: 'two', collections: 4, hardModelsLive: 'none', overageCapMinor: null },
  });
  assert.ok(res.plan);
  const plan = res.plan as Plan;
  assert.equal(plan.name, 'lenient', 'name falls back to the id');
  assert.equal(plan.included.sessions, 0);
  assert.equal(plan.included.renders, 0);
  assert.equal(plan.included.modelsLive, 3);
  assert.equal(plan.overage.session, 0);
  assert.equal(plan.limits.seats, 1);
  assert.equal(plan.limits.hardModelsLive, null);
  assert.equal(plan.limits.overageCapMinor, null);

  const paths = res.dropped.map((d) => d.path).sort();
  assert.deepEqual(paths, [
    'included.renders',
    'included.sessions',
    'limits.hardModelsLive',
    'limits.seats',
    'name',
    'overage.session',
  ]);
  // Lenient at READ, strict at WRITE: this one bills, but cannot be activated.
  assert.equal(isActivatablePlan(res), false);
});

test('a missing overage block bills no overage, and says so', () => {
  const res = parsePlan({ id: 'flat', name: 'Flat', base: { amount: 100, currency: 'USD' } });
  assert.ok(res.plan);
  assert.deepEqual((res.plan as Plan).overage, { session: 0, render: 0, modelLive: 0 });
  const reasons = res.dropped.map((d) => d.path);
  assert.ok(reasons.includes('overage'));
  assert.ok(reasons.includes('included'));
});

test('stripe refs are optional data, and junk ones are dropped not guessed', () => {
  const ok = parsePlan(withBase({ stripe: { basePriceId: 'price_123', meterEventNames: { session: 'veta_sessions' } } }));
  assert.deepEqual(ok.plan?.stripe, { basePriceId: 'price_123', meterEventNames: { session: 'veta_sessions' } });
  assert.deepEqual(ok.dropped, []);

  const junk = parsePlan(withBase({ stripe: { basePriceId: 42 } }));
  assert.equal(junk.plan?.stripe, undefined);
  assert.deepEqual(junk.dropped, [{ path: 'stripe.basePriceId', reason: 'not a string — dropped' }]);
});

// ── Lists ────────────────────────────────────────────────────────────────

test('parsePlans keeps the good rows and reports each refusal with its index', () => {
  const res = parsePlans([
    withBase({ id: 'a' }),
    { id: '' },
    withBase({ id: 'a' }),
    withBase({ id: 'b' }),
  ]);
  assert.deepEqual(res.plans.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(res.dropped.map((d) => [d.index, d.path]), [[1, 'id'], [2, 'id']]);
  assert.match(res.dropped[1].reason, /duplicate plan id/);
});

test('parsePlans refuses a non-array at the document level', () => {
  const res = parsePlans({ starter: {} });
  assert.deepEqual(res.plans, []);
  assert.deepEqual(res.dropped, [{ index: -1, path: '', reason: 'not an array' }]);
});

test('METER_KINDS is the fixed roll-up order', () => {
  assert.deepEqual([...METER_KINDS], ['session', 'render', 'model_live']);
});
