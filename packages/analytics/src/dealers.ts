// PER-DEALER CONVERSION — leads → contacted → converted, and how fast.
//
// The rules that keep this report honest:
//
// • A DEALER WITH ZERO LEADS IS A ROW OF ZEROS, never an absence. "Who is not
//   getting leads" and "who is sitting on them" are the two questions this table
//   exists to answer, and a dealer that vanishes when its count hits zero can
//   answer neither. Pass the roster in `options.dealers` and every one of them
//   appears; leads with no dealer land in `unassigned`, which is likewise always
//   present.
//
// • RATES ARE NULL, NOT ZERO, WHEN THERE IS NOTHING TO DIVIDE. 0 converted of 0
//   leads is not a 0% dealer.
//
// • THE PROGRESSION IS MONOTONE, like the funnel: a CONVERTED lead was contacted,
//   whether or not anyone stamped it. So `contacted` counts contacted ∪ converted
//   ∪ anything carrying a contact stamp.
//
// • A MEDIAN SAYS WHAT IT IS BUILT FROM. Response time is created → contacted;
//   the preferred source is an explicit `contacted_at`, the fallback is
//   `updated_at` on a lead that HAS advanced, and a lead that advanced with
//   neither is counted in `responseBasis.missing` rather than quietly leaving
//   the median with a shorter, prettier sample.
//
// • MONEY NEVER CROSSES CURRENCIES (see money.ts). Pipeline value is a list of
//   per-currency totals; there is no grand total to misread.

import {
  dataRange,
  inPeriod,
  normalizeEvents,
  payloadOf,
  readStamp,
  readString,
  resolvePeriod,
} from './normalize.ts';
import { medianMs, pct } from './stats.ts';
import { moneyEntryOf, sumMinorByCurrency } from './money.ts';
import type { MoneyEntry, MoneySummary } from './money.ts';
import { EVENT_KINDS } from './types.ts';
import type { AnalyticsEvent, DateInput, Period, ResolvedPeriod } from './types.ts';

/** The lead statuses the platform stores. Anything else counts as `otherStatus`. */
export const LEAD_STATUSES = ['pending', 'contacted', 'converted', 'dismissed'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** A `public.leads` row, read loosely (both casings; stamps optional). */
export interface LeadRow {
  id?: string | null;
  dealerId?: string | null;
  dealer_id?: string | null;
  status?: string | null;
  createdAt?: DateInput | null;
  created_at?: DateInput | null;
  updatedAt?: DateInput | null;
  updated_at?: DateInput | null;
  contactedAt?: DateInput | null;
  contacted_at?: DateInput | null;
  convertedAt?: DateInput | null;
  converted_at?: DateInput | null;
  sessionId?: string | null;
  session_id?: string | null;
  /** Explicit routing flag, when the platform stamps one. */
  routed?: boolean | null;
  source?: Record<string, unknown> | null;
  estimate?: unknown;
  [key: string]: unknown;
}

export interface DealerRef {
  id: string;
  name?: string | null;
  [key: string]: unknown;
}

export interface ResponseBasis {
  /** From an explicit contact stamp. */
  stamped: number;
  /** From `updated_at` on an advanced lead — weaker, and labelled as such. */
  derived: number;
  /** Advanced, but with no usable stamp: outside the median, inside the report. */
  missing: number;
}

export interface DealerConversionRow {
  dealerId: string | null;
  dealerName: string | null;
  leads: number;
  pending: number;
  contacted: number;
  converted: number;
  dismissed: number;
  otherStatus: number;
  contactedRate: number | null;
  convertedRate: number | null;
  convertedOfContactedRate: number | null;
  medianResponseMs: number | null;
  responseSamples: number;
  responseBasis: ResponseBasis;
  /** Routed by the platform at submit time. */
  routed: number;
  /** Attached to the dealer some other way (manual assignment, back-office entry). */
  manual: number;
  value: MoneySummary;
  convertedValue: MoneySummary;
}

export interface DealerConversionReport {
  period: ResolvedPeriod;
  dealers: DealerConversionRow[];
  /** Leads with no dealer — always present, even at zero. */
  unassigned: DealerConversionRow;
  /** Every lead in scope, dealers and unassigned together. */
  totals: DealerConversionRow;
  excluded: {
    /** Leads with no readable creation stamp (only excluded when a bound was set). */
    undatedLeads: number;
    outOfPeriod: number;
    /** Junk rows in the leads array. */
    unreadableLeads: number;
    undatedEvents: number;
    unkindedEvents: number;
  };
}

export interface DealerConversionOptions {
  period?: Period | null;
  /** The roster. Every dealer here appears in the report, leads or not. */
  dealers?: readonly (DealerRef | null | undefined)[] | null;
}

interface Bucket {
  dealerId: string | null;
  dealerName: string | null;
  leads: number;
  pending: number;
  contacted: number;
  converted: number;
  dismissed: number;
  otherStatus: number;
  responses: number[];
  basis: ResponseBasis;
  routed: number;
  manual: number;
  value: MoneyEntry[];
  convertedValue: MoneyEntry[];
}

const newBucket = (dealerId: string | null, dealerName: string | null): Bucket => ({
  dealerId,
  dealerName,
  leads: 0,
  pending: 0,
  contacted: 0,
  converted: 0,
  dismissed: 0,
  otherStatus: 0,
  responses: [],
  basis: { stamped: 0, derived: 0, missing: 0 },
  routed: 0,
  manual: 0,
  value: [],
  convertedValue: [],
});

function finish(bucket: Bucket): DealerConversionRow {
  return {
    dealerId: bucket.dealerId,
    dealerName: bucket.dealerName,
    leads: bucket.leads,
    pending: bucket.pending,
    contacted: bucket.contacted,
    converted: bucket.converted,
    dismissed: bucket.dismissed,
    otherStatus: bucket.otherStatus,
    contactedRate: pct(bucket.contacted, bucket.leads),
    convertedRate: pct(bucket.converted, bucket.leads),
    convertedOfContactedRate: pct(bucket.converted, bucket.contacted),
    medianResponseMs: medianMs(bucket.responses),
    responseSamples: bucket.responses.length,
    responseBasis: bucket.basis,
    routed: bucket.routed,
    manual: bucket.manual,
    value: sumMinorByCurrency(bucket.value),
    convertedValue: sumMinorByCurrency(bucket.convertedValue),
  };
}

/**
 * Per-dealer conversion over the leads table, with the event stream deciding
 * which leads the platform ROUTED (a `lead.submit` beacon naming the same lead —
 * or the same session — and the same dealer) versus which were attached by hand.
 */
export function resolveDealerConversion(
  leads: readonly (LeadRow | null | undefined)[] | null | undefined,
  events: readonly (AnalyticsEvent | null | undefined)[] | null | undefined = [],
  options: DealerConversionOptions = {},
): DealerConversionReport {
  const normalized = normalizeEvents(events);
  const period = resolvePeriodForLeads(options.period, leads, normalized.events);

  // Routing evidence: a lead.submit event, keyed by the lead it names and by the
  // session it came from. Both keys are needed — the widget knows its session
  // before the API answers with an id, and the API answers with an id the widget
  // may beacon afterwards.
  const submitByLead = new Map<string, string | null>();
  const submitBySession = new Map<string, string | null>();
  for (const event of normalized.events) {
    if (event.kind !== EVENT_KINDS.leadSubmit) continue;
    const leadId = readString(event.payload, ['leadId', 'lead_id', 'id']);
    const dealerId = readString(event.payload, ['dealerId', 'dealer_id']) || null;
    if (leadId) submitByLead.set(leadId, dealerId);
    if (event.sessionId) submitBySession.set(event.sessionId, dealerId);
  }

  const buckets = new Map<string, Bucket>();
  for (const dealer of options.dealers ?? []) {
    if (!dealer || typeof dealer !== 'object') continue;
    const id = readString(dealer as Record<string, unknown>, ['id', 'dealerId', 'dealer_id']);
    if (!id) continue;
    const name = readString(dealer as Record<string, unknown>, ['name', 'label', 'title']) || null;
    if (!buckets.has(id)) buckets.set(id, newBucket(id, name));
  }
  const unassigned = newBucket(null, null);

  const excluded = {
    undatedLeads: 0,
    outOfPeriod: 0,
    unreadableLeads: 0,
    undatedEvents: normalized.undated,
    unkindedEvents: normalized.unkinded,
  };

  for (const lead of leads ?? []) {
    if (!lead || typeof lead !== 'object') {
      excluded.unreadableLeads += 1;
      continue;
    }
    const row = lead as Record<string, unknown>;
    const createdAt = readStamp(row, ['createdAt', 'created_at']);
    if (createdAt === null) {
      // Same rule as configurations: a stamp only matters once a window is asked
      // for. Either way the row is counted where it went.
      if (period.explicit.from || period.explicit.to) {
        excluded.undatedLeads += 1;
        continue;
      }
    } else if (!inPeriod(createdAt, period)) {
      excluded.outOfPeriod += 1;
      continue;
    }

    const dealerId = readString(row, ['dealerId', 'dealer_id']) || null;
    let bucket: Bucket;
    if (dealerId) {
      let found = buckets.get(dealerId);
      if (!found) buckets.set(dealerId, (found = newBucket(dealerId, null)));
      bucket = found;
    } else {
      bucket = unassigned;
    }

    const status = readString(row, ['status']).toLowerCase();
    const contactedAt = readStamp(row, ['contactedAt', 'contacted_at']);
    const convertedAt = readStamp(row, ['convertedAt', 'converted_at']);
    const updatedAt = readStamp(row, ['updatedAt', 'updated_at']);
    const isConverted = status === 'converted' || convertedAt !== null;
    const isDismissed = status === 'dismissed';
    const wasContacted = isConverted || status === 'contacted' || contactedAt !== null;

    bucket.leads += 1;
    if (isConverted) bucket.converted += 1;
    if (wasContacted) bucket.contacted += 1;
    if (isDismissed) bucket.dismissed += 1;
    if (!wasContacted && !isDismissed && (status === 'pending' || !status)) bucket.pending += 1;
    if (status && !LEAD_STATUSES.includes(status as LeadStatus)) bucket.otherStatus += 1;

    if (wasContacted) {
      const stamp = contactedAt ?? (status === 'contacted' || isConverted ? updatedAt : null);
      const usable = createdAt !== null && stamp !== null && stamp >= createdAt;
      if (usable) {
        bucket.responses.push(stamp - createdAt);
        if (contactedAt !== null) bucket.basis.stamped += 1;
        else bucket.basis.derived += 1;
      } else {
        bucket.basis.missing += 1;
      }
    }

    const leadId = readString(row, ['id']);
    const sessionId = readString(row, ['sessionId', 'session_id']);
    const source = payloadOf(lead.source);
    // The platform's own stamp is the strongest evidence there is: the API
    // writes its routing verdict into `source.routing` at lead time, and an
    // `outcome: 'routed'` there outranks anything a beacon says.
    const stamp = payloadOf(source.routing);
    const flagged =
      lead.routed === true || source.routed === true || stamp.outcome === 'routed';
    const submitted =
      (leadId && submitByLead.has(leadId)) || (sessionId && submitBySession.has(sessionId));
    // A submit beacon that named ANOTHER dealer is not evidence this dealer was
    // routed the lead — that reassignment was a human decision.
    const routedDealer = leadId
      ? (submitByLead.get(leadId) ?? null)
      : sessionId
        ? (submitBySession.get(sessionId) ?? null)
        : null;
    const routed =
      flagged || (!!submitted && (!routedDealer || !dealerId || routedDealer === dealerId));
    if (routed) bucket.routed += 1;
    else bucket.manual += 1;

    const entry = moneyEntryOf(lead.estimate);
    bucket.value.push(entry);
    if (isConverted) bucket.convertedValue.push(entry);
  }

  const dealers = [...buckets.values()]
    .map(finish)
    .sort(
      (a, b) =>
        b.leads - a.leads ||
        b.converted - a.converted ||
        (a.dealerId! < b.dealerId! ? -1 : a.dealerId! > b.dealerId! ? 1 : 0),
    );

  const totals = newBucket(null, null);
  for (const bucket of [...buckets.values(), unassigned]) {
    totals.leads += bucket.leads;
    totals.pending += bucket.pending;
    totals.contacted += bucket.contacted;
    totals.converted += bucket.converted;
    totals.dismissed += bucket.dismissed;
    totals.otherStatus += bucket.otherStatus;
    totals.routed += bucket.routed;
    totals.manual += bucket.manual;
    totals.basis.stamped += bucket.basis.stamped;
    totals.basis.derived += bucket.basis.derived;
    totals.basis.missing += bucket.basis.missing;
    // The overall median is taken over EVERY sample, never as a median of
    // medians (which would weight a one-lead dealer like a hundred-lead one).
    totals.responses.push(...bucket.responses);
    totals.value.push(...bucket.value);
    totals.convertedValue.push(...bucket.convertedValue);
  }

  return { period, dealers, unassigned: finish(unassigned), totals: finish(totals), excluded };
}

/** The window: the caller's, else the span of the leads and events together. */
function resolvePeriodForLeads(
  period: Period | null | undefined,
  leads: readonly (LeadRow | null | undefined)[] | null | undefined,
  events: readonly { at: number }[],
): ResolvedPeriod {
  const stamps: { at: number }[] = [...events];
  for (const lead of leads ?? []) {
    if (!lead || typeof lead !== 'object') continue;
    const at = readStamp(lead as Record<string, unknown>, ['createdAt', 'created_at']);
    if (at !== null) stamps.push({ at });
  }
  return resolvePeriod(period, dataRange(stamps));
}
