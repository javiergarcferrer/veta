// TIME SERIES over fixture streams — completeness (a quiet day is a zero, not a
// gap), UTC bucket edges, the reported cap, and an honest trend delta.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS,
  EVENT_KINDS,
  MAX_BUCKETS,
  WEEK_MS,
  bucketKey,
  bucketStarts,
  resolveSeries,
  resolveTrend,
  startOfDayUtc,
  startOfWeekUtc,
} from '../src/index.ts';
import type { AnalyticsEvent } from '../src/index.ts';

const day = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);

const at = (iso: string, kind: string = EVENT_KINDS.widgetOpen, sessionId: string | null = 's1'): AnalyticsEvent => ({
  kind,
  sessionId,
  occurredAt: iso,
  payload: {},
});

test('UTC bucket edges: a day floors to midnight, a week to Monday', () => {
  assert.equal(startOfDayUtc(Date.parse('2026-07-03T23:59:59.999Z')), day('2026-07-03'));
  assert.equal(startOfDayUtc(day('2026-07-03')), day('2026-07-03'));
  // 2026-07-03 is a Friday → its week starts Monday 2026-06-29.
  assert.equal(startOfWeekUtc(Date.parse('2026-07-03T12:00:00Z')), day('2026-06-29'));
  assert.equal(new Date(day('2026-06-29')).getUTCDay(), 1);
  // Monday itself is the start, and one ms earlier belongs to the week before.
  assert.equal(startOfWeekUtc(day('2026-06-29')), day('2026-06-29'));
  assert.equal(startOfWeekUtc(day('2026-06-29') - 1), day('2026-06-22'));
  assert.equal(bucketKey(Date.parse('2026-07-03T18:00:00Z'), 'week'), '2026-06-29');
});

test('the bucket list is COMPLETE — built from the window, not from the data', () => {
  const plan = bucketStarts(day('2026-07-01'), day('2026-07-05'), 'day');
  assert.equal(plan.total, 4);
  assert.equal(plan.truncated, false);
  assert.deepEqual(plan.starts.map((s) => bucketKey(s, 'day')), [
    '2026-07-01',
    '2026-07-02',
    '2026-07-03',
    '2026-07-04',
  ]);
  // A window that starts mid-day still opens at that day's bucket.
  const partial = bucketStarts(Date.parse('2026-07-01T18:00:00Z'), day('2026-07-03'), 'day');
  assert.deepEqual(partial.starts, [day('2026-07-01'), day('2026-07-02')]);
  // An empty (or backwards) window has no buckets at all.
  assert.deepEqual(bucketStarts(day('2026-07-05'), day('2026-07-01'), 'day').starts, []);
});

test('a day with no events is a ZERO point, not a gap', () => {
  const events = [
    at('2026-07-01T09:00:00Z'),
    at('2026-07-01T11:00:00Z'),
    // nothing at all on the 2nd
    at('2026-07-03T08:00:00Z'),
  ];
  const series = resolveSeries(events, { period: { from: day('2026-07-01'), to: day('2026-07-04') } });
  assert.deepEqual(series.points.map((p) => [p.key, p.count]), [
    ['2026-07-01', 2],
    ['2026-07-02', 0],
    ['2026-07-03', 1],
  ]);
  assert.equal(series.total, 3);
  assert.equal(series.buckets, 3);
  assert.equal(series.truncated, false);
  // Each point is half-open: end is the next bucket's start.
  assert.equal(series.points[0].endMs, series.points[1].startMs);
  assert.equal(series.points[0].endMs - series.points[0].startMs, DAY_MS);
});

test('with no period, the window is the data\'s own span — still complete', () => {
  const series = resolveSeries([at('2026-07-01T09:00:00Z'), at('2026-07-04T09:00:00Z')]);
  assert.deepEqual(series.points.map((p) => [p.key, p.count]), [
    ['2026-07-01', 1],
    ['2026-07-02', 0],
    ['2026-07-03', 0],
    ['2026-07-04', 1],
  ]);
  assert.equal(series.period.explicit.from, false);
});

test('weekly buckets step by exactly one week', () => {
  const series = resolveSeries(
    [at('2026-06-30T09:00:00Z'), at('2026-07-01T09:00:00Z'), at('2026-07-08T09:00:00Z')],
    { granularity: 'week', period: { from: day('2026-06-29'), to: day('2026-07-13') } },
  );
  assert.deepEqual(series.points.map((p) => [p.key, p.count]), [
    ['2026-06-29', 2],
    ['2026-07-06', 1],
  ]);
  assert.equal(series.points[0].endMs - series.points[0].startMs, WEEK_MS);
});

test('a kind or collection filter counts what it set aside', () => {
  const events = [
    at('2026-07-01T09:00:00Z', EVENT_KINDS.widgetOpen),
    at('2026-07-01T10:00:00Z', EVENT_KINDS.leadSubmit),
    { ...at('2026-07-01T11:00:00Z', EVENT_KINDS.widgetOpen), payload: { collection: 'duna' } },
  ];
  const opens = resolveSeries(events, { kind: EVENT_KINDS.widgetOpen });
  assert.equal(opens.total, 2);
  assert.equal(opens.excluded.otherKind, 1);

  const duna = resolveSeries(events, { kind: EVENT_KINDS.widgetOpen, collectionId: 'duna' });
  assert.equal(duna.total, 1);
  assert.equal(duna.excluded.unattributed, 1);

  // Several kinds at once, and everything when the filter is omitted.
  assert.equal(
    resolveSeries(events, { kind: [EVENT_KINDS.widgetOpen, EVENT_KINDS.leadSubmit] }).total,
    3,
  );
  assert.equal(resolveSeries(events).total, 3);
});

test('the bucket cap is REPORTED, and events past it are counted', () => {
  const from = day('2020-01-01');
  const to = from + (MAX_BUCKETS + 10) * DAY_MS;
  const series = resolveSeries(
    [
      { ...at('2020-01-02T00:00:00Z'), occurredAt: from + 1 },
      { ...at('2020-01-02T00:00:00Z'), occurredAt: from + (MAX_BUCKETS + 5) * DAY_MS },
    ],
    { period: { from, to } },
  );
  assert.equal(series.truncated, true);
  assert.equal(series.buckets, MAX_BUCKETS + 10);
  assert.equal(series.points.length, MAX_BUCKETS);
  assert.equal(series.total, 2);
  assert.equal(series.beyondCap, 1); // still counted, just past the last point
});

test('resolveTrend compares against the preceding window — honestly', () => {
  const events = [
    // previous window (Jun 24 – Jul 1)
    at('2026-06-25T09:00:00Z'),
    at('2026-06-26T09:00:00Z'),
    // current window (Jul 1 – Jul 8)
    at('2026-07-01T09:00:00Z', EVENT_KINDS.widgetOpen, 'a'),
    at('2026-07-02T09:00:00Z', EVENT_KINDS.widgetOpen, 'a'),
    at('2026-07-03T09:00:00Z', EVENT_KINDS.widgetOpen, 'b'),
    at('2026-07-03T10:00:00Z', EVENT_KINDS.widgetOpen, null),
    at('2026-07-04T09:00:00Z', EVENT_KINDS.leadSubmit, 'b'),
  ];
  const trend = resolveTrend(events, EVENT_KINDS.widgetOpen, {
    from: day('2026-07-01'),
    to: day('2026-07-08'),
  });
  assert.equal(trend.kind, EVENT_KINDS.widgetOpen);
  assert.equal(trend.total, 4);
  assert.equal(trend.points.length, 7);
  assert.equal(trend.sessions, 2); // a, b — the session-less beacon is its own count
  assert.equal(trend.untracked, 1);
  assert.deepEqual(trend.previous.total, 2);
  assert.equal(trend.previous.observed, true);
  assert.equal(trend.changePct, 100); // 2 → 4
  assert.equal(trend.previous.from, new Date(day('2026-06-24')).toISOString());
});

test('a delta against nothing is NULL, never a percentage of zero', () => {
  const trend = resolveTrend([at('2026-07-01T09:00:00Z')], EVENT_KINDS.widgetOpen, {
    from: day('2026-07-01'),
    to: day('2026-07-08'),
  });
  assert.equal(trend.previous.total, 0);
  assert.equal(trend.previous.observed, false);
  assert.equal(trend.changePct, null);

  // A decline reads as a negative percentage, not as an absence.
  const declining = resolveTrend(
    [at('2026-06-25T09:00:00Z'), at('2026-06-26T09:00:00Z'), at('2026-07-02T09:00:00Z')],
    EVENT_KINDS.widgetOpen,
    { from: day('2026-07-01'), to: day('2026-07-08') },
  );
  assert.equal(declining.changePct, -50);
});

test('undated and unkinded rows are reported by the series too', () => {
  const series = resolveSeries([
    at('2026-07-01T09:00:00Z'),
    { kind: EVENT_KINDS.widgetOpen, occurredAt: 'nonsense' },
    { kind: '', occurredAt: '2026-07-01T09:00:00Z' },
  ]);
  assert.equal(series.excluded.undated, 1);
  assert.equal(series.excluded.unkinded, 1);
  assert.equal(series.total, 1);
});

test('determinism: the same fixture twice is deep-equal', () => {
  const events = [at('2026-07-01T09:00:00Z'), at('2026-07-03T09:00:00Z')];
  const period = { from: day('2026-07-01'), to: day('2026-07-05') };
  assert.deepEqual(resolveSeries(events, { period }), resolveSeries(events, { period }));
  assert.deepEqual(
    resolveTrend([...events].reverse(), EVENT_KINDS.widgetOpen, period),
    resolveTrend(events, EVENT_KINDS.widgetOpen, period),
  );
});
