// THE TWO ENGINE SEAMS, WITHOUT A DATABASE.
//
// `priceBuild` and `deriveVerdict` take a loaded context and no client, which is
// what makes them testable here and replayable through HTTP in parity.test.ts.
// These cases pin the decisions that are invisible in a fixture replay: what the
// wire is NOT allowed to contribute, and what the collection's own params buy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lr8DigitGrade, simpleSku } from '@veta/catalog';
import { parseRuleset } from '@veta/rules';
import type { Ruleset } from '@veta/rules';
import { DEFAULT_LAYOUT_PARAMS } from '@veta/layout';
import { layoutParamsOf, mountOf, productsFrom, ruleCatalogOf } from '../src/context.ts';
import type { CollectionContext, CollectionRow, ModelRow } from '../src/context.ts';
import { priceBuild } from '../src/pricing.ts';
import { blocksSave, deriveVerdict, isStrictRuleset, parseStoredRuleset } from '../src/verdict.ts';
import { createRateLimiter } from '../src/rateLimit.ts';
import { eventsOf, normalizeEvent } from '../src/routes/events.ts';

/* ------------------------------ tiny fixtures ------------------------------ */

function collectionRow(over: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    org_id: '22222222-2222-4222-8222-222222222222',
    brand_id: '33333333-3333-4333-8333-333333333333',
    slug: 'vira',
    name: 'Vira',
    status: 'published',
    render_params: {},
    taxonomy: {},
    sort_order: 0,
    ...over,
  };
}

function modelRow(id: string, over: Partial<ModelRow> = {}): ModelRow {
  return {
    id,
    collection_id: '11111111-1111-4111-8111-111111111111',
    slug: id,
    name: id,
    status: 'published',
    tags: ['seat'],
    // numeric columns arrive from pg as STRINGS — the projection must survive it.
    width_cm: '80',
    depth_cm: '90',
    height_cm: null,
    mesh_path: null,
    mesh_params: {},
    mount: null,
    default_rot: 0,
    sku: '15420000',
    parts: {},
    sort_order: 0,
    ...over,
  };
}

function contextFor(models: ModelRow[], opts: Partial<CollectionContext> = {}): CollectionContext {
  const collection = opts.collection ?? collectionRow();
  const grammar = opts.grammar ?? lr8DigitGrade;
  return {
    collection,
    models,
    catalog: ruleCatalogOf(collection.slug, models),
    layout: layoutParamsOf(collection.render_params),
    ruleset: null,
    rulesetRaw: null,
    rulesetVersion: null,
    strict: false,
    priceListId: 'price-list',
    currency: 'USD',
    products: [],
    grammar,
    ...opts,
  };
}

/* --------------------------------- pricing -------------------------------- */

test('a graded ladder prices by the piece’s own grade, never by the payload’s number', () => {
  const ctx = contextFor([modelRow('m1')], {
    products: productsFrom(
      [
        { sku: '15420000', grade: 'A', amount_minor: 250_000 },
        { sku: '15420000', grade: 'C', amount_minor: 310_000 },
      ],
      'USD',
      lr8DigitGrade,
    ),
  });

  const base = priceBuild({ pieces: [{ uid: 'p1', modelId: 'm1' }] }, ctx);
  assert.equal(base.amount_minor, 250_000, 'no pick quotes the cheapest rung');

  const graded = priceBuild({ pieces: [{ uid: 'p1', modelId: 'm1', material: { code: 'X', grade: 'C' } }] }, ctx);
  assert.equal(graded.amount_minor, 310_000, 'the picked grade reprices the base SKU');

  // The reference app overlays the palette's own unitPrice; on the wire that is
  // a number the customer chose, so it must contribute nothing.
  const lying = priceBuild(
    { pieces: [{ uid: 'p1', modelId: 'm1', material: { code: 'X', grade: 'C', unitPrice: 9, priceUsd: 9 } }] },
    ctx,
  );
  assert.equal(lying.amount_minor, 310_000);
  assert.ok(!JSON.stringify(lying).includes('"9"'));

  // An invented grade prices NOTHING (upstream 447bade): a grade the model's
  // own ladder never priced must not fall back to a rung nobody chose — the
  // piece reads «sin precio», never a wrong figure.
  const invented = priceBuild({ pieces: [{ uid: 'p1', modelId: 'm1', material: { grade: 'ZZ' } }] }, ctx);
  assert.equal(invented.amount_minor, 0);
  assert.deepEqual(invented.unpriced_models, ['m1']);
  assert.equal(invented.priced_pieces, 0);
});

test('an unpriced or foreign model contributes nothing and says so', () => {
  const ctx = contextFor([modelRow('m1', { sku: 'NOPE' })], {
    grammar: simpleSku,
    products: productsFrom([{ sku: 'OTHER', grade: '', amount_minor: 500_000 }], 'USD', simpleSku),
  });
  const snapshot = priceBuild({ pieces: [{ uid: 'a', modelId: 'm1' }, { uid: 'b', modelId: 'not-carried' }] }, ctx);
  assert.equal(snapshot.amount_minor, 0);
  assert.deepEqual(snapshot.unpriced_models, ['m1', 'not-carried']);
  assert.equal(snapshot.priced_pieces, 0);
});

test('the itemization foots to the piece total, in minor units', () => {
  const ctx = contextFor([modelRow('m1')], {
    grammar: simpleSku,
    products: productsFrom([{ sku: '15420000', grade: '', amount_minor: 123_450 }], 'USD', simpleSku),
  });
  const snapshot = priceBuild({ pieces: [{ uid: 'p1', modelId: 'm1' }] }, ctx);
  const line = snapshot.lines[0]!;
  assert.equal(line.amount_minor, 123_450);
  const footed = (line.parts ?? []).reduce((sum, part) => sum + (part.total_minor ?? 0), 0);
  assert.equal(footed, line.amount_minor, 'a Resumen that does not add up is how a quote becomes indefensible');
});

test('a snapshot’s stamp comes from an injectable clock, and a junk build prices at zero', () => {
  const ctx = contextFor([modelRow('m1')]);
  const at = new Date('2026-08-01T12:00:00.000Z');
  assert.equal(priceBuild({ pieces: [] }, ctx, { now: () => at }).priced_at, at.toISOString());
  assert.equal(priceBuild(null, ctx).amount_minor, 0);
  assert.equal(priceBuild({ pieces: 'nope' }, ctx).amount_minor, 0);
  assert.equal(priceBuild({ pieces: [{ uid: 'x' }] }, null).amount_minor, 0);
});

/* --------------------------------- verdict -------------------------------- */

const RUN: Ruleset = parseRuleset({
  schema: 1,
  params: { rotationStepDeg: 90, minContactCm: 30 },
  rules: [
    {
      id: 'seat-links',
      type: 'adjacency',
      select: { tags: ['seat'] },
      edges: { right: { required: true } },
    },
  ],
}).ruleset;

test('with no context only the ENGINE judges — the piece cap no ruleset can loosen', () => {
  const pieces = Array.from({ length: 21 }, (_, i) => ({ uid: `p${i}`, modelId: 'm1' }));
  const verdict = deriveVerdict({ pieces, ok: true, violations: [] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.violations[0]?.ruleId, 'engine.countMax');
  assert.equal(verdict.derivedBy, 'server');
  assert.equal(verdict.rulesetVersion, null);
  assert.equal(deriveVerdict({ pieces: pieces.slice(0, 3) }).ok, true);
});

test('the collection’s linkOverlapCm reaches the contact graph — a NESTED dock is contact', () => {
  const models = [modelRow('m1'), modelRow('m2')];
  // Two 80×90 seats overlapping by 9 cm: a gap of −9 is a collision to an engine
  // that knows nothing about the collection, and a legal dock to one that does.
  const build = {
    pieces: [
      { uid: 'a', modelId: 'm1', x: 0, y: 0, rot: 0 },
      { uid: 'b', modelId: 'm2', x: 71, y: 0, rot: 0 },
    ],
  };

  const flush = contextFor(models, { ruleset: RUN, rulesetVersion: 4, strict: true });
  const openEdge = deriveVerdict(build, flush).violations.filter((v) => v.messageKey === 'rules.adjacency.openEdge');
  assert.equal(openEdge.length, 2, 'without the overlap table neither seat sees a neighbour');

  const nested = contextFor(models, {
    collection: collectionRow({ render_params: { linkOverlapCm: { vira: 9 } } }),
    ruleset: RUN,
    rulesetVersion: 4,
    strict: true,
  });
  const nestedVerdict = deriveVerdict(build, nested);
  assert.deepEqual(
    nestedVerdict.violations.filter((v) => v.pieces.includes('a')).map((v) => v.messageKey),
    [],
    'a nested dock must read as contact, not as a gap',
  );
  assert.equal(nestedVerdict.rulesetVersion, 4, 'a stored verdict is attributable to the ruleset that judged it');
});

test('the save gate is STRICT-only, and unknown rule types fail it closed', () => {
  const pieces = Array.from({ length: 21 }, (_, i) => ({ uid: `p${i}`, modelId: 'm1' }));
  const free = contextFor([modelRow('m1')], { strict: false });
  const strict = contextFor([modelRow('m1')], { strict: true });

  const verdict = deriveVerdict({ pieces }, free);
  assert.equal(verdict.ok, false);
  assert.equal(blocksSave(verdict, free), false, 'a free-form collection stores the flagged build');
  assert.equal(blocksSave(verdict, strict), true);

  // Parsed exactly as a stored document is: kept (a newer studio's file
  // round-trips), reported, and — because a rule's severity defaults to error —
  // strict.
  const parsed = parseStoredRuleset({ schema: 1, rules: [{ id: 'from-the-future', type: 'gravity' }] });
  assert.equal(parsed.strict, true);
  assert.equal(isStrictRuleset(parsed.ruleset), true);
  const ctx = contextFor([modelRow('m1')], { ruleset: parsed.ruleset, strict: parsed.strict });
  const judged = deriveVerdict({ pieces: [{ uid: 'p1', modelId: 'm1' }] }, ctx);
  assert.deepEqual(judged.unknownRules, ['from-the-future']);
  assert.equal(judged.ok, true, 'an unknown rule is not a violation…');
  assert.equal(blocksSave(judged, ctx), true, '…but a save cannot be waved through by an engine that cannot judge it');
});

test('a rule the parser would DROP surfaces as unknown instead of quietly not applying', () => {
  // Stored documents rot: a rule that was valid under an older engine can become
  // malformed. Judging the parsed REMAINDER would silently apply fewer rules
  // than the author wrote — §1.7 wants that leniency visible.
  const stored = {
    schema: 1,
    rules: [
      { id: 'broken', type: 'count' },                       // no min and no max
      { id: 'cap', type: 'count', max: 1, severity: 'error' },
    ],
  };
  const parsed = parseStoredRuleset(stored);
  assert.equal(parsed.ruleset.rules.length, 1, 'the parser kept only the valid rule');
  assert.equal(parsed.dropped.length, 1);

  const ctx = contextFor([modelRow('m1')], {
    ruleset: parsed.ruleset,
    rulesetRaw: stored,
    rulesetVersion: 2,
    strict: parsed.strict,
  });
  const verdict = deriveVerdict(
    { pieces: [{ uid: 'a', modelId: 'm1' }, { uid: 'b', modelId: 'm1' }] },
    ctx,
  );
  assert.deepEqual(verdict.unknownRules, ['broken'], 'the dropped rule is reported, not forgotten');
  assert.equal(verdict.violations[0]?.ruleId, 'cap', 'the valid remainder still judges');
  assert.equal(blocksSave(verdict, ctx), true, 'a strict collection fails the save closed');
});

/* -------------------------------- projections ------------------------------ */

test('the rules projection reads pg’s strings and jsonb mounts', () => {
  const catalog = ruleCatalogOf('vira', [
    modelRow('m1', { width_cm: '80.5', depth_cm: '90', tags: ['seat', 'corner'] }),
    modelRow('m2', { mount: 'seat' }),
    modelRow('m3', { mount: { kind: 'seat', offsetCm: 12 } }),
    modelRow('m4', { mount: { kind: 'floor' } }),
  ]);
  assert.deepEqual(catalog.modelById.m1, { collection: 'vira', tags: ['seat', 'corner'], widthCm: 80.5, depthCm: 90, mount: null });
  assert.equal(catalog.modelById.m2?.mount, 'seat');
  assert.equal(catalog.modelById.m3?.mount, 'seat');
  assert.equal(catalog.modelById.m4?.mount, null);
  assert.equal(mountOf(null), null);
  assert.equal(mountOf('SEAT'), 'seat');
});

test('layout params fall back to the engine defaults, never to junk', () => {
  assert.deepEqual(layoutParamsOf(null), DEFAULT_LAYOUT_PARAMS);
  assert.deepEqual(layoutParamsOf({ linkOverlapCm: { Vira: '9', bad: 'x' } }).linkOverlapCm, { vira: 9 });
  assert.equal(layoutParamsOf({ gridCm: 'nope' }).gridCm, DEFAULT_LAYOUT_PARAMS.gridCm);
  assert.equal(layoutParamsOf({ gridCm: 5 }).gridCm, 5);
});

test('a price row’s reference is what the brand’s grammar composes', () => {
  assert.deepEqual(productsFrom([{ sku: '15420000', grade: 'C', amount_minor: 310_000 }], 'USD', lr8DigitGrade), [
    { reference: '15420000C', name: '', priceUsd: 3100 },
  ]);
  assert.deepEqual(productsFrom([{ sku: 'SOFA-1', grade: '', amount_minor: 99 }], 'USD', simpleSku), [
    { reference: 'SOFA-1', name: '', priceUsd: 0.99 },
  ]);
});

/* ------------------------------- rate limiting ----------------------------- */

test('the token bucket spends a burst, refills on the injected clock, and is per key', () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1, now: () => now });

  assert.deepEqual([1, 2, 3].map(() => limiter.take('key-a').allowed), [true, true, true]);
  const refused = limiter.take('key-a');
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 1000);
  assert.equal(limiter.take('key-b').allowed, true, 'one tenant cannot spend another’s budget');

  now += 2_000;
  assert.equal(limiter.take('key-a').allowed, true);
  assert.equal(limiter.take('key-a').allowed, true);
  assert.equal(limiter.take('key-a').allowed, false);

  now += 10 * 60_000;   // idle far beyond the ttl: a full burst, never a saved-up flood
  assert.equal(limiter.take('key-a').remaining, 2);
});

/* --------------------------------- events ---------------------------------- */

test('an event needs a kind; the batch shape is forgiving, the contents are not', () => {
  assert.equal(normalizeEvent({ kind: 'widget.open' })?.kind, 'widget.open');
  assert.equal(normalizeEvent({ kind: '   ' }), null);
  assert.equal(normalizeEvent({ payload: { a: 1 } }), null);
  assert.equal(normalizeEvent({ kind: 'x', occurredAt: 'not-a-date' })?.occurredAt, null);
  assert.deepEqual(normalizeEvent({ kind: 'x', payload: [1, 2] })?.payload, {});
  assert.equal(eventsOf({ events: [{ kind: 'a' }, { kind: 'b' }] }).length, 2);
  assert.equal(eventsOf([{ kind: 'a' }]).length, 1);
  assert.equal(eventsOf({ kind: 'a' }).length, 1);
  assert.equal(eventsOf(null).length, 0);
});
