// THE PLAN MODEL — pricing as DATA, never as code.
//
// A plan is a row: a base amount, an allowance, per-unit overage rates and hard
// limits. Nothing here branches on a plan id, because the moment a rate lives in
// an `if (plan.id === 'growth')` the price sheet and the billing engine can
// disagree — and the one that's wrong is always the one nobody re-read.
//
// MONEY UNITS: every amount in a `Plan` is an INTEGER in the currency's MINOR
// units (cents), exactly like the DB column and exactly like Stripe's wire. The
// engine never leaves that representation, so a charge is a sum of integers and
// cannot drift. `@veta/catalog` owns the major↔minor crossing (`toMinor` /
// `fromMinor`); this package imports it rather than restating the rounding rule.
//
// PLACEHOLDER PRICING: `DEFAULT_PLANS` carries invented numbers so the engine
// has something to run against. Every one of them is flagged
// `placeholderPricing: true` — a plan that reaches production carries the
// commercial team's real figures and drops that flag.

import { fromMinor, toMinor } from '@veta/catalog';

/** What we count. `model_live` is a GAUGE, the other two are counters — see metering.ts. */
export type MeterKind = 'session' | 'render' | 'model_live';

/** Iteration order for every per-kind roll-up, so reports never shuffle. */
export const METER_KINDS: readonly MeterKind[] = ['session', 'render', 'model_live'];

/** An amount in INTEGER minor units plus the ISO code it is denominated in. */
export interface Money {
  /** Integer minor units (cents). Never a float, never major units. */
  amount: number;
  /** ISO 4217, uppercase. */
  currency: string;
}

/** How much of each meter the base price already covers, per period. */
export interface PlanAllowance {
  sessions: number;
  renders: number;
  modelsLive: number;
}

/** Per-unit price of the FIRST unit past the allowance, in minor units. */
export interface PlanOverageRates {
  session: number;
  render: number;
  modelLive: number;
}

/**
 * Ceilings. `hardModelsLive` is a REFUSAL (the API stops publishing), while
 * `overageCapMinor` is a SPEND GUARD: past it we keep serving and stop billing,
 * because a runaway integration must cost the brand nothing it did not agree to.
 * `null` on either means "no ceiling" — deliberate, only on the top plan.
 */
export interface PlanLimits {
  seats: number;
  collections: number;
  hardModelsLive: number | null;
  overageCapMinor: number | null;
}

/**
 * The Stripe ids a plan maps onto. Opaque strings minted in the Stripe
 * dashboard, so they are DATA on the plan, never derived from the plan id.
 * Absent until someone wires the account — the builders report that rather than
 * inventing a price id.
 */
export interface PlanStripeRefs {
  basePriceId?: string;
  sessionPriceId?: string;
  renderPriceId?: string;
  modelLivePriceId?: string;
  /** Billing-meter `event_name` per kind, for usage reporting. */
  meterEventNames?: Partial<Record<MeterKind, string>>;
}

/** Annual billing is a later WP; the literal type makes adding it a typed change. */
export type BillingInterval = 'month';

export interface Plan {
  id: string;
  name: string;
  /** Recurring base charge for one interval, minor units. */
  base: Money;
  interval: BillingInterval;
  included: PlanAllowance;
  overage: PlanOverageRates;
  limits: PlanLimits;
  /** True while the figures are invented. Real pricing drops the flag. */
  placeholderPricing: boolean;
  stripe?: PlanStripeRefs;
}

// ── Money helpers at the authoring boundary ──────────────────────────────
// A price sheet is written in MAJOR units by a human ("$99"), stored in MINOR.
// These two are the only place this package crosses, and they delegate the
// rounding rule to @veta/catalog so it can't fork.

/** `moneyFromMajor(99, 'USD')` → `{ amount: 9900, currency: 'USD' }`. */
export function moneyFromMajor(major: number, currency: string): Money {
  const code = normalizeCurrency(currency);
  return { amount: toMinor(major, code), currency: code };
}

/** `moneyToMajor({ amount: 9900, currency: 'USD' })` → `99`. For display only. */
export function moneyToMajor(money: Money): number {
  return fromMinor(money.amount, money.currency);
}

/** A per-unit rate typed in major units → the integer the engine multiplies. */
export function rateFromMajor(major: number, currency: string): number {
  return toMinor(major, normalizeCurrency(currency));
}

function normalizeCurrency(currency: unknown): string {
  const code = String(currency ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : '';
}

// ── The placeholder price sheet ──────────────────────────────────────────

const USD = 'USD';

/**
 * PLACEHOLDER PRICING — invented, coherent, and marked as such. The ladder is
 * the usual shape: the base buys an allowance, the per-unit rate FALLS as the
 * plan grows (so overage never makes a smaller plan cheaper than the next one
 * up at the same volume), and the spend guard rises with it.
 */
export const DEFAULT_PLANS: readonly Plan[] = Object.freeze([
  {
    id: 'starter',
    name: 'Starter',
    base: moneyFromMajor(99, USD),
    interval: 'month',
    included: { sessions: 2_000, renders: 200, modelsLive: 25 },
    overage: {
      session: rateFromMajor(0.05, USD),
      render: rateFromMajor(0.4, USD),
      modelLive: rateFromMajor(3, USD),
    },
    limits: {
      seats: 3,
      collections: 2,
      hardModelsLive: 100,
      overageCapMinor: rateFromMajor(250, USD),
    },
    placeholderPricing: true,
  },
  {
    id: 'growth',
    name: 'Growth',
    base: moneyFromMajor(399, USD),
    interval: 'month',
    included: { sessions: 12_000, renders: 1_500, modelsLive: 120 },
    overage: {
      session: rateFromMajor(0.04, USD),
      render: rateFromMajor(0.3, USD),
      modelLive: rateFromMajor(2, USD),
    },
    limits: {
      seats: 10,
      collections: 8,
      hardModelsLive: 500,
      overageCapMinor: rateFromMajor(1_000, USD),
    },
    placeholderPricing: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    base: moneyFromMajor(1_499, USD),
    interval: 'month',
    included: { sessions: 60_000, renders: 8_000, modelsLive: 600 },
    overage: {
      session: rateFromMajor(0.03, USD),
      render: rateFromMajor(0.22, USD),
      modelLive: rateFromMajor(1.5, USD),
    },
    limits: {
      seats: 40,
      collections: 40,
      hardModelsLive: null,
      overageCapMinor: null,
    },
    placeholderPricing: true,
  },
]);

/** Lookup by id over any plan list; `null` beats a wrong plan. */
export function planById(id: unknown, plans: readonly Plan[] = DEFAULT_PLANS): Plan | null {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  return plans.find((p) => p.id === wanted) ?? null;
}

// ── Validation: drop-and-report ──────────────────────────────────────────
//
// Same posture as `@veta/rules`: STRICT AT WRITE (an admin saves a plan only
// when `dropped` is empty) and LENIENT AT READ (a stored plan with one junk
// field still bills, with the fallback REPORTED). Nothing here throws — junk
// costs the field, never the invoice.

/** Ceilings that stop a fabricated plan from billing an absurd amount. */
export const MAX_BASE_MINOR = 100_000_00;
export const MAX_RATE_MINOR = 1_000_00;
export const MAX_ALLOWANCE = 100_000_000;
export const MAX_SEATS = 10_000;
const MAX_ID_LEN = 64;
const MAX_NAME_LEN = 120;

export interface PlanProblem {
  /** Dotted path inside the raw plan, or `''` for a document-level refusal. */
  path: string;
  reason: string;
}

export interface PlanParseResult {
  /** `null` when the plan was refused outright. */
  plan: Plan | null;
  dropped: PlanProblem[];
}

export interface PlansParseResult {
  plans: Plan[];
  dropped: (PlanProblem & { index: number })[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * A non-negative SAFE INTEGER, or `null`. Floats are refused rather than
 * rounded: a fractional minor unit is a major/minor mix-up, and rounding it
 * would launder a 100× pricing error into a plausible number.
 */
function nonNegInt(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (!Number.isSafeInteger(v)) return null;
  if (v < 0 || v > max) return null;
  return v;
}

/** Parse one raw plan. See the posture note above. */
export function parsePlan(raw: unknown): PlanParseResult {
  const dropped: PlanProblem[] = [];
  const drop = (path: string, reason: string): PlanParseResult => {
    dropped.push({ path, reason });
    return { plan: null, dropped };
  };
  const note = (path: string, reason: string) => dropped.push({ path, reason });

  if (!isPlainObject(raw)) return drop('', 'not an object');

  const id = str(raw.id, MAX_ID_LEN);
  if (!id) return drop('id', 'missing');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return drop('id', 'must be alphanumeric with - or _');

  const name = str(raw.name, MAX_NAME_LEN) || id;
  if (!str(raw.name, MAX_NAME_LEN)) note('name', `missing — fell back to the id "${id}"`);

  // Base: the one field with no safe fallback. A plan whose price we cannot
  // read is not a plan we may bill on.
  const rawBase = isPlainObject(raw.base) ? raw.base : null;
  if (!rawBase) return drop('base', 'missing or not an object');
  const currency = normalizeCurrency(rawBase.currency);
  if (!currency) return drop('base.currency', 'missing or not a 3-letter ISO 4217 code');
  const baseAmount = nonNegInt(rawBase.amount, MAX_BASE_MINOR);
  if (baseAmount === null) {
    return drop('base.amount', `not a non-negative integer of minor units ≤ ${MAX_BASE_MINOR}`);
  }

  if (raw.interval !== undefined && raw.interval !== 'month') {
    return drop('interval', "only 'month' is supported");
  }

  const rawIncluded = isPlainObject(raw.included) ? raw.included : {};
  if (!isPlainObject(raw.included)) note('included', 'missing — every allowance fell back to 0');
  const included: PlanAllowance = {
    sessions: allowance(rawIncluded.sessions, 'included.sessions'),
    renders: allowance(rawIncluded.renders, 'included.renders'),
    modelsLive: allowance(rawIncluded.modelsLive, 'included.modelsLive'),
  };

  const rawOverage = isPlainObject(raw.overage) ? raw.overage : {};
  if (!isPlainObject(raw.overage)) note('overage', 'missing — every rate fell back to 0 (no overage billed)');
  const overage: PlanOverageRates = {
    session: rate(rawOverage.session, 'overage.session'),
    render: rate(rawOverage.render, 'overage.render'),
    modelLive: rate(rawOverage.modelLive, 'overage.modelLive'),
  };

  const rawLimits = isPlainObject(raw.limits) ? raw.limits : {};
  const limits: PlanLimits = {
    seats: bounded(rawLimits.seats, MAX_SEATS, 1, 'limits.seats'),
    collections: bounded(rawLimits.collections, MAX_ALLOWANCE, 1, 'limits.collections'),
    hardModelsLive: nullableBound(rawLimits.hardModelsLive, MAX_ALLOWANCE, 'limits.hardModelsLive'),
    overageCapMinor: nullableBound(rawLimits.overageCapMinor, MAX_BASE_MINOR, 'limits.overageCapMinor'),
  };

  const stripe = parseStripeRefs(raw.stripe, note);

  const plan: Plan = {
    id,
    name,
    base: { amount: baseAmount, currency },
    interval: 'month',
    included,
    overage,
    limits,
    placeholderPricing: raw.placeholderPricing === true,
    ...(stripe ? { stripe } : {}),
  };
  return { plan, dropped };

  function allowance(v: unknown, path: string): number {
    if (v === undefined) return 0;
    const n = nonNegInt(v, MAX_ALLOWANCE);
    if (n === null) {
      note(path, `not a non-negative integer ≤ ${MAX_ALLOWANCE} — fell back to 0`);
      return 0;
    }
    return n;
  }

  function rate(v: unknown, path: string): number {
    if (v === undefined) return 0;
    const n = nonNegInt(v, MAX_RATE_MINOR);
    if (n === null) {
      note(path, `not a non-negative integer of minor units ≤ ${MAX_RATE_MINOR} — fell back to 0`);
      return 0;
    }
    return n;
  }

  function bounded(v: unknown, max: number, fallback: number, path: string): number {
    if (v === undefined) return fallback;
    const n = nonNegInt(v, max);
    if (n === null) {
      note(path, `not a non-negative integer ≤ ${max} — fell back to ${fallback}`);
      return fallback;
    }
    return n;
  }

  function nullableBound(v: unknown, max: number, path: string): number | null {
    if (v === undefined || v === null) return null;
    const n = nonNegInt(v, max);
    if (n === null) {
      note(path, `not a non-negative integer ≤ ${max} — fell back to no ceiling`);
      return null;
    }
    return n;
  }
}

function parseStripeRefs(
  raw: unknown,
  note: (path: string, reason: string) => void,
): PlanStripeRefs | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    note('stripe', 'not an object — dropped');
    return null;
  }
  const refs: PlanStripeRefs = {};
  for (const key of ['basePriceId', 'sessionPriceId', 'renderPriceId', 'modelLivePriceId'] as const) {
    const v = str(raw[key], MAX_ID_LEN);
    if (v) refs[key] = v;
    else if (raw[key] !== undefined) note(`stripe.${key}`, 'not a string — dropped');
  }
  if (isPlainObject(raw.meterEventNames)) {
    const names: Partial<Record<MeterKind, string>> = {};
    for (const kind of METER_KINDS) {
      const v = str(raw.meterEventNames[kind], MAX_ID_LEN);
      if (v) names[kind] = v;
    }
    if (Object.keys(names).length) refs.meterEventNames = names;
  }
  return Object.keys(refs).length ? refs : null;
}

/**
 * Parse a list. A refused plan takes only itself out of the catalogue — the
 * remaining plans still bill, and the refusal is reported with its index.
 */
export function parsePlans(raw: unknown): PlansParseResult {
  const plans: Plan[] = [];
  const dropped: (PlanProblem & { index: number })[] = [];
  if (!Array.isArray(raw)) {
    return { plans, dropped: [{ index: -1, path: '', reason: 'not an array' }] };
  }
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const res = parsePlan(entry);
    for (const p of res.dropped) dropped.push({ index, ...p });
    if (!res.plan) return;
    if (seen.has(res.plan.id)) {
      dropped.push({ index, path: 'id', reason: `duplicate plan id "${res.plan.id}" — dropped` });
      return;
    }
    seen.add(res.plan.id);
    plans.push(res.plan);
  });
  return { plans, dropped };
}

/** Strict-at-write gate: a plan may be activated only when nothing was dropped. */
export function isActivatablePlan(result: PlanParseResult): boolean {
  return result.plan !== null && result.dropped.length === 0;
}
