// LO YA DEFINIDO — the dealer's confirmed bindings, read back as examples.
//
// Owner, 2026-08: «you need to learn from already set things». 75 of 125 Togo
// models are already bound by hand. Every fixture below is a REAL live binding,
// and three of them are here because they each broke something that shipped:
//
//   • «Round Ottoman» 82×82 → PRADO ROUND OTTOMAN, whose only measure is
//     `DIAM(33.50)`. The parser read W/D/H/S/THK, so that row measured NOTHING
//     and the piece could never be suggested.
//   • «Large Square Ottoman 125» → PRADO 2 …, where the name never says «2» —
//     the COLLECTION does. Reading the generation off the name alone refused
//     the dealer's own binding as a generation crossing.
//   • «Medium Sofa 120 Depth» (200×120) → a root whose catalog depth is
//     39¼" = 99.7 cm. TWENTY centimetres out, and correct: the catalog has no
//     120-deep variant. That one is NOT "fixed" here — it is reported through
//     `deltaDepthCm`, because whether an example outranks a measurement is a
//     decision for the caller, not a silent default in the gatherer.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBindingExamples, indexProductsByRoot, exampleAgreement, formatBindingExamples,
} from '../src/lib/configurator/bindingExamples.js';
import { parseLrDimensions, resolveModelMatches, indexCandidates } from '../src/lib/configurator/modelMatch.js';

const p = (reference, name, subtype, dimensions, priceUsd) => ({ reference, name, subtype, dimensions, priceUsd });
const m = (id, name, collection, widthCm, depthCm, productRoot) => ({ id, name, collection, widthCm, depthCm, productRoot });

// Verbatim live rows.
const PRODUCTS = [
  p('11370050A', 'PRADO ROUND OTTOMAN', '', 'DIAM(33.50) - S(16)', 3255),
  p('11370021A', 'PRADO BOLSTER', '', 'DIAM(6.25) - W(20.75)', 610),
  p('11370400A', 'PRADO MEDIUM SOFA - D 39¼"', 'COMP. ELEMENT', 'H(34.25) - D(39.25) - S(16) - W(78.75)', 9000),
  p('11370300A', 'PRADO LARGE SQUARE OTTOMAN', 'D 47"', 'D(47.25) - S(16) - W(47.25)', 5000),
  p('11490300A', 'PRADO 2 LARGE SQUARE OTTOMAN', 'D 49¼"', 'D(49.25) - S(16) - W(49.25)', 6000),
];

const MODELS = [
  m('r', 'Round Ottoman', 'Prado', 82, 82, '11370050'),
  m('b', 'Bolster', 'Prado', 54, 17, '11370021'),
  m('s100', 'Medium Sofa 100 Depth', 'Prado', 200, 100, '11370400'),
  m('s120', 'Medium Sofa 120 Depth', 'Prado', 200, 120, '11370400'),
  m('o', 'Large Square Ottoman', 'Prado', 117, 113, '11370300'),
  m('o2', 'Large Square Ottoman 125', 'Prado 2', 115, 113, '11490300'),
  m('none', 'Sin vincular', 'Prado', 100, 100, null),
];

/* ── the axes the dealer's bindings forced open ───────────────────────────── */

test('DIAM measures BOTH axes — a round piece is as wide as it is deep', () => {
  const d = parseLrDimensions('DIAM(33.50) - S(16)');
  assert.equal(d.widthCm, 85.1);
  assert.equal(d.depthCm, 85.1, 'reporting a diameter on one axis makes the other read as a contradiction');
});

test('an explicit W/D OVERWRITES what DIAM or L filled in', () => {
  // The bolster: DIAM is its thickness, W its length. The named axis wins.
  const b = parseLrDimensions('DIAM(6.25) - W(20.75)');
  assert.equal(b.widthCm, 52.7);
  assert.equal(b.depthCm, 15.9);
  const t = parseLrDimensions('L(52) - H(21.75) - W(12.50)');
  assert.equal(t.widthCm, 31.8, 'W is the catalog\'s own word; L is the fallback');
});

test('the W/D/H/S rows are untouched — no regression', () => {
  const d = parseLrDimensions('H(29.50) - D(39.25) - S(16.50) - W(95.75)');
  assert.deepEqual(d, { widthCm: 243.2, depthCm: 99.7, heightCm: 74.9, seatCm: 41.9, thicknessCm: null });
});

test('the round ottoman is REACHABLE now — it measured nothing before', () => {
  const cands = indexCandidates([PRODUCTS[0]]);
  const hit = resolveModelMatches({ name: 'Prado Round Ottoman', widthCm: 82, depthCm: 82 }, cands)[0];
  assert.ok(hit, 'a DIAM-only product must be suggestable');
  assert.equal(hit.root, '11370050');
});

/* ── the generation the collection carries ────────────────────────────────── */

test('the generation is read off the COLLECTION when the name is silent', () => {
  // Sizes chosen to clear the width gate, so this test is ABOUT the generation.
  // (The real «Large Square Ottoman 125» is 115 cm against a 125.1 cm product —
  // 10 cm out, and bound by the dealer anyway. That gap is the geometry gate's
  // problem, deliberately not pinned here: see the module header.)
  const cands = indexCandidates([PRODUCTS[3], PRODUCTS[4]]);
  const gen2 = resolveModelMatches(
    { name: 'Large Square Ottoman 125', collection: 'Prado 2', widthCm: 124, depthCm: 124 }, cands, { limit: 5 },
  );
  assert.equal(gen2[0]?.root, '11490300', 'the dealer\'s own binding must be reachable');
  assert.ok(!gen2.some((c) => c.root === '11370300'), 'and gen-1 must stay out of a gen-2 piece');

  const gen1 = resolveModelMatches(
    { name: 'Large Square Ottoman', collection: 'Prado', widthCm: 119, depthCm: 119 }, cands, { limit: 5 },
  );
  assert.equal(gen1[0]?.root, '11370300');
  assert.ok(!gen1.some((c) => c.root === '11490300'), 'a gen-1 piece must never reach the successor');
});

/* ── gathering ────────────────────────────────────────────────────────────── */

test('only CONFIRMED bindings whose root still exists become examples', () => {
  const ex = resolveBindingExamples([...MODELS, m('gone', 'Fantasma', 'Prado', 10, 10, '99999999')], PRODUCTS);
  const ids = ex.map((e) => e.modelId);
  assert.ok(!ids.includes('none'), 'an unbound model is not a binding');
  assert.ok(!ids.includes('gone'), 'a root the catalog no longer sells teaches a dead reference');
  assert.equal(ex.length, 6);
});

test('same-colección examples lead, then the house style', () => {
  const ex = resolveBindingExamples(MODELS, PRODUCTS, { collection: 'PRADO 2' });
  assert.equal(ex[0].modelId, 'o2', 'the piece\'s own colección teaches first');
  assert.ok(ex.slice(1).every((e) => !e.sameCollection));
  // Case-folded: «PRADO 2» and «Prado 2» are one collection (lib/configurator/collections).
  assert.equal(resolveBindingExamples(MODELS, PRODUCTS, { collection: 'prado 2' })[0].modelId, 'o2');
});

test('within a tier the closest-in-size example leads', () => {
  const ex = resolveBindingExamples(MODELS, PRODUCTS, { collection: 'Prado', anchorWidthCm: 200 });
  assert.ok(['s100', 's120'].includes(ex[0].modelId), `expected a ~200 cm example first, got ${ex[0].modelId}`);
});

test('excludeIds keeps the piece being decided out of its own examples', () => {
  const ex = resolveBindingExamples(MODELS, PRODUCTS, { excludeIds: ['r', 'b'] });
  assert.ok(!ex.some((e) => ['r', 'b'].includes(e.modelId)));
});

/* ── the disagreement is REPORTED, never resolved here ────────────────────── */

test('an example that contradicts its geometry is KEPT, and its gap stated', () => {
  const ex = resolveBindingExamples(MODELS, PRODUCTS, { limit: 20 });
  const s120 = ex.find((e) => e.modelId === 's120');
  assert.ok(s120, 'the most instructive example must not be dropped for looking wrong');
  assert.equal(s120.root, '11370400');
  assert.equal(s120.deltaWidthCm, 0);
  assert.equal(s120.deltaDepthCm, 20.3, 'twenty centimetres out, and the dealer\'s answer');
  // The gatherer states no precedence — that decision belongs to the caller.
  assert.ok(!('overrides' in s120) && !('trusted' in s120));
});

test('a missing catalog axis is not a disagreement', () => {
  const agree = exampleAgreement({ widthCm: 82, depthCm: 82 }, { dims: { widthCm: null, depthCm: null } });
  assert.deepEqual(agree, { deltaWidthCm: null, deltaDepthCm: null });
});

test('formatting spells the gap out, because the big ones are the lesson', () => {
  const ex = resolveBindingExamples([MODELS[3]], PRODUCTS);
  const [line] = formatBindingExamples(ex);
  assert.match(line, /«Medium Sofa 120 Depth» 200×120 cm → 11370400/);
  assert.match(line, /Δfondo 20\.3 cm/);
});

test('gathering is pure and survives junk rows', () => {
  const snapshot = JSON.parse(JSON.stringify(MODELS));
  assert.deepEqual(resolveBindingExamples(null, PRODUCTS), []);
  assert.deepEqual(resolveBindingExamples(MODELS, null), []);
  assert.doesNotThrow(() => resolveBindingExamples([null, {}, { id: 'x' }], PRODUCTS));
  assert.deepEqual(MODELS, snapshot);
  assert.ok(indexProductsByRoot(null) instanceof Map);
});
