// THE VOCABULARY + the barrel — the contract the widget compiles against.
// A rename here is a compile error on both halves; this file makes it a red test
// as well, so the two can never drift into a funnel that quietly reports zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KINDS,
  EVENT_KIND_LIST,
  FUNNEL_STAGES,
  STAGE_OF_KIND,
  isEventKind,
  pct,
  resolveDealerConversion,
  resolveFunnel,
  resolvePopularConfigurations,
  resolveSeries,
  resolveTrend,
  sumMinorByCurrency,
  topN,
} from '../src/index.ts';

test('package resolves and exports every resolver', async () => {
  const barrel = await import('../src/index.ts');
  for (const name of [
    'resolveFunnel',
    'resolvePopularConfigurations',
    'resolveDealerConversion',
    'resolveSeries',
    'resolveTrend',
  ]) {
    assert.equal(typeof (barrel as Record<string, unknown>)[name], 'function', name);
  }
  // Every resolver survives being handed nothing at all.
  assert.equal(resolveFunnel(null).sessions, 0);
  assert.equal(resolvePopularConfigurations(null, null).units.total, 0);
  assert.equal(resolveDealerConversion(null, null).totals.leads, 0);
  assert.equal(resolveSeries(null).total, 0);
  assert.equal(resolveTrend(null, EVENT_KINDS.widgetOpen).total, 0);
});

test('the canonical kinds are the dotted names the widget beacons', () => {
  assert.deepEqual([...EVENT_KIND_LIST], [
    'widget.open',
    'piece.place',
    'material.pick',
    'price.view',
    'lead.submit',
    'ar.open',
    'share.create',
  ]);
  assert.equal(new Set(EVENT_KIND_LIST).size, EVENT_KIND_LIST.length);
  for (const kind of EVENT_KIND_LIST) assert.equal(isEventKind(kind), true);
  assert.equal(isEventKind('brand.custom'), false);
  assert.equal(isEventKind(undefined), false);
});

test('each funnel stage is fed by exactly one canonical kind', () => {
  const mapped = Object.entries(STAGE_OF_KIND);
  for (const [kind] of mapped) assert.equal(isEventKind(kind), true);
  assert.deepEqual(
    FUNNEL_STAGES.map((stage) => mapped.filter(([, s]) => s === stage).length),
    FUNNEL_STAGES.map(() => 1),
  );
  // ar.open and share.create are canonical but deliberately NOT funnel steps:
  // they are side surfaces, and counting them as progress would inflate it.
  assert.equal(STAGE_OF_KIND[EVENT_KINDS.arOpen], undefined);
  assert.equal(STAGE_OF_KIND[EVENT_KINDS.shareCreate], undefined);
});

test('the three report laws, at their smallest', () => {
  // A rate with nothing to divide by has no answer.
  assert.equal(pct(0, 0), null);
  assert.equal(pct(1, 4), 25);
  // A cap always travels with its total.
  assert.deepEqual(topN([1, 2, 3], 2), { items: [1, 2], total: 3, limit: 2, truncated: true });
  // Money is per-currency, and there is no grand total field to misread.
  const summary = sumMinorByCurrency([
    { amountMinor: 100, currency: 'USD' },
    { amountMinor: 250, currency: 'DOP' },
    { amountMinor: 50, currency: 'USD' },
    { amountMinor: null, currency: null },
  ]);
  assert.deepEqual(summary, {
    totals: [
      { currency: 'DOP', amountMinor: 250, count: 1 },
      { currency: 'USD', amountMinor: 150, count: 2 },
    ],
    mixed: true,
    unpriced: 1,
  });
  assert.equal('total' in summary, false);
});
