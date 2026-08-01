// @veta/billing — what a tenant OWES and what a tenant may DO.
//
// Three layers, one direction: plans (data) → metering (aggregation + money)
// → the Stripe boundary (types + pure builders + the state machine). No HTTP, no
// crypto, no Stripe SDK — the API edge owns the I/O and hands this package
// already-verified inputs, which is what makes every rule below testable
// without a key.
//
// Money never leaves INTEGER minor units, so a projected charge is a sum of
// integers and cannot drift. `@veta/catalog` owns the major↔minor crossing.
//
// The rule worth reading twice, spelled out in `stripe/wire.ts`: THE WIDGET
// STAYS UP IN EVERY STATE, `locked` included. We degrade writes and the
// expensive async paths; a brand's storefront never 404s over a card.

// ── Plans: pricing as data ────────────────────────────────────────────────
export {
  METER_KINDS,
  DEFAULT_PLANS,
  planById,
  parsePlan,
  parsePlans,
  isActivatablePlan,
  moneyFromMajor,
  moneyToMajor,
  rateFromMajor,
  MAX_BASE_MINOR,
  MAX_RATE_MINOR,
  MAX_ALLOWANCE,
  MAX_SEATS,
} from './plans.ts';
export type {
  MeterKind,
  Money,
  Plan,
  PlanAllowance,
  PlanOverageRates,
  PlanLimits,
  PlanStripeRefs,
  BillingInterval,
  PlanProblem,
  PlanParseResult,
  PlansParseResult,
} from './plans.ts';

// ── Metering: events → totals → a priced period ───────────────────────────
export {
  DAY_MS,
  SECONDS_CUTOFF,
  KIND_AGGREGATION,
  emptyTotals,
  parseInstant,
  monthPeriod,
  periodFor,
  inPeriod,
  aggregateUsage,
  usageAgainstPlan,
  assessAll,
} from './metering.ts';
export type {
  MeterEvent,
  Period,
  MeterTotals,
  Usage,
  DroppedEvent,
  AggregateResult,
  OverageLine,
  UsageAssessment,
} from './metering.ts';

// ── The Stripe boundary: types, pure builders, state, entitlements ────────
export {
  buildSubscriptionSpec,
  buildUsageRecords,
  parseWebhookEvent,
  subscriptionStateFrom,
  entitlementsFor,
  STRIPE_METER_EVENT_NAMES,
  BILLING_EVENT_TYPES,
  STRIPE_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATES,
  GRACE_DAYS,
} from './stripe/wire.ts';
export type {
  BillingOrg,
  SubscriptionItemSpec,
  SubscriptionSpecBody,
  SubscriptionSpec,
  SubscriptionSpecOptions,
  SubscriptionSpecResult,
  WireProblem,
  UsageRecord,
  UsageRecordsResult,
  UsageRecordsOptions,
  BillingEvent,
  BillingEventType,
  StripeSubscriptionStatus,
  WebhookRefusal,
  WebhookParse,
  SubscriptionStateName,
  SubscriptionState,
  SubscriptionStateOptions,
  Entitlements,
} from './stripe/wire.ts';
