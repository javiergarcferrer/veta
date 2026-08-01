// METERING — raw events in, one invoice line per meter out.
//
// Three decisions carry the whole module, and each of them is a money rule:
//
//  1. PERIODS ARE UTC AND HALF-OPEN. `[start, end)`. An event stamped exactly at
//     `start` belongs to this period; one stamped exactly at `end` belongs to
//     the NEXT one. Anything else double-bills the boundary event or loses it,
//     and both are silent.
//
//  2. A DATE-TIME WITHOUT AN OFFSET IS UTC. `new Date('2026-03-31T23:30:00')` is
//     resolved in the MACHINE's zone, so the same event lands in March on one
//     server and April on another — the invoice would depend on where the worker
//     ran. `parseInstant` appends the `Z` the string is missing.
//
//  3. COUNTERS SUM, GAUGES PEAK. Sessions and renders are counters: every event
//     is a new billable thing, so they add. `model_live` is a GAUGE — a
//     heartbeat reporting how many models are currently published. Summing 30
//     nightly heartbeats would bill the same 25 models 30 times, so a gauge
//     takes the PEAK observed in the period, which is what "you had this many
//     live" means on an invoice.
//
// All arithmetic stays in INTEGER minor units: `qty × rate` of two integers is
// exact, so nothing rounds and nothing drifts. Nothing here throws — a junk
// event costs itself and is reported, never the whole invoice.

import type { MeterKind, Money, Plan } from './plans.ts';
import { METER_KINDS } from './plans.ts';

export const DAY_MS = 86_400_000;

/**
 * Below this, a numeric instant is read as SECONDS and multiplied up. 1e11 ms is
 * 1973 — no billing event predates it, while every plausible epoch-SECONDS
 * stamp (Stripe's wire format) is under it. The correction is what stops a
 * Stripe `created` from filing an event in 1970.
 */
export const SECONDS_CUTOFF = 1e11;

/** A raw usage event as the API/widget/render worker emits it. */
export interface MeterEvent {
  orgId: string;
  kind: MeterKind;
  /** Epoch ms (or seconds, auto-corrected), an ISO string, or a Date. */
  at: number | string | Date;
  /** Non-negative integer. `0` is meaningful for a gauge ("nothing live now"). */
  qty: number;
}

/** A half-open UTC window `[start, end)`. `label` is the invoice's period key. */
export interface Period {
  start: number;
  end: number;
  /** `YYYY-MM` for a month — stable, sortable, and safe in an idempotency key. */
  label: string;
}

export type MeterTotals = Record<MeterKind, number>;

export interface Usage {
  orgId: string;
  period: Period;
  totals: MeterTotals;
  /** How many events fed these totals — the audit handle on a surprising number. */
  events: number;
}

export interface DroppedEvent {
  /** Index in the input array. */
  index: number;
  reason: string;
  orgId: string | null;
}

export interface AggregateResult {
  /** One entry per org that had at least one accepted event, org id ascending. */
  usage: Usage[];
  byOrg: Record<string, Usage>;
  dropped: DroppedEvent[];
  /** Accepted events that fell OUTSIDE the window — not an error, just not ours. */
  outOfPeriod: number;
}

/** How each meter rolls up. See decision 3 above. */
export const KIND_AGGREGATION: Readonly<Record<MeterKind, 'sum' | 'peak'>> = Object.freeze({
  session: 'sum',
  render: 'sum',
  model_live: 'peak',
});

const KIND_SET: ReadonlySet<string> = new Set(METER_KINDS);

/** Every meter at zero — the shape a roll-up always has, even for an idle org. */
export function emptyTotals(): MeterTotals {
  return { session: 0, render: 0, model_live: 0 };
}

const ISO_WITH_ZONE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Any accepted instant → epoch ms, or `null`.
 *
 * A bare date (`2026-03-01`) is already UTC by spec. A date-TIME with no offset
 * gets one appended (decision 2). A number under `SECONDS_CUTOFF` is seconds.
 */
export function parseInstant(at: unknown): number | null {
  if (at instanceof Date) {
    const ms = at.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof at === 'number') {
    if (!Number.isFinite(at) || at < 0) return null;
    return at < SECONDS_CUTOFF ? Math.round(at * 1000) : Math.round(at);
  }
  if (typeof at !== 'string') return null;
  const raw = at.trim();
  if (!raw) return null;
  const normalized = ISO_DATE_ONLY.test(raw) || ISO_WITH_ZONE.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** The UTC calendar month containing nothing but `year`/`month` (1–12). */
export function monthPeriod(year: number, month: number): Period {
  const y = Math.trunc(year);
  const m = Math.min(12, Math.max(1, Math.trunc(month)));
  const start = Date.UTC(y, m - 1, 1);
  // Month 12 rolls into January of y+1 — Date.UTC handles the overflow itself.
  const end = Date.UTC(y, m, 1);
  return { start, end, label: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}` };
}

/** The UTC month that contains `at`. The default billing window. */
export function periodFor(at: number | string | Date = Date.now()): Period {
  const ms = parseInstant(at);
  const d = new Date(ms ?? Date.now());
  return monthPeriod(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/** True when `at` falls inside the half-open window. The boundary rule, once. */
export function inPeriod(at: number, period: Period): boolean {
  return at >= period.start && at < period.end;
}

/**
 * Roll raw events up per org and per kind for one period.
 *
 * Refused (reported, never silently absorbed): a missing org, an unknown kind, an
 * unreadable instant, a qty that is not a non-negative safe integer. An event
 * that parses cleanly but sits outside the window is NOT a refusal — it belongs
 * to another invoice — and is counted in `outOfPeriod`.
 */
export function aggregateUsage(
  events: readonly MeterEvent[] | null | undefined,
  period: Period = periodFor(),
): AggregateResult {
  const byOrg: Record<string, Usage> = {};
  const dropped: DroppedEvent[] = [];
  let outOfPeriod = 0;

  const list = Array.isArray(events) ? events : [];
  list.forEach((event, index) => {
    if (!event || typeof event !== 'object') {
      dropped.push({ index, reason: 'not an object', orgId: null });
      return;
    }
    const orgId = typeof event.orgId === 'string' ? event.orgId.trim() : '';
    if (!orgId) {
      dropped.push({ index, reason: 'missing orgId', orgId: null });
      return;
    }
    const kind = event.kind as string;
    if (!KIND_SET.has(kind)) {
      dropped.push({ index, reason: `unknown kind "${String(event.kind)}"`, orgId });
      return;
    }
    const at = parseInstant(event.at);
    if (at === null) {
      dropped.push({ index, reason: `unreadable timestamp "${String(event.at)}"`, orgId });
      return;
    }
    const qty = event.qty;
    if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 0) {
      dropped.push({ index, reason: `qty must be a non-negative integer, got ${String(qty)}`, orgId });
      return;
    }
    if (!inPeriod(at, period)) {
      outOfPeriod += 1;
      return;
    }

    const bucket = (byOrg[orgId] ??= { orgId, period, totals: emptyTotals(), events: 0 });
    bucket.events += 1;
    const meter = kind as MeterKind;
    if (KIND_AGGREGATION[meter] === 'peak') {
      bucket.totals[meter] = Math.max(bucket.totals[meter], qty);
    } else {
      bucket.totals[meter] += qty;
    }
  });

  const usage = Object.keys(byOrg)
    .sort()
    .map((id) => byOrg[id]);
  return { usage, byOrg, dropped, outOfPeriod };
}

// ── Usage against a plan ─────────────────────────────────────────────────

/** One meter's line on the projected invoice. `qty` is what is BILLABLE. */
export interface OverageLine {
  kind: MeterKind;
  used: number;
  included: number;
  /** Units past the allowance — 0 when inside it, never negative. */
  qty: number;
  /** Minor units per unit, straight off the plan. */
  rateMinor: number;
  /** `qty × rateMinor`, exact integer arithmetic. */
  amountMinor: number;
}

export interface UsageAssessment {
  orgId: string;
  period: Period;
  planId: string;
  currency: string;
  included: MeterTotals;
  used: MeterTotals;
  /** One line per kind, in `METER_KINDS` order — a zero line still appears. */
  overage: OverageLine[];
  /** Sum of the lines, BEFORE the spend guard. */
  overageUncappedMinor: number;
  /** What we will actually bill: the sum, clamped at `limits.overageCapMinor`. */
  overageMinor: number;
  capped: boolean;
  baseMinor: number;
  /** `base + capped overage`, minor units, with its currency. */
  projectedCharge: Money;
  /**
   * Hard limits the usage went past. Not a charge — a REFUSAL the API owes the
   * caller (we never bill past `hardModelsLive`, we stop publishing).
   */
  breaches: string[];
}

const ALLOWANCE_KEY: Readonly<Record<MeterKind, keyof Plan['included']>> = Object.freeze({
  session: 'sessions',
  render: 'renders',
  model_live: 'modelsLive',
});

const RATE_KEY: Readonly<Record<MeterKind, keyof Plan['overage']>> = Object.freeze({
  session: 'session',
  render: 'render',
  model_live: 'modelLive',
});

/**
 * Price one org's period against its plan.
 *
 * Everything is integer minor units end to end, so `projectedCharge` is exact to
 * the cent by construction — there is no rounding step to get wrong.
 */
export function usageAgainstPlan(usage: Usage, plan: Plan): UsageAssessment {
  const included: MeterTotals = emptyTotals();
  const used: MeterTotals = emptyTotals();
  const overage: OverageLine[] = [];
  let overageUncappedMinor = 0;

  for (const kind of METER_KINDS) {
    const allowance = plan.included[ALLOWANCE_KEY[kind]] || 0;
    const consumed = usage.totals[kind] || 0;
    const rateMinor = plan.overage[RATE_KEY[kind]] || 0;
    const qty = Math.max(0, consumed - allowance);
    const amountMinor = qty * rateMinor;
    included[kind] = allowance;
    used[kind] = consumed;
    overage.push({ kind, used: consumed, included: allowance, qty, rateMinor, amountMinor });
    overageUncappedMinor += amountMinor;
  }

  const cap = plan.limits.overageCapMinor;
  const capped = cap !== null && overageUncappedMinor > cap;
  const overageMinor = capped ? (cap as number) : overageUncappedMinor;

  const breaches: string[] = [];
  const hardModels = plan.limits.hardModelsLive;
  if (hardModels !== null && used.model_live > hardModels) {
    breaches.push(`models_live ${used.model_live} over hard limit ${hardModels}`);
  }

  return {
    orgId: usage.orgId,
    period: usage.period,
    planId: plan.id,
    currency: plan.base.currency,
    included,
    used,
    overage,
    overageUncappedMinor,
    overageMinor,
    capped,
    baseMinor: plan.base.amount,
    projectedCharge: { amount: plan.base.amount + overageMinor, currency: plan.base.currency },
    breaches,
  };
}

/** Assess every org in one aggregation against the same plan. Convenience only. */
export function assessAll(result: AggregateResult, plan: Plan): UsageAssessment[] {
  return result.usage.map((u) => usageAgainstPlan(u, plan));
}
