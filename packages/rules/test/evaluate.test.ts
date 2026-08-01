// THE EVALUATORS — one focused fixture per rule type, plus the three properties
// the whole design rests on: the engine REPORTS and never prevents (no throw,
// ever), the Verdict is deterministic (same input twice → deep-equal, violations
// sorted), and a full evaluation fits inside the sub-millisecond budget that
// makes "re-run everything on every gesture" the right non-incremental answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactGraph, evaluateRules, COUNT_MAX } from '../src/index.ts';
import type { PlacedPiece, Rule, RuleCatalog, Ruleset } from '../src/index.ts';

const catalog: RuleCatalog = {
  modelById: {
    arm: { collection: 'vira', tags: ['arm'], widthCm: 40, depthCm: 90 },
    seat: { collection: 'vira', tags: ['seat'], widthCm: 80, depthCm: 90 },
    corner: { collection: 'vira', tags: ['corner'], widthCm: 90, depthCm: 90 },
    ottoman: { collection: 'vira', tags: ['ottoman'], widthCm: 80, depthCm: 80 },
    cushion: { collection: 'vira', tags: ['cushion'], widthCm: 50, depthCm: 50, mount: 'seat' },
    other: { collection: 'duna', tags: ['seat'], widthCm: 80, depthCm: 90 },
  },
};

const ruleset = (rules: unknown[], params?: Ruleset['params']): Ruleset =>
  ({ schema: 1, params, rules: rules as Rule[] });

const seat = (uid: string, x: number, rot = 0, extra: Partial<PlacedPiece> = {}): PlacedPiece =>
  ({ uid, modelId: 'seat', x, y: 0, rot, ...extra });

// ── count ────────────────────────────────────────────────────────────────────

test('count: min expresses a REQUIRED role, max a ceiling', () => {
  const rules = ruleset([
    { id: 'seats', type: 'count', select: { tags: ['seat'] }, min: 1, max: 2 },
  ]);
  const empty = evaluateRules(rules, [], catalog);
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.violations.map((v) => [v.messageKey, v.messageParams]), [
    ['rules.count.min', { count: 0, min: 1 }],
  ]);

  const ok = evaluateRules(rules, [seat('s1', 0), seat('s2', 80)], catalog);
  assert.deepEqual(ok, { ok: true, violations: [], unknownRules: [] });

  const over = evaluateRules(rules, [seat('s1', 0), seat('s2', 80), seat('s3', 160)], catalog);
  assert.equal(over.ok, false);
  assert.deepEqual(over.violations[0].pieces, ['s1', 's2', 's3']);
  assert.deepEqual(over.violations[0].messageParams, { count: 3, max: 2 });

  // The selector is what counts: a piece from another collection with the same
  // tag still matches a tag-only selector, and a `collections` arm excludes it.
  const scoped = evaluateRules(
    ruleset([{ id: 'vira-seats', type: 'count', select: { tags: ['seat'], collections: ['vira'] }, max: 1 }]),
    [seat('s1', 0), { uid: 'o1', modelId: 'other', x: 200, y: 0 }],
    catalog,
  );
  assert.deepEqual(scoped.violations, []);
});

test('count: COUNT_MAX is the ENGINE cap — a ruleset can be stricter, never looser', () => {
  const pieces = Array.from({ length: COUNT_MAX + 1 }, (_, i) => seat(`p${String(i).padStart(2, '0')}`, i * 200));
  // No count rule at all, and a ruleset that tried to allow 500.
  for (const rs of [ruleset([]), ruleset([{ id: 'loose', type: 'count', max: 500 }])]) {
    const verdict = evaluateRules(rs, pieces, catalog);
    const cap = verdict.violations.find((v) => v.ruleId === 'engine.countMax');
    assert.ok(cap, 'the engine cap fires regardless of the ruleset');
    assert.equal(cap!.severity, 'error');
    assert.deepEqual(cap!.messageParams, { count: 21, max: 20 });
    assert.equal(verdict.ok, false);
  }
  assert.equal(evaluateRules(ruleset([]), pieces.slice(0, COUNT_MAX), catalog).ok, true);
});

// ── adjacency ────────────────────────────────────────────────────────────────

test('adjacency: required edges, allow, and forbid-after-allow', () => {
  const rules = ruleset([
    {
      id: 'links', type: 'adjacency', select: { tags: ['seat'] },
      edges: {
        left: { required: true, allow: { tags: ['seat', 'arm'] } },
        front: { forbid: { tags: ['ottoman'] } },
      },
    },
  ], { minContactCm: 30 });

  // An orphan seat: its left edge is open.
  const orphan = evaluateRules(rules, [seat('s1', 0)], catalog);
  assert.deepEqual(orphan.violations.map((v) => [v.messageKey, v.edges]), [
    ['rules.adjacency.openEdge', [{ a: 's1', b: null, edge: 'left' }]],
  ]);

  // An arm on the left satisfies both `required` and `allow`.
  const armed = evaluateRules(rules, [{ uid: 'a1', modelId: 'arm', x: -40, y: 0 }, seat('s1', 0)], catalog);
  assert.deepEqual(armed.violations, []);

  // A corner on the left is a contact (so not open) but is not allowed there.
  const wrong = evaluateRules(rules, [{ uid: 'c1', modelId: 'corner', x: -90, y: 0 }, seat('s1', 0)], catalog);
  assert.deepEqual(wrong.violations.map((v) => [v.messageKey, v.pieces, v.edges]), [
    ['rules.adjacency.notAllowed', ['c1', 's1'], [{ a: 's1', b: 'c1', edge: 'left' }]],
  ]);

  // Nothing docks to a seat's front.
  const blocked = evaluateRules(
    rules,
    [{ uid: 'a1', modelId: 'arm', x: -40, y: 0 }, seat('s1', 0), { uid: 'o1', modelId: 'ottoman', x: 0, y: 90 }],
    catalog,
  );
  assert.deepEqual(blocked.violations.map((v) => [v.messageKey, v.edges]), [
    ['rules.adjacency.forbidden', [{ a: 's1', b: 'o1', edge: 'front' }]],
  ]);
});

test("adjacency: freeform contacts are only actionable through freeform:'violate'", () => {
  const pieces = [seat('s1', 0), seat('s2', 80, 45)];
  const ignore = evaluateRules(
    ruleset([{ id: 'links', type: 'adjacency', select: { tags: ['seat'] }, edges: { front: { forbid: { tags: ['seat'] } } } }]),
    pieces, catalog,
  );
  assert.deepEqual(ignore.violations, [], 'a free-angle seam names no edge, so no edge rule can act on it');

  const strict = evaluateRules(
    ruleset([{
      id: 'links', type: 'adjacency', freeform: 'violate', select: { tags: ['seat'] },
      edges: { front: { forbid: { tags: ['seat'] } } },
    }]),
    pieces, catalog,
  );
  assert.deepEqual(strict.violations.map((v) => [v.messageKey, v.pieces]), [
    ['rules.adjacency.freeform', ['s1', 's2']],
  ], 'reported ONCE, not once per side');
});

// ── option ───────────────────────────────────────────────────────────────────

test('option: `when` gates, `require` must hold, `forbid` may not', () => {
  const rules = ruleset([{
    id: 'leather-legs', type: 'option',
    when: [{ path: 'material.family', op: 'eq', value: 'CUIR' }],
    require: [{ path: 'partFinishes.legs', op: 'in', value: ['noir', 'acero-negro'] }],
    forbid: [{ path: 'partMaterials.interior.code', op: 'set' }],
  }]);

  const fabric = evaluateRules(rules, [seat('s1', 0, 0, { material: { family: 'TISSU' } })], catalog);
  assert.deepEqual(fabric.violations, [], '`when` did not hold — the rule says nothing');

  const bare = evaluateRules(rules, [seat('s1', 0, 0, { material: { family: 'CUIR' } })], catalog);
  assert.deepEqual(bare.violations.map((v) => [v.messageKey, v.messageParams]), [
    ['rules.option.require', { path: 'partFinishes.legs', op: 'in', value: 'noir, acero-negro' }],
  ], 'an unset pick is not among the allowed ones');

  const good = evaluateRules(rules, [
    seat('s1', 0, 0, { material: { family: 'CUIR' }, partFinishes: { legs: 'noir' } }),
  ], catalog);
  assert.deepEqual(good.violations, []);

  const forbidden = evaluateRules(rules, [
    seat('s1', 0, 0, {
      material: { family: 'CUIR' },
      partFinishes: { legs: 'acero-negro' },
      partMaterials: { interior: { code: 'B0032' } },
    }),
  ], catalog);
  assert.deepEqual(forbidden.violations.map((v) => v.messageKey), ['rules.option.forbid']);
});

test('option: a junk pick reads as UNSET, never as an exception', () => {
  const rules = ruleset([{
    id: 'fabric-picked', type: 'option', severity: 'warning',
    require: [{ path: 'material.code', op: 'set' }],
  }]);
  const junk: PlacedPiece[] = [
    seat('s1', 0, 0, { material: null }),
    seat('s2', 80, 0, { material: { code: '   ' } }),
    seat('s3', 160, 0, { material: 'B0021' as unknown as PlacedPiece['material'] }),
    seat('s4', 240, 0, { material: { code: 'B0021' } }),
  ];
  const verdict = evaluateRules(rules, junk, catalog);
  assert.deepEqual(verdict.violations.map((v) => v.pieces), [['s1'], ['s2'], ['s3']]);
  assert.equal(verdict.ok, true, 'warnings never flip ok — rules report, they do not prevent');
});

// ── uniform ──────────────────────────────────────────────────────────────────

test('uniform: the matched pieces must agree; a piece with NO pick abstains', () => {
  const rules = ruleset([{
    id: 'one-fabric', type: 'uniform', select: { tags: ['seat'] }, path: 'material.code',
  }]);
  const agree = evaluateRules(rules, [
    seat('s1', 0, 0, { material: { code: 'VN-9020' } }),
    seat('s2', 80, 0, { material: { code: 'VN-9020' } }),
    seat('s3', 160, 0),
  ], catalog);
  assert.deepEqual(agree.violations, [], 'an unpicked piece has not disagreed yet');

  const differ = evaluateRules(rules, [
    seat('s1', 0, 0, { material: { code: 'VN-9020' } }),
    seat('s2', 80, 0, { material: { code: 'CU-114' } }),
  ], catalog);
  assert.deepEqual(differ.violations.map((v) => [v.messageKey, v.messageParams, v.pieces]), [
    ['rules.uniform.mismatch', { path: 'material.code', count: 2, values: 'CU-114, VN-9020' }, ['s1', 's2']],
  ]);
});

// ── extent ───────────────────────────────────────────────────────────────────

test('extent: the union AABB of the matched pieces, seat-mounts excluded', () => {
  const rules = ruleset([{
    id: 'rail-span', type: 'extent', select: { tags: ['seat', 'corner'] },
    maxWidthCm: 200, minDepthCm: 50,
  }]);
  const within = evaluateRules(rules, [seat('s1', 0), seat('s2', 80)], catalog);
  assert.deepEqual(within.violations, []);

  const wide = evaluateRules(rules, [seat('s1', 0), seat('s2', 80), seat('s3', 160)], catalog);
  assert.deepEqual(wide.violations.map((v) => [v.messageKey, v.messageParams]), [
    ['rules.extent.maxWidth', { widthCm: 240, maxWidthCm: 200 }],
  ]);

  // A rotated piece measures by its rotated AABB.
  const turned = evaluateRules(rules, [seat('s1', 0), { uid: 's2', modelId: 'seat', x: 80, y: 0, rot: 90 }], catalog);
  assert.deepEqual(turned.violations, [], '80 + 90 cm of footprint is still inside 200');

  // Nothing matched is a `count` question, not an extent one.
  assert.deepEqual(evaluateRules(rules, [{ uid: 'c1', modelId: 'cushion', x: 0, y: 0 }], catalog).violations, []);
});

// ── engine properties ────────────────────────────────────────────────────────

test('unknown rule types are reported, never silently valid', () => {
  const verdict = evaluateRules(
    ruleset([
      { id: 'stack', type: 'stacking', maxHeightCm: 200 },
      { id: 'ports', type: 'connector' },
      { id: 'seats', type: 'count', select: { tags: ['seat'] }, min: 1 },
    ]),
    [seat('s1', 0)],
    catalog,
  );
  assert.deepEqual(verdict.unknownRules, ['ports', 'stack']);
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.ok, true, 'ok only speaks for what this engine judged — the API fails closed on unknownRules');
});

test('an off-step rotation is itself a violation under rotationStepDeg: 90', () => {
  const strict = ruleset([], { rotationStepDeg: 90 });
  const free = ruleset([], { rotationStepDeg: 0 });
  const pieces = [seat('s1', 0), seat('s2', 400, 45)];
  const judged = evaluateRules(strict, pieces, catalog);
  assert.deepEqual(judged.violations.map((v) => [v.ruleId, v.pieces, v.messageParams]), [
    ['params.rotationStepDeg', ['s2'], { stepDeg: 90, count: 1 }],
  ]);
  assert.deepEqual(evaluateRules(free, pieces, catalog).violations, [], 'free-form collections rotate freely');
});

test('the per-rule message override rides the Verdict (which travels without the ruleset)', () => {
  const verdict = evaluateRules(
    ruleset([{
      id: 'seats', type: 'count', select: { tags: ['seat'] }, min: 1,
      message: { es: 'Añade al menos un asiento', en: 'Add at least one seat' },
    }]),
    [], catalog,
  );
  assert.deepEqual(verdict.violations[0].message, { es: 'Añade al menos un asiento', en: 'Add at least one seat' });
});

test('THROW-FREE: no input shape can raise', () => {
  const rules = ruleset([
    { id: 'seats', type: 'count', select: { tags: ['seat'] }, min: 1, max: 4 },
    { id: 'links', type: 'adjacency', select: { tags: ['seat'] }, edges: { left: { required: true } } },
    { id: 'fabric', type: 'option', require: [{ path: 'material.code', op: 'set' }] },
    { id: 'agree', type: 'uniform', path: 'partFinishes.legs' },
    { id: 'span', type: 'extent', maxWidthCm: 400 },
  ]);
  const junkPieces = [
    null, undefined, 42, 'piece', [],
    { uid: 's1' },
    { uid: 's1', modelId: null },
    { uid: { nested: true }, modelId: 'seat' },
    { uid: 's2', modelId: 'seat', x: 'left', y: null, rot: 'sideways' },
    { uid: 's3', modelId: 'seat', material: 5, partMaterials: 'red', partFinishes: [] },
    { uid: 's4', modelId: 'seat', partMaterials: { interior: null } },
  ] as unknown as PlacedPiece[];
  for (const catalogArg of [catalog, null, undefined, {} as RuleCatalog, { modelById: null } as unknown as RuleCatalog]) {
    const verdict = evaluateRules(rules, junkPieces, catalogArg);
    assert.ok(Array.isArray(verdict.violations));
    assert.equal(typeof verdict.ok, 'boolean');
  }
  for (const rs of [null, undefined, {}, { rules: 'none' }, { rules: [null, 7, 'x'] }] as unknown as Ruleset[]) {
    const verdict = evaluateRules(rs, [seat('s1', 0)], catalog);
    assert.deepEqual(verdict.violations, []);
  }
  // A stale graph (uids that no longer exist) judges what it can and moves on.
  const stale = contactGraph([seat('gone', 0), seat('also-gone', 80)], catalog);
  assert.ok(Array.isArray(evaluateRules(rules, [seat('s1', 0)], catalog, stale).violations));
});

test('DETERMINISTIC: the same input twice is deep-equal, and violations are sorted', () => {
  const rules = ruleset([
    { id: 'span', type: 'extent', maxWidthCm: 100 },
    { id: 'agree', type: 'uniform', select: { tags: ['seat'] }, path: 'material.code' },
    { id: 'links', type: 'adjacency', select: { tags: ['seat'] }, edges: { left: { required: true }, right: { required: true } } },
    { id: 'seats', type: 'count', select: { tags: ['seat'] }, max: 2 },
    { id: 'fabric', type: 'option', require: [{ path: 'partFinishes.legs', op: 'set' }] },
  ], { minContactCm: 30 });
  const pieces = [
    seat('s3', 160, 0, { material: { code: 'CU-114' } }),
    seat('s1', 0, 0, { material: { code: 'VN-9020' } }),
    seat('s2', 80, 0, { material: { code: 'VN-9020' } }),
  ];
  const first = evaluateRules(rules, pieces, catalog);
  const second = evaluateRules(rules, pieces, catalog);
  assert.deepEqual(first, second);
  assert.ok(first.violations.length > 3, 'a meaningfully broken build');

  const keys = first.violations.map((v) => `${v.ruleId}|${v.messageKey}|${v.pieces.join(',')}`);
  assert.deepEqual(keys, [...keys].sort(), 'sorted by ruleId, then message, then pieces');

  // The same build in a different array order is the same verdict.
  const shuffled = evaluateRules(rules, [pieces[1], pieces[2], pieces[0]], catalog);
  assert.deepEqual(shuffled, first);
});

test('BUDGET: 20 pieces × 30 rules evaluates inside the sub-millisecond design point', () => {
  const pieces = Array.from({ length: COUNT_MAX }, (_, i) => seat(
    `p${String(i).padStart(2, '0')}`,
    i * 80,
    0,
    { material: { code: 'VN-9020', grade: 'D', family: 'TISSU' }, partFinishes: { legs: 'noir' } },
  ));
  const rules: unknown[] = [];
  for (let i = 0; i < 6; i++) rules.push({ id: `count-${i}`, type: 'count', select: { tags: ['seat'] }, min: 1, max: 20 });
  for (let i = 0; i < 6; i++) {
    rules.push({
      id: `adj-${i}`, type: 'adjacency', select: { tags: ['seat'] },
      edges: {
        left: { required: i === 0, allow: { tags: ['seat', 'arm', 'corner'] } },
        right: { allow: { tags: ['seat', 'arm', 'corner'] } },
        front: { forbid: { tags: ['ottoman'] } },
      },
    });
  }
  for (let i = 0; i < 10; i++) {
    rules.push({
      id: `opt-${i}`, type: 'option',
      when: [{ path: 'material.family', op: 'eq', value: 'TISSU' }],
      require: [{ path: 'material.code', op: 'set' }, { path: 'partFinishes.legs', op: 'in', value: ['noir', 'acero-negro'] }],
    });
  }
  for (let i = 0; i < 4; i++) rules.push({ id: `uni-${i}`, type: 'uniform', select: { tags: ['seat'] }, path: 'material.code' });
  for (let i = 0; i < 4; i++) rules.push({ id: `ext-${i}`, type: 'extent', select: { tags: ['seat'] }, maxWidthCm: 5000 });
  assert.equal(rules.length, 30);

  const rs = ruleset(rules, { minContactCm: 30 });
  const graph = contactGraph(pieces, catalog, rs.params);
  assert.ok(graph.contacts.length >= COUNT_MAX - 1, 'a real run, not 20 lonely boxes');

  // Warm up, then measure — the caller memoizes the graph, so the pinned budget
  // is the evaluation itself (the graph is measured separately, for the log).
  for (let i = 0; i < 300; i++) evaluateRules(rs, pieces, catalog, graph);
  const runs = 200;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) evaluateRules(rs, pieces, catalog, graph);
  const perEval = (performance.now() - t0) / runs;

  const g0 = performance.now();
  for (let i = 0; i < runs; i++) contactGraph(pieces, catalog, rs.params);
  const perGraph = (performance.now() - g0) / runs;

  console.log(`  evaluateRules(20 pieces × 30 rules): ${perEval.toFixed(3)} ms/run · contactGraph: ${perGraph.toFixed(3)} ms/run`);
  // Design point is <1 ms; the assertion carries a generous CI margin so a noisy
  // shared runner can't turn a performance PIN into a flake. A regression that
  // matters (an accidental O(n³), a per-gesture re-parse of the world) blows
  // past 5 ms, not past 1.05.
  assert.ok(perEval < 5, `evaluate budget: ${perEval.toFixed(3)} ms`);
  assert.ok(perGraph < 5, `graph budget: ${perGraph.toFixed(3)} ms`);
});
