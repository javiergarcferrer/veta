// THE STRIPE BOUNDARY — types and PURE builders. No network, ever.
//
// This module knows Stripe's SHAPES; the API edge owns the I/O. Two things are
// deliberately kept out:
//
//  · NO HTTP. A builder returns the body someone else posts, so the whole
//    subscription/usage/webhook path is unit-testable without a key.
//  · NO CRYPTO. `parseWebhookEvent` takes `signatureValid` as a BOOLEAN INPUT.
//    Verifying the `Stripe-Signature` header needs the endpoint secret and a
//    timing-safe compare — that belongs at the edge that holds the secret. Here
//    it is a precondition, which means the state machine can never be reached by
//    an unverified payload and the test suite never needs a key to prove it.
//
// THE ENTITLEMENT RULE, up front, because it is the one that costs money if it
// is ever "simplified": THE WIDGET STAYS UP IN EVERY STATE, including `locked`.
// A brand's storefront must never 404 because a card expired — we degrade the
// EXPENSIVE and the WRITE paths (renders, model publishes, catalogue edits) and
// keep serving what shoppers already see. Billing is our problem with the
// brand, not the brand's problem with its customers.

import { DAY_MS, parseInstant } from '../metering.ts';
import type { UsageAssessment } from '../metering.ts';
import { METER_KINDS } from '../plans.ts';
import type { MeterKind, Plan } from '../plans.ts';

// ── Org + subscription spec ──────────────────────────────────────────────

/** The tenant, as billing needs it. The full org row lives elsewhere. */
export interface BillingOrg {
  id: string;
  name?: string | null;
  email?: string | null;
  /** `cus_…`. Absent until the customer is created at the edge. */
  stripeCustomerId?: string | null;
}

/** A single line of the subscription — Stripe's `items[]` shape. */
export interface SubscriptionItemSpec {
  price: string;
  /**
   * Licensed prices carry a quantity; METERED prices must NOT (Stripe rejects
   * the parameter). Absent means metered — the meter supplies the numbers.
   */
  quantity?: number;
}

/** Exactly the body of `POST /v1/subscriptions`, snake_case as the wire wants. */
export interface SubscriptionSpecBody {
  customer: string;
  items: SubscriptionItemSpec[];
  collection_method: 'charge_automatically';
  proration_behavior: 'create_prorations';
  /** Our ids on the object, so a webhook can find the tenant without a lookup. */
  metadata: Record<string, string>;
  trial_period_days?: number;
}

export interface SubscriptionSpec {
  body: SubscriptionSpecBody;
  /**
   * Deterministic on purpose: a retried create with the same key cannot mint a
   * second subscription for the same org+plan. A random key would be no
   * protection at all — the retry is exactly when it matters.
   */
  idempotencyKey: string;
}

export interface WireProblem {
  path: string;
  reason: string;
}

export interface SubscriptionSpecResult {
  spec: SubscriptionSpec | null;
  dropped: WireProblem[];
}

export interface SubscriptionSpecOptions {
  /** Overrides `plan.stripe` when the ids live outside the plan row. */
  priceIds?: {
    basePriceId?: string;
    sessionPriceId?: string;
    renderPriceId?: string;
    modelLivePriceId?: string;
  };
  trialDays?: number;
}

const MAX_TRIAL_DAYS = 90;

/**
 * Build the subscription body for one org on one plan.
 *
 * Drop-and-report: no customer id or no base price id and there is no spec at
 * all (we will not invent a `price_…`). A MISSING metered price id only costs
 * that meter its line — the subscription still exists and the overage is simply
 * not reported to Stripe, which is reported here rather than discovered on an
 * invoice that is short.
 */
export function buildSubscriptionSpec(
  org: BillingOrg,
  plan: Plan,
  opts: SubscriptionSpecOptions = {},
): SubscriptionSpecResult {
  const dropped: WireProblem[] = [];
  const refs = { ...(plan.stripe ?? {}), ...(opts.priceIds ?? {}) };

  const customer = String(org?.stripeCustomerId ?? '').trim();
  if (!customer) {
    dropped.push({ path: 'org.stripeCustomerId', reason: 'missing — create the customer first' });
  }
  const basePriceId = String(refs.basePriceId ?? '').trim();
  if (!basePriceId) {
    dropped.push({ path: 'plan.stripe.basePriceId', reason: 'missing — cannot subscribe without a base price' });
  }
  if (!customer || !basePriceId) return { spec: null, dropped };

  const items: SubscriptionItemSpec[] = [{ price: basePriceId, quantity: 1 }];
  const metered: [MeterKind, string | undefined][] = [
    ['session', refs.sessionPriceId],
    ['render', refs.renderPriceId],
    ['model_live', refs.modelLivePriceId],
  ];
  for (const [kind, priceId] of metered) {
    const id = String(priceId ?? '').trim();
    if (!id) {
      dropped.push({ path: `plan.stripe.${kind}`, reason: 'no metered price id — overage for this meter will not be reported' });
      continue;
    }
    // No `quantity` — see SubscriptionItemSpec.
    items.push({ price: id });
  }

  const body: SubscriptionSpecBody = {
    customer,
    items,
    collection_method: 'charge_automatically',
    proration_behavior: 'create_prorations',
    metadata: { veta_org_id: org.id, veta_plan_id: plan.id },
  };

  if (opts.trialDays !== undefined) {
    const days = Math.trunc(opts.trialDays);
    if (!Number.isFinite(days) || days < 0 || days > MAX_TRIAL_DAYS) {
      dropped.push({ path: 'opts.trialDays', reason: `not an integer in 0..${MAX_TRIAL_DAYS} — no trial applied` });
    } else if (days > 0) {
      body.trial_period_days = days;
    }
  }

  return { spec: { body, idempotencyKey: `veta:sub:${org.id}:${plan.id}` }, dropped };
}

// ── Usage reporting ──────────────────────────────────────────────────────

/**
 * WE REPORT OVERAGE UNITS, NOT GROSS USAGE.
 *
 * The allowance lives in the plan DATA (`plan.included`). If we reported gross
 * usage instead, Stripe's tiered price would have to restate that same
 * allowance, and the day the two disagree the brand is billed by whichever the
 * invoice happened to use. One source: our engine subtracts the allowance, and
 * Stripe's metered price is a flat per-unit rate.
 */
export interface UsageRecord {
  /** Billing-meter `event_name`. */
  eventName: string;
  /**
   * Stripe's dedupe handle. Deterministic per org+meter+period, so re-running
   * the reporter for a period cannot bill the same overage twice.
   */
  identifier: string;
  /** SECONDS — Stripe's wire unit, not JS milliseconds. */
  timestamp: number;
  payload: {
    stripe_customer_id: string;
    /** Stripe takes the value as a STRING; an integer count formatted exactly. */
    value: string;
  };
  /** Ours, for logs — not part of the Stripe payload. */
  meta: { orgId: string; kind: MeterKind; period: string; qty: number };
}

export interface UsageRecordsResult {
  records: UsageRecord[];
  dropped: WireProblem[];
}

export interface UsageRecordsOptions {
  /** orgId → `cus_…`. Required unless the assessment's org IS the customer id. */
  customers?: Record<string, string>;
  /** Per-kind meter `event_name` overrides. */
  eventNames?: Partial<Record<MeterKind, string>>;
}

/** Default billing-meter names. Overridable per plan (`stripe.meterEventNames`). */
export const STRIPE_METER_EVENT_NAMES: Readonly<Record<MeterKind, string>> = Object.freeze({
  session: 'veta_sessions',
  render: 'veta_renders',
  model_live: 'veta_models_live',
});

/**
 * Assessments → meter events.
 *
 * A meter with ZERO overage produces NO record: sending a zero costs an API call
 * and tells Stripe nothing it does not already assume. A record whose org has no
 * customer id is DROPPED and reported — never sent under the org id, which would
 * silently bill nobody.
 */
export function buildUsageRecords(
  usage: UsageAssessment | readonly UsageAssessment[],
  opts: UsageRecordsOptions = {},
): UsageRecordsResult {
  const list: readonly UsageAssessment[] = Array.isArray(usage) ? usage : [usage as UsageAssessment];
  const records: UsageRecord[] = [];
  const dropped: WireProblem[] = [];

  list.forEach((assessment, index) => {
    if (!assessment || typeof assessment !== 'object') {
      dropped.push({ path: `[${index}]`, reason: 'not an assessment' });
      return;
    }
    const customerId = String(opts.customers?.[assessment.orgId] ?? '').trim();
    if (!customerId) {
      dropped.push({ path: `[${index}].orgId`, reason: `no Stripe customer for org "${assessment.orgId}"` });
      return;
    }
    // Report AT the period's last instant: the usage belongs to the window that
    // just closed, never to the moment the reporter happened to run.
    const timestamp = Math.floor((assessment.period.end - 1) / 1000);

    for (const kind of METER_KINDS) {
      const line = assessment.overage.find((l) => l.kind === kind);
      if (!line || line.qty <= 0) continue;
      const eventName = String(opts.eventNames?.[kind] ?? STRIPE_METER_EVENT_NAMES[kind]).trim();
      if (!eventName) {
        dropped.push({ path: `[${index}].${kind}`, reason: 'no meter event name' });
        continue;
      }
      records.push({
        eventName,
        identifier: `veta:${assessment.orgId}:${kind}:${assessment.period.label}`,
        timestamp,
        payload: { stripe_customer_id: customerId, value: String(line.qty) },
        meta: { orgId: assessment.orgId, kind, period: assessment.period.label, qty: line.qty },
      });
    }
  });

  return { records, dropped };
}

// ── Webhooks ─────────────────────────────────────────────────────────────

/** The Stripe event types this engine acts on. Anything else is reported. */
export const BILLING_EVENT_TYPES = [
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.marked_uncollectible',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

/** Stripe's `subscription.status` values we map from. */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
] as const;

export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

/** A verified, normalized webhook — the ONLY input the state machine accepts. */
export interface BillingEvent {
  /** Stripe's `evt_…`. The dedupe key for replays. */
  id: string;
  type: BillingEventType;
  /** Epoch ms (Stripe sends seconds; `parseInstant` corrects it). */
  at: number;
  orgId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: StripeSubscriptionStatus | null;
  livemode: boolean;
}

export type WebhookRefusal =
  | 'signature_invalid'
  | 'malformed_payload'
  | 'missing_id'
  | 'missing_type'
  | 'unsupported_type'
  | 'missing_object'
  | 'bad_timestamp';

export type WebhookParse =
  | { ok: true; event: BillingEvent }
  | { ok: false; reason: WebhookRefusal; detail?: string };

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(BILLING_EVENT_TYPES);
const STATUS_SET: ReadonlySet<string> = new Set(STRIPE_SUBSCRIPTION_STATUSES);

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function idOf(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  const o = obj(v);
  if (o && typeof o.id === 'string' && o.id.trim()) return o.id.trim();
  return null;
}

/**
 * Verified payload → `BillingEvent`.
 *
 * `signatureValid === false` refuses BEFORE reading anything: an unverified body
 * is attacker-controlled, and parsing it first is how a forged `invoice.paid`
 * would reach the state machine. There is no "parse anyway and decide later".
 */
export function parseWebhookEvent(payload: unknown, signatureValid: boolean): WebhookParse {
  if (signatureValid !== true) return { ok: false, reason: 'signature_invalid' };

  const root = obj(payload);
  if (!root) return { ok: false, reason: 'malformed_payload' };

  const id = typeof root.id === 'string' ? root.id.trim() : '';
  if (!id) return { ok: false, reason: 'missing_id' };

  const type = typeof root.type === 'string' ? root.type.trim() : '';
  if (!type) return { ok: false, reason: 'missing_type' };
  if (!EVENT_TYPE_SET.has(type)) return { ok: false, reason: 'unsupported_type', detail: type };

  const data = obj(root.data);
  const object = data ? obj(data.object) : null;
  if (!object) return { ok: false, reason: 'missing_object' };

  const at = parseInstant(root.created);
  if (at === null) return { ok: false, reason: 'bad_timestamp', detail: String(root.created) };

  const metadata = obj(object.metadata) ?? {};
  const orgId = typeof metadata.veta_org_id === 'string' && metadata.veta_org_id.trim()
    ? metadata.veta_org_id.trim()
    : null;

  const status = typeof object.status === 'string' && STATUS_SET.has(object.status)
    ? (object.status as StripeSubscriptionStatus)
    : null;

  // An invoice points AT a subscription; a subscription object IS one.
  const subscriptionId = type.startsWith('customer.subscription.')
    ? idOf(object.id)
    : idOf(object.subscription);

  return {
    ok: true,
    event: {
      id,
      type: type as BillingEventType,
      at,
      orgId,
      customerId: idOf(object.customer),
      subscriptionId,
      subscriptionStatus: type.startsWith('customer.subscription.') ? status : null,
      livemode: root.livemode === true,
    },
  };
}

// ── The state machine ────────────────────────────────────────────────────

export const SUBSCRIPTION_STATES = ['active', 'past_due', 'grace', 'locked'] as const;
export type SubscriptionStateName = (typeof SUBSCRIPTION_STATES)[number];

/**
 * The ONE knob. A failed payment buys `GRACE_DAYS` of full service while Stripe
 * retries, then `GRACE_DAYS` of degraded service, then the account locks:
 *
 *   failure at T ──▶ past_due [T, T+14)  ──▶ grace [T+14, T+28)  ──▶ locked
 *
 * Stripe's own events can only ACCELERATE that ladder, never delay it: `unpaid`
 * or `marked_uncollectible` (dunning exhausted) drops straight into grace, and a
 * cancellation locks immediately. Time alone never un-degrades — only money does.
 */
export const GRACE_DAYS = 14;

export interface SubscriptionState {
  state: SubscriptionStateName;
  /** When the CURRENT state began (epoch ms), or `null` if never delinquent. */
  since: number | null;
  /** Which event or clock put it here — the audit handle. */
  reason: string;
  /** First unresolved payment failure; cleared by any payment. */
  delinquentSince: number | null;
  /** When degraded service starts / started. */
  graceStartsAt: number | null;
  /** When the account locks. */
  graceEndsAt: number | null;
  subscriptionId: string | null;
  lastEventId: string | null;
  lastEventAt: number | null;
  /** Events actually folded in (duplicates excluded). */
  applied: number;
  /** Replayed event ids that were ignored — idempotence, made observable. */
  duplicates: string[];
}

export interface SubscriptionStateOptions {
  /** Evaluate the clocks at this instant. Defaults to now; tests pass it. */
  asOf?: number | string | Date;
  /** Override the ladder width (same knob for both rungs). */
  graceDays?: number;
}

/**
 * Fold a subscription's whole event history into one state.
 *
 * DETERMINISTIC AND REPLAY-SAFE, which are the same requirement seen twice:
 * events are sorted by `(at, id)` so arrival order cannot change the answer, and
 * deduped by `id` so the SAME event delivered twice — which Stripe promises will
 * happen — folds exactly once. Every clock is derived from event timestamps and
 * `asOf`, never from `Date.now()` inside the fold, so replaying the same history
 * at the same `asOf` returns an identical object.
 */
export function subscriptionStateFrom(
  events: readonly BillingEvent[] | null | undefined,
  opts: SubscriptionStateOptions = {},
): SubscriptionState {
  const graceDays = Number.isFinite(opts.graceDays) && (opts.graceDays as number) > 0
    ? Math.trunc(opts.graceDays as number)
    : GRACE_DAYS;
  const asOf = parseInstant(opts.asOf ?? Date.now()) ?? Date.now();

  const list = (Array.isArray(events) ? events : []).filter(
    (e): e is BillingEvent => !!e && typeof e === 'object' && typeof e.id === 'string',
  );
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const ordered = [...list].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let delinquentSince: number | null = null;
  let explicitGraceAt: number | null = null;
  let cancelledAt: number | null = null;
  let subscriptionId: string | null = null;
  let lastEventId: string | null = null;
  let lastEventAt: number | null = null;
  let reason = 'no billing events yet';
  let applied = 0;

  for (const event of ordered) {
    if (seen.has(event.id)) {
      duplicates.push(event.id);
      continue;
    }
    seen.add(event.id);
    applied += 1;
    lastEventId = event.id;
    lastEventAt = event.at;
    if (event.subscriptionId) subscriptionId = event.subscriptionId;

    switch (event.type) {
      case 'invoice.paid':
        // Money clears the delinquency clocks — but NOT a cancellation. Paying
        // the final invoice of a cancelled subscription settles a debt; it does
        // not buy the service back. Only a new active subscription does that.
        delinquentSince = null;
        explicitGraceAt = null;
        reason = 'invoice.paid';
        break;

      case 'invoice.payment_failed':
        if (delinquentSince === null) delinquentSince = event.at;
        reason = 'invoice.payment_failed';
        break;

      case 'invoice.marked_uncollectible':
        // Stripe gave up retrying — jump the first rung.
        if (delinquentSince === null) delinquentSince = event.at;
        if (explicitGraceAt === null) explicitGraceAt = event.at;
        reason = 'invoice.marked_uncollectible';
        break;

      case 'customer.subscription.deleted':
        cancelledAt = event.at;
        reason = 'customer.subscription.deleted';
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const status = event.subscriptionStatus;
        if (status === 'active' || status === 'trialing') {
          delinquentSince = null;
          explicitGraceAt = null;
          cancelledAt = null;
          reason = `subscription ${status}`;
        } else if (status === 'past_due' || status === 'incomplete') {
          if (delinquentSince === null) delinquentSince = event.at;
          reason = `subscription ${status}`;
        } else if (status === 'unpaid' || status === 'paused') {
          if (delinquentSince === null) delinquentSince = event.at;
          if (explicitGraceAt === null) explicitGraceAt = event.at;
          reason = `subscription ${status}`;
        } else if (status === 'canceled' || status === 'incomplete_expired') {
          cancelledAt = event.at;
          reason = `subscription ${status}`;
        } else {
          reason = `${event.type} (no status)`;
        }
        break;
      }
    }
  }

  const window = graceDays * DAY_MS;

  if (cancelledAt !== null) {
    return {
      state: 'locked',
      since: cancelledAt,
      reason,
      delinquentSince,
      graceStartsAt: null,
      graceEndsAt: null,
      subscriptionId,
      lastEventId,
      lastEventAt,
      applied,
      duplicates,
    };
  }

  if (delinquentSince === null) {
    return {
      state: 'active',
      since: lastEventAt,
      reason,
      delinquentSince: null,
      graceStartsAt: null,
      graceEndsAt: null,
      subscriptionId,
      lastEventId,
      lastEventAt,
      applied,
      duplicates,
    };
  }

  // An explicit escalation can only pull the rung EARLIER, never push it out.
  const graceStartsAt = Math.min(explicitGraceAt ?? Number.POSITIVE_INFINITY, delinquentSince + window);
  const graceEndsAt = graceStartsAt + window;

  const state: SubscriptionStateName =
    asOf >= graceEndsAt ? 'locked' : asOf >= graceStartsAt ? 'grace' : 'past_due';
  const since = state === 'locked' ? graceEndsAt : state === 'grace' ? graceStartsAt : delinquentSince;
  const clockReason =
    state === 'locked' ? `${reason} → grace expired` : state === 'grace' ? `${reason} → grace` : reason;

  return {
    state,
    since,
    reason: clockReason,
    delinquentSince,
    graceStartsAt,
    graceEndsAt,
    subscriptionId,
    lastEventId,
    lastEventAt,
    applied,
    duplicates,
  };
}

// ── Entitlements ─────────────────────────────────────────────────────────

/**
 * What a state may do. Read the invariants at the top of the file first — the
 * three `true`-in-every-column flags below are the product promise, not a
 * default someone forgot to tighten.
 */
export interface Entitlements {
  state: SubscriptionStateName;
  planId: string;
  /** ALWAYS true. The embedded configurator serves in every state. */
  widget: boolean;
  /** ALWAYS true. Shoppers keep configuring; the usage is still metered. */
  configuratorSessions: boolean;
  /** ALWAYS true. Reads never lock — the storefront is built on them. */
  catalogRead: boolean;
  apiRead: boolean;
  /** False when locked: the catalogue freezes read-only. */
  catalogWrite: boolean;
  apiWrite: boolean;
  /** False from grace on: renders are the expensive async path. */
  renders: boolean;
  /** False from grace on: no NEW model goes live; live ones stay live. */
  modelPublish: boolean;
  /** The plan's ceiling, or `null` for none. Frozen while degraded. */
  modelsLiveCap: number | null;
  modelsLiveFrozen: boolean;
  seats: number;
  /** True only when locked — the single flag a UI needs to go read-only. */
  readOnly: boolean;
  /** Usage keeps being metered while degraded: we serve it, so it is owed. */
  metered: boolean;
  banner: 'none' | 'payment_failed' | 'grace_ending' | 'locked';
}

function stateNameOf(state: SubscriptionStateName | SubscriptionState): SubscriptionStateName {
  return typeof state === 'string' ? state : state.state;
}

/**
 * The matrix.
 *
 *                       active  past_due  grace  locked
 *   widget                 ✓       ✓        ✓      ✓     ← never 404s
 *   configuratorSessions   ✓       ✓        ✓      ✓
 *   catalogRead / apiRead  ✓       ✓        ✓      ✓
 *   catalogWrite/apiWrite  ✓       ✓        ✓      ✗
 *   renders                ✓       ✓        ✗      ✗
 *   modelPublish           ✓       ✓        ✗      ✗
 *   modelsLive             cap     cap    frozen  frozen
 *   metered                ✓       ✓        ✓      ✓
 *
 * Accepts either the state name or the whole `SubscriptionState`.
 */
export function entitlementsFor(
  state: SubscriptionStateName | SubscriptionState,
  plan: Plan,
): Entitlements {
  const name = stateNameOf(state);
  const degraded = name === 'grace' || name === 'locked';
  const locked = name === 'locked';

  return {
    state: name,
    planId: plan.id,
    widget: true,
    configuratorSessions: true,
    catalogRead: true,
    apiRead: true,
    catalogWrite: !locked,
    apiWrite: !locked,
    renders: !degraded,
    modelPublish: !degraded,
    modelsLiveCap: plan.limits.hardModelsLive,
    modelsLiveFrozen: degraded,
    seats: plan.limits.seats,
    readOnly: locked,
    metered: true,
    banner: locked ? 'locked' : name === 'grace' ? 'grace_ending' : name === 'past_due' ? 'payment_failed' : 'none',
  };
}
