// DEALER CONVERSION over fixture leads — zero-lead visibility, the monotone
// progression, what a median is built from, routed-vs-manual, and the money law.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_KINDS, resolveDealerConversion } from '../src/index.ts';
import type { AnalyticsEvent, DealerRef, LeadRow } from '../src/index.ts';

const T0 = Date.UTC(2026, 6, 1, 8, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const dealers: DealerRef[] = [
  { id: 'd-north', name: 'Norte' },
  { id: 'd-south', name: 'Sur' },
  { id: 'd-quiet', name: 'Silencioso' }, // never received a lead
];

const money = (amountMinor: number, currency: string) => ({ amount_minor: amountMinor, currency });

const leads: LeadRow[] = [
  // Contacted after 30 min, with an explicit stamp.
  {
    id: 'l1',
    dealer_id: 'd-north',
    status: 'contacted',
    created_at: new Date(T0).toISOString(),
    contacted_at: new Date(T0 + 30 * MIN).toISOString(),
    estimate: money(450_000, 'USD'),
  },
  // Converted, stamped 90 min after creation. Converted ⇒ also contacted.
  {
    id: 'l2',
    dealer_id: 'd-north',
    status: 'converted',
    created_at: new Date(T0 + HOUR).toISOString(),
    contacted_at: new Date(T0 + HOUR + 90 * MIN).toISOString(),
    estimate: money(1_200_000, 'USD'),
  },
  // Advanced with NO contact stamp: `updated_at` is the weaker, derived basis.
  {
    id: 'l3',
    dealer_id: 'd-north',
    status: 'contacted',
    created_at: new Date(T0 + 2 * HOUR).toISOString(),
    updated_at: new Date(T0 + 2 * HOUR + 10 * MIN).toISOString(),
    estimate: money(90_000, 'DOP'),
  },
  // Still waiting.
  { id: 'l4', dealer_id: 'd-north', status: 'pending', created_at: new Date(T0 + 3 * HOUR).toISOString() },
  // Contacted, but nothing anywhere says when: inside the report, outside the median.
  { id: 'l5', dealer_id: 'd-south', status: 'contacted', created_at: new Date(T0 + 4 * HOUR).toISOString() },
  { id: 'l6', dealer_id: 'd-south', status: 'dismissed', created_at: new Date(T0 + 5 * HOUR).toISOString() },
  // No dealer at all.
  { id: 'l7', dealer_id: null, status: 'pending', created_at: new Date(T0 + 6 * HOUR).toISOString() },
];

// l1/l2 were routed by the platform at submit; l3 names another dealer at
// submit (someone reassigned it); l5 was never beaconed at all.
const events: AnalyticsEvent[] = [
  {
    kind: EVENT_KINDS.leadSubmit,
    sessionId: 's1',
    occurredAt: new Date(T0).toISOString(),
    payload: { leadId: 'l1', dealerId: 'd-north' },
  },
  {
    kind: EVENT_KINDS.leadSubmit,
    sessionId: 's2',
    occurredAt: new Date(T0 + HOUR).toISOString(),
    payload: { leadId: 'l2', dealerId: 'd-north' },
  },
  {
    kind: EVENT_KINDS.leadSubmit,
    sessionId: 's3',
    occurredAt: new Date(T0 + 2 * HOUR).toISOString(),
    payload: { leadId: 'l3', dealerId: 'd-south' },
  },
];

const rowFor = (report: ReturnType<typeof resolveDealerConversion>, id: string) =>
  report.dealers.find((d) => d.dealerId === id)!;

/** A ratio as the resolvers report it: 0–100, two decimals. */
const round = (ratio: number) => Math.round(ratio * 100 * 100) / 100;

test('a dealer with zero leads is a row of ZEROS, never an absence', () => {
  const report = resolveDealerConversion(leads, events, { dealers });
  assert.deepEqual(report.dealers.map((d) => d.dealerId), ['d-north', 'd-south', 'd-quiet']);
  const quiet = rowFor(report, 'd-quiet');
  assert.equal(quiet.dealerName, 'Silencioso');
  assert.equal(quiet.leads, 0);
  assert.equal(quiet.converted, 0);
  // 0 of 0 is not 0% — a rate with nothing to divide by has no answer.
  assert.equal(quiet.contactedRate, null);
  assert.equal(quiet.convertedRate, null);
  assert.equal(quiet.medianResponseMs, null);
  assert.deepEqual(quiet.value.totals, []);
});

test('the progression is monotone: a converted lead was contacted', () => {
  const report = resolveDealerConversion(leads, events, { dealers });
  const north = rowFor(report, 'd-north');
  assert.equal(north.leads, 4);
  assert.equal(north.converted, 1);
  assert.equal(north.contacted, 3); // l1, l3 and the converted l2
  assert.equal(north.pending, 1);
  assert.equal(north.contactedRate, 75);
  assert.equal(north.convertedRate, 25);
  assert.equal(north.convertedOfContactedRate, round(1 / 3));
});

test('the median SAYS what it is built from', () => {
  const report = resolveDealerConversion(leads, events, { dealers });
  const north = rowFor(report, 'd-north');
  // 30 min (stamped), 90 min (stamped), 10 min (derived from updated_at).
  assert.equal(north.responseSamples, 3);
  assert.equal(north.medianResponseMs, 30 * MIN);
  assert.deepEqual(north.responseBasis, { stamped: 2, derived: 1, missing: 0 });

  const south = rowFor(report, 'd-south');
  assert.equal(south.contacted, 1);
  assert.equal(south.responseSamples, 0);
  assert.equal(south.medianResponseMs, null);
  assert.deepEqual(south.responseBasis, { stamped: 0, derived: 0, missing: 1 });

  // The overall median is taken over EVERY sample, not as a median of medians.
  assert.equal(report.totals.responseSamples, 3);
  assert.equal(report.totals.medianResponseMs, 30 * MIN);
});

test('routed means the platform routed it — a reassignment is manual', () => {
  const report = resolveDealerConversion(leads, events, { dealers });
  const north = rowFor(report, 'd-north');
  assert.equal(north.routed, 2); // l1, l2
  assert.equal(north.manual, 2); // l3 was submitted for d-south; l4 never beaconed
  const south = rowFor(report, 'd-south');
  assert.equal(south.routed, 0);
  assert.equal(south.manual, 2);
  assert.equal(report.totals.routed + report.totals.manual, report.totals.leads);

  // An explicit flag on the row wins without any event at all.
  const flagged = resolveDealerConversion(
    [{ id: 'x', dealerId: 'd-north', status: 'pending', createdAt: T0, source: { routed: true } }],
    [],
    { dealers },
  );
  assert.equal(rowFor(flagged, 'd-north').routed, 1);

  // …and so does the API's own routing stamp under `source.routing`, while a
  // stamp that FAILED to route is exactly what a manual assignment is.
  const stamped = resolveDealerConversion(
    [
      {
        id: 'y',
        dealerId: 'd-north',
        status: 'pending',
        createdAt: T0,
        source: { routing: { outcome: 'routed', reason: 'territory:routed' } },
      },
      {
        id: 'z',
        dealerId: 'd-south',
        status: 'pending',
        createdAt: T0,
        source: { routing: { outcome: 'unroutable', reason: 'unroutable' } },
      },
    ],
    [],
    { dealers },
  );
  assert.equal(rowFor(stamped, 'd-north').routed, 1);
  assert.equal(rowFor(stamped, 'd-south').routed, 0);
  assert.equal(rowFor(stamped, 'd-south').manual, 1);
});

test('leads with no dealer land in `unassigned`, which is always present', () => {
  const report = resolveDealerConversion(leads, events, { dealers });
  assert.equal(report.unassigned.dealerId, null);
  assert.equal(report.unassigned.leads, 1);
  assert.equal(report.totals.leads, leads.length);
  assert.equal(
    report.dealers.reduce((sum, d) => sum + d.leads, 0) + report.unassigned.leads,
    leads.length,
  );

  // Even with nothing unassigned, the bucket exists at zero.
  const none = resolveDealerConversion([leads[0]], events, { dealers });
  assert.equal(none.unassigned.leads, 0);
});

test('money never crosses currencies — there is no grand total to misread', () => {
  const report = resolveDealerConversion(leads, events, { dealers });
  const north = rowFor(report, 'd-north');
  assert.deepEqual(north.value.totals, [
    { currency: 'USD', amountMinor: 1_650_000, count: 2 },
    { currency: 'DOP', amountMinor: 90_000, count: 1 },
  ]);
  assert.equal(north.value.mixed, true);
  assert.equal(north.value.unpriced, 1); // l4 carries no estimate — not zero money
  assert.deepEqual(north.convertedValue.totals, [
    { currency: 'USD', amountMinor: 1_200_000, count: 1 },
  ]);
  assert.equal(north.convertedValue.mixed, false);
  assert.equal('amountMinor' in north.value, false); // no single number, by shape
});

test('a dealer absent from the roster still appears once it has a lead', () => {
  const report = resolveDealerConversion(
    [{ id: 'z', dealer_id: 'd-unknown', status: 'converted', created_at: T0 }],
    [],
    { dealers: [] },
  );
  assert.deepEqual(report.dealers.map((d) => [d.dealerId, d.dealerName, d.leads]), [
    ['d-unknown', null, 1],
  ]);
  assert.equal(report.dealers[0].contactedRate, 100);
});

test('the period bounds by lead creation, and what falls outside is counted', () => {
  const report = resolveDealerConversion(leads, events, {
    dealers,
    period: { from: T0 + 2 * HOUR, to: T0 + 5 * HOUR },
  });
  assert.equal(report.totals.leads, 3); // l3, l4, l5
  assert.equal(report.excluded.outOfPeriod, 4);
  assert.equal(rowFor(report, 'd-north').leads, 2);
  assert.equal(report.unassigned.leads, 0);
});

test('unreadable rows are reported, never silently dropped', () => {
  const report = resolveDealerConversion(
    [...leads, null, { id: 'nostamp', dealerId: 'd-north', status: 'pending' }],
    events,
    { dealers, period: { from: T0, to: T0 + 7 * HOUR } },
  );
  assert.equal(report.excluded.unreadableLeads, 1);
  assert.equal(report.excluded.undatedLeads, 1);
  assert.equal(report.totals.leads, leads.length);
});

test('an unknown status is counted, and never invents a contact', () => {
  const report = resolveDealerConversion(
    [{ id: 'q', dealerId: 'd-north', status: 'archived', createdAt: T0 }],
    [],
    { dealers },
  );
  const north = rowFor(report, 'd-north');
  assert.equal(north.leads, 1);
  assert.equal(north.otherStatus, 1);
  assert.equal(north.contacted, 0);
  assert.equal(north.pending, 0);
});

test('determinism: the same fixture twice is deep-equal', () => {
  assert.deepEqual(
    resolveDealerConversion(leads, events, { dealers }),
    resolveDealerConversion(leads, events, { dealers }),
  );
  assert.deepEqual(
    resolveDealerConversion([...leads].reverse(), [...events].reverse(), { dealers }),
    resolveDealerConversion(leads, events, { dealers }),
  );
});
