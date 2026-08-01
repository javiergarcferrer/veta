import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BILLING_EVENT_TYPES,
  DAY_MS,
  GRACE_DAYS,
  SUBSCRIPTION_STATES,
  buildSubscriptionSpec,
  buildUsageRecords,
  emptyTotals,
  entitlementsFor,
  monthPeriod,
  parseWebhookEvent,
  planById,
  subscriptionStateFrom,
  usageAgainstPlan,
} from '../src/index.ts';
import type { BillingEvent, Plan, SubscriptionStateName, Usage } from '../src/index.ts';

const STARTER = planById('starter') as Plan;
const MARCH = monthPeriod(2026, 3);
const T0 = Date.UTC(2026, 2, 10, 12, 0, 0);

const WIRED: Plan = {
  ...STARTER,
  stripe: {
    basePriceId: 'price_base',
    sessionPriceId: 'price_sessions',
    renderPriceId: 'price_renders',
    modelLivePriceId: 'price_models',
  },
};

// ── buildSubscriptionSpec ────────────────────────────────────────────────

test('a subscription body carries a licensed base and METERED items with no quantity', () => {
  const { spec, dropped } = buildSubscriptionSpec(
    { id: 'org_a', stripeCustomerId: 'cus_123' },
    WIRED,
  );
  assert.deepEqual(dropped, []);
  assert.ok(spec);
  assert.equal(spec.body.customer, 'cus_123');
  assert.deepEqual(spec.body.items, [
    { price: 'price_base', quantity: 1 },
    { price: 'price_sessions' },
    { price: 'price_renders' },
    { price: 'price_models' },
  ]);
  for (const item of spec.body.items.slice(1)) {
    assert.equal('quantity' in item, false, 'Stripe rejects quantity on a metered price');
  }
  assert.deepEqual(spec.body.metadata, { veta_org_id: 'org_a', veta_plan_id: 'starter' });
  assert.equal(spec.body.collection_method, 'charge_automatically');
});

test('the idempotency key is deterministic, so a retry cannot double-subscribe', () => {
  const org = { id: 'org_a', stripeCustomerId: 'cus_123' };
  const a = buildSubscriptionSpec(org, WIRED).spec;
  const b = buildSubscriptionSpec(org, WIRED).spec;
  assert.equal(a?.idempotencyKey, b?.idempotencyKey);
  assert.equal(a?.idempotencyKey, 'veta:sub:org_a:starter');
  const other = buildSubscriptionSpec({ id: 'org_b', stripeCustomerId: 'cus_9' }, WIRED).spec;
  assert.notEqual(a?.idempotencyKey, other?.idempotencyKey);
});

test('no customer or no base price means NO spec — a price id is never invented', () => {
  const noCustomer = buildSubscriptionSpec({ id: 'org_a' }, WIRED);
  assert.equal(noCustomer.spec, null);
  assert.equal(noCustomer.dropped[0].path, 'org.stripeCustomerId');

  const noPrice = buildSubscriptionSpec({ id: 'org_a', stripeCustomerId: 'cus_1' }, STARTER);
  assert.equal(noPrice.spec, null);
  assert.ok(noPrice.dropped.some((d) => d.path === 'plan.stripe.basePriceId'));
});

test('a missing metered price costs that meter its line, and is reported', () => {
  const partial: Plan = { ...STARTER, stripe: { basePriceId: 'price_base', renderPriceId: 'price_r' } };
  const { spec, dropped } = buildSubscriptionSpec({ id: 'org_a', stripeCustomerId: 'cus_1' }, partial);
  assert.deepEqual(spec?.body.items, [{ price: 'price_base', quantity: 1 }, { price: 'price_r' }]);
  assert.deepEqual(dropped.map((d) => d.path), ['plan.stripe.session', 'plan.stripe.model_live']);
});

test('price ids may be injected at the call site, and a bad trial is refused', () => {
  const ok = buildSubscriptionSpec(
    { id: 'org_a', stripeCustomerId: 'cus_1' },
    STARTER,
    { priceIds: { basePriceId: 'price_x' }, trialDays: 14 },
  );
  assert.equal(ok.spec?.body.items[0].price, 'price_x');
  assert.equal(ok.spec?.body.trial_period_days, 14);

  const bad = buildSubscriptionSpec(
    { id: 'org_a', stripeCustomerId: 'cus_1' },
    WIRED,
    { trialDays: 9_999 },
  );
  assert.equal(bad.spec?.body.trial_period_days, undefined);
  assert.ok(bad.dropped.some((d) => d.path === 'opts.trialDays'));
});

// ── buildUsageRecords ────────────────────────────────────────────────────

function assessment(totals: Partial<Usage['totals']>, orgId = 'org_a') {
  const usage: Usage = { orgId, period: MARCH, totals: { ...emptyTotals(), ...totals }, events: 1 };
  return usageAgainstPlan(usage, STARTER);
}

test('only OVERAGE units are reported, and only when there are some', () => {
  const { records, dropped } = buildUsageRecords(assessment({ session: 2_500, render: 10 }), {
    customers: { org_a: 'cus_1' },
  });
  assert.deepEqual(dropped, []);
  assert.equal(records.length, 1, 'renders were inside the allowance — no record at all');
  assert.equal(records[0].eventName, 'veta_sessions');
  assert.equal(records[0].payload.value, '500', 'the 500 PAST the allowance, not the 2500 used');
  assert.equal(records[0].payload.stripe_customer_id, 'cus_1');
});

test('the meter identifier is deterministic per org+kind+period — replay-safe', () => {
  const opts = { customers: { org_a: 'cus_1' } };
  const first = buildUsageRecords(assessment({ session: 2_500 }), opts).records[0];
  const again = buildUsageRecords(assessment({ session: 2_500 }), opts).records[0];
  assert.equal(first.identifier, again.identifier);
  assert.equal(first.identifier, 'veta:org_a:session:2026-03');
  const other = buildUsageRecords(assessment({ session: 2_500 }, 'org_b'), {
    customers: { org_b: 'cus_2' },
  }).records[0];
  assert.notEqual(first.identifier, other.identifier);
});

test('the reported timestamp is the period close, in SECONDS', () => {
  const rec = buildUsageRecords(assessment({ session: 2_001 }), { customers: { org_a: 'cus_1' } }).records[0];
  assert.equal(rec.timestamp, Math.floor((MARCH.end - 1) / 1000));
  assert.ok(rec.timestamp < 1e11, 'seconds, not milliseconds');
  assert.equal(new Date(rec.timestamp * 1000).getUTCMonth(), 2, 'still inside March');
});

test('an org with no Stripe customer is dropped, never billed under its org id', () => {
  const { records, dropped } = buildUsageRecords(assessment({ session: 3_000 }), { customers: {} });
  assert.deepEqual(records, []);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /no Stripe customer for org "org_a"/);
});

test('a batch reports every meter of every org', () => {
  const { records } = buildUsageRecords(
    [assessment({ session: 2_500, render: 300 }), assessment({ model_live: 30 }, 'org_b')],
    { customers: { org_a: 'cus_1', org_b: 'cus_2' } },
  );
  assert.deepEqual(records.map((r) => [r.meta.orgId, r.meta.kind, r.meta.qty]), [
    ['org_a', 'session', 500],
    ['org_a', 'render', 100],
    ['org_b', 'model_live', 5],
  ]);
});

// ── parseWebhookEvent ────────────────────────────────────────────────────

function payload(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type,
    created: Math.floor(T0 / 1000),
    livemode: true,
    data: { object },
    ...extra,
  };
}

test('an unverified payload is refused BEFORE anything is read from it', () => {
  const good = payload('invoice.paid', { customer: 'cus_1', subscription: 'sub_1' });
  assert.deepEqual(parseWebhookEvent(good, false), { ok: false, reason: 'signature_invalid' });
  // Even junk reports the signature first — the body is attacker-controlled.
  assert.deepEqual(parseWebhookEvent('<html>', false), { ok: false, reason: 'signature_invalid' });
  assert.deepEqual(parseWebhookEvent(null, false), { ok: false, reason: 'signature_invalid' });
});

test('a verified invoice event normalizes to a BillingEvent', () => {
  const res = parseWebhookEvent(
    payload('invoice.paid', {
      customer: 'cus_1',
      subscription: 'sub_1',
      metadata: { veta_org_id: 'org_a' },
    }),
    true,
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.event, {
    id: 'evt_1',
    type: 'invoice.paid',
    at: T0,
    orgId: 'org_a',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    subscriptionStatus: null,
    livemode: true,
  });
});

test('a subscription event IS the subscription, and carries its status', () => {
  const res = parseWebhookEvent(
    payload('customer.subscription.updated', {
      id: 'sub_9',
      customer: { id: 'cus_2' },
      status: 'past_due',
      metadata: { veta_org_id: 'org_b' },
    }),
    true,
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.event.subscriptionId, 'sub_9');
  assert.equal(res.event.subscriptionStatus, 'past_due');
  assert.equal(res.event.customerId, 'cus_2', 'an expanded customer object resolves to its id');
});

test('every refusal has its own reason — nothing is silently valid', () => {
  const cases: [unknown, string][] = [
    ['not json', 'malformed_payload'],
    [{ type: 'invoice.paid', created: 1, data: { object: {} } }, 'missing_id'],
    [{ id: 'evt_1', created: 1, data: { object: {} } }, 'missing_type'],
    [payload('invoice.upcoming', {}), 'unsupported_type'],
    [{ id: 'evt_1', type: 'invoice.paid', created: 1 }, 'missing_object'],
    [{ id: 'evt_1', type: 'invoice.paid', created: 'soon', data: { object: {} } }, 'bad_timestamp'],
  ];
  for (const [raw, reason] of cases) {
    const res = parseWebhookEvent(raw, true);
    assert.equal(res.ok, false, `expected refusal: ${reason}`);
    if (res.ok) continue;
    assert.equal(res.reason, reason);
  }
});

test('unknown-but-real Stripe types are reported, not guessed at', () => {
  const res = parseWebhookEvent(payload('charge.refunded', { customer: 'cus_1' }), true);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'unsupported_type');
  assert.equal(res.detail, 'charge.refunded');
  assert.equal(BILLING_EVENT_TYPES.includes('charge.refunded' as never), false);
});

// ── The state machine ────────────────────────────────────────────────────

let seq = 0;
function event(type: BillingEvent['type'], at: number, status: BillingEvent['subscriptionStatus'] = null): BillingEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    type,
    at,
    orgId: 'org_a',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    subscriptionStatus: status,
    livemode: true,
  };
}

const day = (n: number) => T0 + n * DAY_MS;
const stateAt = (events: BillingEvent[], asOf: number): SubscriptionStateName =>
  subscriptionStateFrom(events, { asOf }).state;

test('no history and a paid invoice are both active', () => {
  assert.equal(subscriptionStateFrom([], { asOf: T0 }).state, 'active');
  assert.equal(subscriptionStateFrom(undefined, { asOf: T0 }).state, 'active');
  assert.equal(stateAt([event('invoice.paid', T0)], day(400)), 'active');
});

test('the ladder: one failed payment walks past_due → grace → locked on one knob', () => {
  const events = [event('invoice.payment_failed', T0)];
  assert.equal(stateAt(events, T0), 'past_due');
  assert.equal(stateAt(events, day(GRACE_DAYS) - 1), 'past_due');
  assert.equal(stateAt(events, day(GRACE_DAYS)), 'grace');
  assert.equal(stateAt(events, day(2 * GRACE_DAYS) - 1), 'grace');
  assert.equal(stateAt(events, day(2 * GRACE_DAYS)), 'locked');
  assert.equal(stateAt(events, day(999)), 'locked');

  const s = subscriptionStateFrom(events, { asOf: T0 });
  assert.equal(s.delinquentSince, T0);
  assert.equal(s.graceStartsAt, day(GRACE_DAYS));
  assert.equal(s.graceEndsAt, day(2 * GRACE_DAYS));
});

test('a second failure does not restart the clock', () => {
  const events = [event('invoice.payment_failed', T0), event('invoice.payment_failed', day(10))];
  assert.equal(subscriptionStateFrom(events, { asOf: T0 }).delinquentSince, T0);
  assert.equal(stateAt(events, day(GRACE_DAYS)), 'grace', 'still measured from the FIRST failure');
});

test('Stripe events accelerate the ladder but can never delay it', () => {
  // Dunning exhausted on day 2 → degraded on day 2, not day 14.
  const early = [event('invoice.payment_failed', T0), event('invoice.marked_uncollectible', day(2))];
  assert.equal(stateAt(early, day(1)), 'past_due');
  assert.equal(stateAt(early, day(2)), 'grace');
  assert.equal(stateAt(early, day(2 + GRACE_DAYS)), 'locked');

  // The same escalation arriving LATE cannot push grace back out to day 20.
  const late = [event('invoice.payment_failed', T0), event('invoice.marked_uncollectible', day(20))];
  assert.equal(subscriptionStateFrom(late, { asOf: day(20) }).graceStartsAt, day(GRACE_DAYS));
  assert.equal(stateAt(late, day(GRACE_DAYS)), 'grace');
});

test("Stripe's own statuses map onto the ladder", () => {
  assert.equal(stateAt([event('customer.subscription.updated', T0, 'active')], day(1)), 'active');
  assert.equal(stateAt([event('customer.subscription.created', T0, 'trialing')], day(1)), 'active');
  assert.equal(stateAt([event('customer.subscription.updated', T0, 'past_due')], day(1)), 'past_due');
  assert.equal(stateAt([event('customer.subscription.updated', T0, 'incomplete')], day(1)), 'past_due');
  assert.equal(stateAt([event('customer.subscription.updated', T0, 'unpaid')], day(1)), 'grace');
  assert.equal(stateAt([event('customer.subscription.updated', T0, 'paused')], day(1)), 'grace');
  assert.equal(stateAt([event('customer.subscription.updated', T0, 'canceled')], day(1)), 'locked');
  assert.equal(stateAt([event('customer.subscription.updated', T0, 'incomplete_expired')], day(1)), 'locked');
});

test('a cancellation locks immediately and money alone does not undo it', () => {
  const cancelled = [event('customer.subscription.deleted', T0)];
  assert.equal(stateAt(cancelled, T0), 'locked');

  // Paying the final invoice settles a debt; it does not buy the service back.
  const paidAfter = [...cancelled, event('invoice.paid', day(1))];
  assert.equal(stateAt(paidAfter, day(2)), 'locked');

  // A NEW active subscription does.
  const resubscribed = [...paidAfter, event('customer.subscription.created', day(3), 'active')];
  assert.equal(stateAt(resubscribed, day(4)), 'active');
});

test('paying up returns to active and clears every clock', () => {
  const events = [event('invoice.payment_failed', T0), event('invoice.paid', day(3))];
  const s = subscriptionStateFrom(events, { asOf: day(30) });
  assert.equal(s.state, 'active');
  assert.equal(s.delinquentSince, null);
  assert.equal(s.graceEndsAt, null);
  assert.equal(s.reason, 'invoice.paid');
});

test('a webhook replay is idempotent: the same event twice is the same state', () => {
  const events = [event('invoice.payment_failed', T0), event('customer.subscription.updated', day(1), 'past_due')];
  const once = subscriptionStateFrom(events, { asOf: day(5) });
  const twice = subscriptionStateFrom([...events, ...events], { asOf: day(5) });
  const { duplicates: dupA, ...restA } = once;
  const { duplicates: dupB, ...restB } = twice;
  assert.deepEqual(restB, restA, 'a redelivery must not move the state or the clocks');
  assert.deepEqual(dupA, []);
  assert.deepEqual(dupB, events.map((e) => e.id), 'the ignored replays are still observable');
  assert.equal(twice.applied, once.applied);
});

test('arrival order cannot change the answer', () => {
  const events = [
    event('invoice.payment_failed', T0),
    event('invoice.paid', day(2)),
    event('invoice.payment_failed', day(5)),
  ];
  const inOrder = subscriptionStateFrom(events, { asOf: day(6) });
  const shuffled = subscriptionStateFrom([events[2], events[0], events[1]], { asOf: day(6) });
  assert.deepEqual(shuffled, inOrder);
  assert.equal(inOrder.delinquentSince, day(5), 'the clock restarted at the LATER failure');
  assert.equal(inOrder.state, 'past_due');
});

test('the same history at the same instant is byte-identical, run to run', () => {
  const events = [event('invoice.payment_failed', T0), event('invoice.marked_uncollectible', day(4))];
  assert.deepEqual(
    subscriptionStateFrom(events, { asOf: day(10) }),
    subscriptionStateFrom(events, { asOf: day(10) }),
  );
});

test('the grace width is overridable, and every state name is covered', () => {
  const events = [event('invoice.payment_failed', T0)];
  assert.equal(stateAt(events, day(3)), 'past_due');
  assert.equal(subscriptionStateFrom(events, { asOf: day(3), graceDays: 2 }).state, 'grace');
  assert.equal(subscriptionStateFrom(events, { asOf: day(5), graceDays: 2 }).state, 'locked');
  assert.deepEqual([...SUBSCRIPTION_STATES], ['active', 'past_due', 'grace', 'locked']);
});

// ── Entitlements ─────────────────────────────────────────────────────────

test('THE INVARIANT: the widget stays up in EVERY state', () => {
  for (const state of SUBSCRIPTION_STATES) {
    const e = entitlementsFor(state, STARTER);
    assert.equal(e.widget, true, `${state} must keep serving the widget`);
    assert.equal(e.configuratorSessions, true, `${state} must keep accepting sessions`);
    assert.equal(e.catalogRead, true, `${state} must keep serving catalogue reads`);
    assert.equal(e.apiRead, true);
    assert.equal(e.metered, true, `${state} still meters what it serves`);
  }
});

test('the entitlement matrix', () => {
  const row = (state: SubscriptionStateName) => {
    const e = entitlementsFor(state, STARTER);
    return [e.catalogWrite, e.apiWrite, e.renders, e.modelPublish, e.modelsLiveFrozen, e.readOnly, e.banner];
  };
  assert.deepEqual(row('active'), [true, true, true, true, false, false, 'none']);
  assert.deepEqual(row('past_due'), [true, true, true, true, false, false, 'payment_failed']);
  assert.deepEqual(row('grace'), [true, true, false, false, true, false, 'grace_ending']);
  assert.deepEqual(row('locked'), [false, false, false, false, true, true, 'locked']);
});

test('entitlements read the plan for caps and take either state form', () => {
  const fromName = entitlementsFor('active', STARTER);
  const fromState = entitlementsFor(subscriptionStateFrom([], { asOf: T0 }), STARTER);
  assert.deepEqual(fromState, fromName);
  assert.equal(fromName.modelsLiveCap, 100);
  assert.equal(fromName.seats, 3);
  assert.equal(entitlementsFor('active', planById('scale') as Plan).modelsLiveCap, null);
});

test('a locked account is read-only, not offline', () => {
  const e = entitlementsFor('locked', STARTER);
  assert.equal(e.readOnly, true);
  assert.equal(e.catalogWrite, false);
  // …and yet:
  assert.equal(e.widget, true);
  assert.equal(e.catalogRead, true);
});
