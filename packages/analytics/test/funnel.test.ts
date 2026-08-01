// THE FUNNEL over fixture streams — the edge cases that make or break it:
// out-of-order stamps, repeated stages, a skipped stage, a session that spans
// two collections, and beacons with no session at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_KINDS, FUNNEL_STAGES, resolveFunnel } from '../src/index.ts';
import type { AnalyticsEvent, FunnelStage } from '../src/index.ts';

const T0 = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01T12:00:00Z

const ev = (
  kind: string,
  sessionId: string | null,
  offsetMs: number,
  payload: Record<string, unknown> = {},
): AnalyticsEvent => ({
  kind,
  sessionId,
  occurredAt: new Date(T0 + offsetMs).toISOString(),
  payload,
});

const stage = (report: ReturnType<typeof resolveFunnel>, name: FunnelStage) =>
  report.stages.find((s) => s.stage === name)!;

// s1 walks the whole funnel; s2 skips the material picker; s3 stops after a
// piece; s4 only ever opened. Two beacons carry no session.
const stream: AnalyticsEvent[] = [
  ev(EVENT_KINDS.widgetOpen, 's1', 0),
  ev(EVENT_KINDS.piecePlace, 's1', 1_000),
  ev(EVENT_KINDS.materialPick, 's1', 3_000),
  ev(EVENT_KINDS.priceView, 's1', 6_000),
  ev(EVENT_KINDS.leadSubmit, 's1', 10_000),
  ev(EVENT_KINDS.widgetOpen, 's2', 0),
  ev(EVENT_KINDS.piecePlace, 's2', 2_000),
  ev(EVENT_KINDS.priceView, 's2', 5_000),
  ev(EVENT_KINDS.widgetOpen, 's3', 0),
  ev(EVENT_KINDS.piecePlace, 's3', 4_000),
  ev(EVENT_KINDS.widgetOpen, 's4', 0),
  ev(EVENT_KINDS.widgetOpen, null, 0),
  ev(EVENT_KINDS.piecePlace, null, 500),
];

test('the funnel bar is cumulative and its drop-off can never go negative', () => {
  const report = resolveFunnel(stream);
  assert.deepEqual(
    report.stages.map((s) => [s.stage, s.sessions]),
    [
      ['open', 4],
      ['place', 3],
      ['materialize', 2],
      ['price-view', 2],
      ['lead', 1],
    ],
  );
  // Monotone by construction — that is what makes drop-off meaningful.
  for (let i = 1; i < report.stages.length; i += 1) {
    assert.ok(report.stages[i].sessions <= report.stages[i - 1].sessions);
    assert.ok(report.stages[i].dropOff.sessions >= 0);
  }
  assert.deepEqual(stage(report, 'place').dropOff, { sessions: 1, pct: 25 });
  assert.deepEqual(stage(report, 'lead').dropOff, { sessions: 1, pct: 50 });
  assert.equal(stage(report, 'open').dropOff.pct, null); // nothing precedes it
  assert.equal(stage(report, 'lead').ofFirstPct, 25);
});

test('a SKIPPED stage is passed through, not deleted — and it says so', () => {
  const report = resolveFunnel(stream);
  const materialize = stage(report, 'materialize');
  // s2 reached the price panel without ever picking a material: it is counted
  // as having got past `materialize`, and `withEvent` keeps that honest.
  assert.equal(materialize.sessions, 2);
  assert.equal(materialize.withEvent, 1);
  assert.equal(materialize.skipped, 1);
  assert.equal(stage(report, 'place').skipped, 0);
});

test('session-less events land in `untracked`, never in the progression', () => {
  const report = resolveFunnel(stream);
  assert.equal(report.sessions, 4);
  assert.equal(report.untracked.events, 2);
  assert.equal(report.untracked.byStage.open, 1);
  assert.equal(report.untracked.byStage.place, 1);
  assert.equal(report.untracked.byStage.lead, 0);
  // The two untracked beacons are NOT in any stage's session or event count.
  assert.equal(stage(report, 'open').events, 4);
  assert.equal(stage(report, 'place').events, 3);
  assert.equal(report.events.considered, stream.length);
});

test('time-to-stage takes the FIRST event of each stage, so order cannot skew it', () => {
  const report = resolveFunnel(stream);
  assert.equal(stage(report, 'open').medianTimeToStageMs, 0);
  assert.equal(stage(report, 'place').medianTimeToStageMs, 2_000); // 1k, 2k, 4k
  assert.equal(stage(report, 'place').samples, 3);
  assert.equal(stage(report, 'materialize').medianTimeToStageMs, 3_000);
  assert.equal(stage(report, 'materialize').samples, 1);
  assert.equal(stage(report, 'price-view').medianTimeToStageMs, 5_500); // even sample
  assert.equal(stage(report, 'lead').medianTimeToStageMs, 10_000);
});

test('out-of-order and repeated stages produce the SAME report as a clean stream', () => {
  const shuffled = [...stream].reverse();
  assert.deepEqual(resolveFunnel(shuffled), resolveFunnel(stream));

  // A repeat is not a second session, and the LATER duplicate never becomes the
  // clock start: s9 placed twice, the earlier one arriving second in the array.
  const repeated = [
    ev(EVENT_KINDS.widgetOpen, 's9', 0),
    ev(EVENT_KINDS.piecePlace, 's9', 9_000),
    ev(EVENT_KINDS.piecePlace, 's9', 1_500),
    ev(EVENT_KINDS.piecePlace, 's9', 4_000),
  ];
  const report = resolveFunnel(repeated);
  assert.equal(report.sessions, 1);
  assert.equal(stage(report, 'place').sessions, 1);
  assert.equal(stage(report, 'place').events, 3);
  assert.equal(stage(report, 'place').medianTimeToStageMs, 1_500);
});

test('a session that spans collections contributes to each one separately', () => {
  const multi = [
    ev(EVENT_KINDS.widgetOpen, 'm1', 0, { collection: 'vira' }),
    ev(EVENT_KINDS.piecePlace, 'm1', 1_000, { collection: 'vira' }),
    ev(EVENT_KINDS.piecePlace, 'm1', 2_000, { collection: 'duna' }),
    ev(EVENT_KINDS.priceView, 'm1', 3_000, { collection: 'duna' }),
    ev(EVENT_KINDS.widgetOpen, 'm2', 0, { collection: 'vira' }),
    ev(EVENT_KINDS.leadSubmit, 'm1', 4_000), // no collection on the payload
  ];

  const vira = resolveFunnel(multi, { collectionId: 'vira' });
  assert.equal(vira.sessions, 2);
  assert.equal(stage(vira, 'place').sessions, 1);
  assert.equal(stage(vira, 'lead').sessions, 0);
  assert.equal(vira.excluded.otherCollection, 2); // the two duna events
  assert.equal(vira.excluded.unattributed, 1); // the collection-less lead

  const duna = resolveFunnel(multi, { collectionId: 'duna' });
  assert.equal(duna.sessions, 1);
  // Only the two duna events are in scope, so the session's clock starts at the
  // placement — it "opened" the funnel there by having got that far.
  assert.equal(stage(duna, 'open').sessions, 1);
  assert.equal(stage(duna, 'open').withEvent, 0);
  assert.equal(stage(duna, 'price-view').sessions, 1);
  assert.equal(stage(duna, 'price-view').medianTimeToStageMs, 1_000);

  // Unfiltered, the same session is ONE session with its full progression.
  const all = resolveFunnel(multi);
  assert.equal(all.sessions, 2);
  assert.equal(stage(all, 'lead').sessions, 1);
});

test('period is half-open, and what falls outside it is counted', () => {
  const report = resolveFunnel(stream, {
    period: { from: new Date(T0 + 1_000).toISOString(), to: new Date(T0 + 5_000).toISOString() },
  });
  assert.equal(report.period.explicit.from, true);
  assert.equal(report.period.explicit.to, true);
  // In: s1 place(1k)+material(3k), s2 place(2k), s3 place(4k). Out: everything
  // at 0 and the 5k/6k/10k tail — 5k is the exclusive end.
  assert.equal(report.events.considered, 4);
  assert.equal(report.excluded.outOfPeriod, stream.length - 4);
  assert.equal(report.sessions, 3);
});

test('unreadable rows are reported, never silently dropped', () => {
  const report = resolveFunnel([
    ...stream,
    { kind: EVENT_KINDS.widgetOpen, sessionId: 'x', occurredAt: 'not-a-date' },
    { kind: '', sessionId: 'x', occurredAt: new Date(T0).toISOString() },
    { kind: 'brand.custom', sessionId: 's1', occurredAt: new Date(T0).toISOString() },
    { kind: EVENT_KINDS.arOpen, sessionId: 's1', occurredAt: new Date(T0).toISOString() },
    null,
  ]);
  assert.equal(report.excluded.undated, 1);
  assert.equal(report.excluded.unkinded, 1);
  // ar.open is canonical but is NOT a funnel step; a brand's own kind neither.
  assert.equal(report.excluded.otherKind, 2);
  assert.equal(report.sessions, 4);
});

test('an empty stream still reports every stage, at zero', () => {
  const report = resolveFunnel([]);
  assert.equal(report.sessions, 0);
  assert.deepEqual(report.stages.map((s) => s.stage), [...FUNNEL_STAGES]);
  for (const s of report.stages) {
    assert.equal(s.sessions, 0);
    assert.equal(s.medianTimeToStageMs, null);
    assert.equal(s.ofFirstPct, null); // 0 of 0 is not 0%
  }
  assert.equal(report.period.empty, true);
});

test('determinism: the same fixture twice is deep-equal', () => {
  assert.deepEqual(resolveFunnel(stream), resolveFunnel(stream));
  assert.deepEqual(
    resolveFunnel(stream, { collectionId: 'vira' }),
    resolveFunnel(stream, { collectionId: 'vira' }),
  );
});
