import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PLANS,
  KIND_AGGREGATION,
  aggregateUsage,
  assessAll,
  emptyTotals,
  inPeriod,
  monthPeriod,
  parseInstant,
  periodFor,
  planById,
  usageAgainstPlan,
} from '../src/index.ts';
import type { MeterEvent, Plan, Usage } from '../src/index.ts';

const MARCH = monthPeriod(2026, 3);

function ev(kind: MeterEvent['kind'], at: MeterEvent['at'], qty = 1, orgId = 'org_a'): MeterEvent {
  return { orgId, kind, at, qty };
}

// ── Instants: the timezone trap ──────────────────────────────────────────

test('a date-time WITHOUT an offset is read as UTC, not as the machine zone', () => {
  // THE TRAP: `new Date('2026-03-31T23:30:00')` resolves in the local zone, so
  // this same event would file under March on a UTC worker and April on one
  // running in Asia. The invoice must not depend on where the job ran.
  assert.equal(parseInstant('2026-03-31T23:30:00'), Date.UTC(2026, 2, 31, 23, 30, 0));
  assert.equal(parseInstant('2026-03-31T23:30:00.250'), Date.UTC(2026, 2, 31, 23, 30, 0, 250));
  // A bare date is already UTC by spec.
  assert.equal(parseInstant('2026-03-01'), Date.UTC(2026, 2, 1));
});

test('an explicit offset is honoured — including the one that crosses the month', () => {
  // 21:00 on March 31 in UTC-05:00 is April 1 at 02:00Z: an APRIL event that
  // reads as March everywhere on the customer's screen.
  assert.equal(parseInstant('2026-03-31T21:00:00-05:00'), Date.UTC(2026, 3, 1, 2, 0, 0));
  assert.equal(parseInstant('2026-04-01T02:00:00Z'), Date.UTC(2026, 3, 1, 2, 0, 0));
  assert.equal(inPeriod(parseInstant('2026-03-31T21:00:00-05:00') as number, MARCH), false);
});

test('epoch seconds are auto-corrected to milliseconds', () => {
  const ms = Date.UTC(2026, 2, 15, 12, 0, 0);
  assert.equal(parseInstant(ms), ms);
  assert.equal(parseInstant(Math.floor(ms / 1000)), ms, "Stripe's wire is seconds");
  assert.equal(parseInstant(new Date(ms)), ms);
});

test('an unreadable instant is null, never a silent 1970', () => {
  for (const junk of ['', 'yesterday', '2026-13-45T00:00:00Z', {}, [], null, undefined, NaN, -1, new Date('x')]) {
    assert.equal(parseInstant(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

// ── Periods ──────────────────────────────────────────────────────────────

test('a period is a half-open UTC window with a sortable label', () => {
  assert.equal(MARCH.start, Date.UTC(2026, 2, 1));
  assert.equal(MARCH.end, Date.UTC(2026, 3, 1));
  assert.equal(MARCH.label, '2026-03');
  const december = monthPeriod(2026, 12);
  assert.equal(december.end, Date.UTC(2027, 0, 1), 'December rolls into next January');
  assert.equal(december.label, '2026-12');
  assert.equal(periodFor('2026-03-31T23:59:59Z').label, '2026-03');
  assert.equal(periodFor('2026-04-01T00:00:00Z').label, '2026-04');
});

test('the boundary belongs to exactly one period', () => {
  assert.equal(inPeriod(MARCH.start, MARCH), true, 'start is INSIDE');
  assert.equal(inPeriod(MARCH.end - 1, MARCH), true);
  assert.equal(inPeriod(MARCH.end, MARCH), false, 'end belongs to the NEXT period');
  assert.equal(inPeriod(MARCH.start - 1, MARCH), false);
  // …and the two windows tile without a gap or an overlap.
  assert.equal(monthPeriod(2026, 4).start, MARCH.end);
});

// ── Aggregation ──────────────────────────────────────────────────────────

test('edge events land on the right side of the boundary', () => {
  const res = aggregateUsage(
    [
      ev('session', MARCH.start),
      ev('session', MARCH.end - 1),
      ev('session', MARCH.end),
      ev('session', MARCH.start - 1),
    ],
    MARCH,
  );
  assert.equal(res.usage.length, 1);
  assert.equal(res.usage[0].totals.session, 2);
  assert.equal(res.outOfPeriod, 2);
  assert.deepEqual(res.dropped, [], 'out-of-window is not a refusal');
});

test('counters SUM and the live-models gauge PEAKS', () => {
  assert.deepEqual({ ...KIND_AGGREGATION }, { session: 'sum', render: 'sum', model_live: 'peak' });
  const res = aggregateUsage(
    [
      ev('session', '2026-03-02T10:00:00Z', 3),
      ev('session', '2026-03-09T10:00:00Z', 4),
      ev('render', '2026-03-02T10:00:00Z', 2),
      // Nightly heartbeats. Summing these would bill the same models 3 times.
      ev('model_live', '2026-03-01T00:00:00Z', 25),
      ev('model_live', '2026-03-02T00:00:00Z', 30),
      ev('model_live', '2026-03-03T00:00:00Z', 28),
    ],
    MARCH,
  );
  assert.deepEqual(res.usage[0].totals, { session: 7, render: 2, model_live: 30 });
  assert.equal(res.usage[0].events, 6);
});

test('a zero-qty gauge heartbeat is a fact, not junk', () => {
  const res = aggregateUsage([ev('model_live', '2026-03-05T00:00:00Z', 0)], MARCH);
  assert.deepEqual(res.dropped, []);
  assert.equal(res.usage[0].totals.model_live, 0);
  assert.equal(res.usage[0].events, 1);
});

test('junk events are dropped one by one, each reported with its index', () => {
  const res = aggregateUsage(
    [
      ev('session', '2026-03-02T10:00:00Z'),
      { orgId: '', kind: 'session', at: MARCH.start, qty: 1 },
      { orgId: 'org_a', kind: 'teleport' as MeterEvent['kind'], at: MARCH.start, qty: 1 },
      { orgId: 'org_a', kind: 'session', at: 'never', qty: 1 },
      { orgId: 'org_a', kind: 'session', at: MARCH.start, qty: -3 },
      { orgId: 'org_a', kind: 'session', at: MARCH.start, qty: 1.5 },
      null as unknown as MeterEvent,
    ],
    MARCH,
  );
  assert.equal(res.usage[0].totals.session, 1, 'the good event still bills');
  assert.deepEqual(res.dropped.map((d) => d.index), [1, 2, 3, 4, 5, 6]);
  assert.match(res.dropped[0].reason, /missing orgId/);
  assert.match(res.dropped[1].reason, /unknown kind "teleport"/);
  assert.match(res.dropped[2].reason, /unreadable timestamp/);
  assert.match(res.dropped[3].reason, /non-negative integer/);
  assert.match(res.dropped[4].reason, /non-negative integer/);
});

test('orgs are split and returned in a stable order', () => {
  const res = aggregateUsage(
    [
      ev('session', MARCH.start, 1, 'org_z'),
      ev('session', MARCH.start, 2, 'org_a'),
      ev('render', MARCH.start, 1, 'org_z'),
    ],
    MARCH,
  );
  assert.deepEqual(res.usage.map((u) => u.orgId), ['org_a', 'org_z']);
  assert.equal(res.byOrg.org_a.totals.session, 2);
  assert.equal(res.byOrg.org_z.totals.render, 1);
});

test('no events is an empty roll-up, not a throw', () => {
  assert.deepEqual(aggregateUsage([], MARCH).usage, []);
  assert.deepEqual(aggregateUsage(null, MARCH).usage, []);
  assert.deepEqual(aggregateUsage(undefined, MARCH).dropped, []);
  assert.deepEqual(emptyTotals(), { session: 0, render: 0, model_live: 0 });
});

// ── Overage math, to the cent ────────────────────────────────────────────

const STARTER = planById('starter') as Plan;

function usageOf(totals: Partial<Usage['totals']>, orgId = 'org_a'): Usage {
  return { orgId, period: MARCH, totals: { ...emptyTotals(), ...totals }, events: 1 };
}

test('inside the allowance nothing is billed past the base', () => {
  const a = usageAgainstPlan(usageOf({ session: 2_000, render: 200, model_live: 25 }), STARTER);
  assert.equal(a.overageUncappedMinor, 0);
  assert.deepEqual(a.projectedCharge, { amount: STARTER.base.amount, currency: 'USD' });
  for (const line of a.overage) assert.equal(line.qty, 0);
});

test('overage is exact integer minor-unit arithmetic', () => {
  // 500 sessions × $0.05 = $25.00 · 100 renders × $0.40 = $40.00
  // 5 live models × $3.00 = $15.00 → $80.00 over the $99.00 base = $179.00
  const a = usageAgainstPlan(usageOf({ session: 2_500, render: 300, model_live: 30 }), STARTER);
  assert.deepEqual(
    a.overage.map((l) => [l.kind, l.qty, l.rateMinor, l.amountMinor]),
    [
      ['session', 500, 5, 2_500],
      ['render', 100, 40, 4_000],
      ['model_live', 5, 300, 1_500],
    ],
  );
  assert.equal(a.overageUncappedMinor, 8_000);
  assert.equal(a.overageMinor, 8_000);
  assert.equal(a.capped, false);
  assert.deepEqual(a.projectedCharge, { amount: 17_900, currency: 'USD' });
  assert.ok(Number.isSafeInteger(a.projectedCharge.amount));
});

test('integer minor units dodge the float dust a major-unit engine would carry', () => {
  // The same sum in major units: 0.05 × 3 is 0.15000000000000002 in IEEE-754,
  // and a thousand of those is a cent adrift. Ours is an integer product.
  const a = usageAgainstPlan(usageOf({ session: 2_003 }), STARTER);
  assert.equal(a.overage[0].amountMinor, 15);
  assert.notEqual(0.05 * 3, 0.15);
  assert.equal(Number.isInteger(a.projectedCharge.amount), true);
});

test('one unit over the allowance bills exactly one unit', () => {
  const a = usageAgainstPlan(usageOf({ session: 2_001 }), STARTER);
  assert.equal(a.overage[0].qty, 1);
  assert.equal(a.projectedCharge.amount, STARTER.base.amount + STARTER.overage.session);
});

test('the spend guard clamps the bill and says it clamped', () => {
  const capped: Plan = { ...STARTER, limits: { ...STARTER.limits, overageCapMinor: 1_000 } };
  const a = usageAgainstPlan(usageOf({ session: 12_000 }), capped);
  assert.equal(a.overageUncappedMinor, 50_000);
  assert.equal(a.overageMinor, 1_000);
  assert.equal(a.capped, true);
  assert.equal(a.projectedCharge.amount, STARTER.base.amount + 1_000);
});

test('a hard limit is a refusal to report, not an extra charge', () => {
  const a = usageAgainstPlan(usageOf({ model_live: 140 }), STARTER);
  assert.deepEqual(a.breaches, ['models_live 140 over hard limit 100']);
  // It still prices what was actually served — the breach is the API's problem.
  assert.equal(a.overage[2].qty, 115);
  const unlimited = planById('scale') as Plan;
  assert.deepEqual(usageAgainstPlan(usageOf({ model_live: 5_000 }), unlimited).breaches, []);
});

test('the assessment carries the period and org through to the reporter', () => {
  const a = usageAgainstPlan(usageOf({ session: 1 }, 'org_x'), STARTER);
  assert.equal(a.orgId, 'org_x');
  assert.equal(a.period.label, '2026-03');
  assert.equal(a.planId, 'starter');
  assert.equal(a.currency, 'USD');
  assert.deepEqual(a.included, { session: 2_000, render: 200, model_live: 25 });
});

test('assessAll prices every org in one aggregation', () => {
  const res = aggregateUsage(
    [ev('session', MARCH.start, 2_500, 'org_a'), ev('session', MARCH.start, 10, 'org_b')],
    MARCH,
  );
  const all = assessAll(res, DEFAULT_PLANS[0]);
  assert.deepEqual(all.map((a) => [a.orgId, a.projectedCharge.amount]), [
    ['org_a', 12_400],
    ['org_b', 9_900],
  ]);
});
