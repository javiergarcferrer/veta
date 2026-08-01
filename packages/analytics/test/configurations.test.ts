// POPULAR CONFIGURATIONS over fixture streams — pair counting, the design (not
// the click) as the unit, per-collection scoping, and caps that report.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KINDS,
  MAX_COMBINATION_MODELS,
  resolvePopularConfigurations,
} from '../src/index.ts';
import type { AnalyticsEvent, ConfigurationRow } from '../src/index.ts';

const T0 = Date.UTC(2026, 6, 1, 9, 0, 0);

const ev = (
  kind: string,
  sessionId: string | null,
  offsetMs: number,
  payload: Record<string, unknown>,
): AnalyticsEvent => ({
  kind,
  sessionId,
  occurredAt: T0 + offsetMs,
  payload,
});

const place = (session: string | null, modelId: string, collection: string, at: number) =>
  ev(EVENT_KINDS.piecePlace, session, at, { modelId, collection });

const pick = (
  session: string,
  material: Record<string, unknown>,
  collection: string,
  at: number,
) => ev(EVENT_KINDS.materialPick, session, at, { ...material, collection });

const events: AnalyticsEvent[] = [
  place('sA', 'm1', 'vira', 1_000),
  place('sA', 'm2', 'vira', 2_000),
  place('sA', 'm1', 'vira', 3_000), // a nudge, not a second design
  pick('sA', { code: 'F1', grade: 'B' }, 'vira', 4_000),
  place('sB', 'm2', 'vira', 1_000),
  place('sB', 'm3', 'vira', 2_000),
  pick('sB', { material: { code: 'F1', grade: 'C' } }, 'vira', 3_000), // nested pick shape
  place('sC', 'm9', 'duna', 1_000),
  place('sC', 'm8', 'duna', 2_000),
  place('sD', 'm1', 'vira', 1_000),
  place('sD', 'm2', 'vira', 2_000),
  place(null, 'm1', 'vira', 5_000), // a beacon with no session
  ev(EVENT_KINDS.priceView, 'sA', 6_000, { collection: 'vira' }), // not a build signal
];

const configurations: ConfigurationRow[] = [
  {
    id: 'c1',
    collectionId: 'vira',
    createdAt: T0 + 10_000,
    build: {
      pieces: [
        { modelId: 'm1', material: { code: 'F2', grade: 'B' } },
        { modelId: 'm3', partMaterials: { seat: { code: 'F1', grade: 'B' }, back: { code: 'F3' } } },
      ],
    },
  },
  // buildShare's wire shape names the model `pieceId`; both are read.
  { id: 'c2', collection_id: 'duna', created_at: T0 + 11_000, build: { pieces: [{ pieceId: 'm9' }] } },
  { id: 'c3', collectionId: 'vira', createdAt: T0 + 12_000, build: { pieces: [] } },
];

test('models rank by placements, and carry the DESIGN count beside them', () => {
  const report = resolvePopularConfigurations(events, configurations);
  assert.deepEqual(
    report.models.items.map((m) => [m.modelId, m.placements, m.units]),
    [
      ['m1', 4, 3], // sA×2, sD, c1
      ['m2', 3, 3],
      ['m3', 2, 2],
      ['m9', 2, 2],
      ['m8', 1, 1],
    ],
  );
  assert.equal(report.models.total, 5);
  assert.equal(report.models.truncated, false);
  assert.deepEqual(report.units, { sessions: 4, configurations: 2, total: 6 });
  assert.equal(report.excluded.emptyConfigurations, 1);
  assert.equal(report.excluded.untrackedPlacements, 1);
  assert.equal(report.excluded.otherKind, 1); // the price.view
});

test('materials and grades read both the flat and the nested pick shapes', () => {
  const report = resolvePopularConfigurations(events, configurations);
  assert.deepEqual(
    report.materials.items.map((m) => [m.code, m.picks, m.units]),
    [
      ['F1', 3, 3], // sA, sB (nested), c1's seat part
      ['F2', 1, 1],
      ['F3', 1, 1],
    ],
  );
  assert.deepEqual(
    report.grades.items.map((g) => [g.grade, g.picks, g.units]),
    [
      ['B', 3, 2], // sA + c1's piece + c1's seat part → 2 designs
      ['C', 1, 1],
    ],
  );
});

test('pairs are counted ONCE per design and never cross a collection', () => {
  const report = resolvePopularConfigurations(events, configurations);
  assert.deepEqual(
    report.combinations.items.map((c) => [c.models, c.units]),
    [
      [['m1', 'm2'], 2], // sA and sD built the same two
      [['m1', 'm3'], 1], // configuration c1
      [['m2', 'm3'], 1], // sB
      [['m8', 'm9'], 1], // sC, entirely inside duna
    ],
  );
  // No pair mixes a vira model with a duna one, and the repeated m1 in sA did
  // not mint a second (m1, m2).
  for (const pair of report.combinations.items) {
    const duna = pair.models.filter((m) => m === 'm8' || m === 'm9').length;
    assert.ok(duna === 0 || duna === 2, `${pair.key} crosses collections`);
  }
});

test('per-collection blocks carry their own ranking and unit counts', () => {
  const report = resolvePopularConfigurations(events, configurations);
  assert.deepEqual(
    report.collections.map((c) => [c.collectionId, c.units.total]),
    [
      ['vira', 4], // sA, sB, sD + c1
      ['duna', 2], // sC + c2
    ],
  );
  const duna = report.collections.find((c) => c.collectionId === 'duna')!;
  assert.deepEqual(duna.models.items.map((m) => m.modelId), ['m9', 'm8']);
  assert.deepEqual(duna.combinations.items.map((c) => c.models), [['m8', 'm9']]);
});

test('a collection filter scopes the whole report and counts what it set aside', () => {
  const report = resolvePopularConfigurations(events, configurations, { collectionId: 'duna' });
  assert.equal(report.collectionId, 'duna');
  assert.deepEqual(report.models.items.map((m) => m.modelId), ['m9', 'm8']);
  assert.deepEqual(report.units, { sessions: 1, configurations: 1, total: 2 });
  assert.ok(report.excluded.otherCollection > 0);
  assert.equal(report.collections.length, 1);
});

test('a top-N cap is REPORTED — the slice can never read as the whole list', () => {
  const report = resolvePopularConfigurations(events, configurations, { limit: 2 });
  assert.equal(report.models.items.length, 2);
  assert.equal(report.models.limit, 2);
  assert.equal(report.models.total, 5);
  assert.equal(report.models.truncated, true);
  assert.equal(report.combinations.truncated, true);
  assert.equal(report.combinations.total, 4);

  // A junk limit falls back to the default rather than emptying the report.
  const fallback = resolvePopularConfigurations(events, configurations, { limit: 0 });
  assert.equal(fallback.models.limit, 10);
  assert.equal(fallback.models.truncated, false);
});

test('a design too large to pair is skipped and counted, never exploded', () => {
  const many: AnalyticsEvent[] = [];
  for (let i = 0; i < MAX_COMBINATION_MODELS + 1; i += 1) {
    many.push(place('huge', `model-${String(i).padStart(2, '0')}`, 'vira', i));
  }
  many.push(place('small', 'm1', 'vira', 0), place('small', 'm2', 'vira', 1));
  const report = resolvePopularConfigurations(many, []);
  assert.equal(report.combinations.oversizedUnits, 1);
  // The small design still pairs, and the huge one's models are still counted.
  assert.deepEqual(report.combinations.items.map((c) => c.models), [['m1', 'm2']]);
  assert.equal(report.models.total, MAX_COMBINATION_MODELS + 3);
});

test('the period bounds events and configurations alike', () => {
  const report = resolvePopularConfigurations(events, configurations, {
    period: { from: T0, to: T0 + 5_000 },
  });
  assert.equal(report.units.configurations, 0); // all three are stamped later
  assert.ok(report.excluded.outOfPeriodConfigurations >= 3);
  assert.equal(report.excluded.outOfPeriod > 0, true);
  // Without any bound, an undated configuration is part of "all time".
  const undated = resolvePopularConfigurations([], [{ id: 'u1', build: { pieces: [{ modelId: 'm1' }] } }]);
  assert.equal(undated.units.configurations, 1);
});

test('events alone and configurations alone both answer', () => {
  const eventsOnly = resolvePopularConfigurations(events);
  assert.equal(eventsOnly.units.configurations, 0);
  assert.equal(eventsOnly.units.sessions, 4);

  const configsOnly = resolvePopularConfigurations([], configurations);
  assert.equal(configsOnly.units.sessions, 0);
  assert.deepEqual(configsOnly.models.items.map((m) => m.modelId), ['m1', 'm3', 'm9']);
});

test('determinism: the same fixture twice is deep-equal', () => {
  assert.deepEqual(
    resolvePopularConfigurations(events, configurations),
    resolvePopularConfigurations(events, configurations),
  );
  // …and the input order of the stream does not decide the ranking.
  assert.deepEqual(
    resolvePopularConfigurations([...events].reverse(), [...configurations].reverse()),
    resolvePopularConfigurations(events, configurations),
  );
});
