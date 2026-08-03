// LEARNING FROM WHAT IS ALREADY BOUND, and the case-fold that makes a
// collection one collection.
//
// Owner: «you need to learn from already set things». The confirmed bindings
// are GROUND TRUTH about a convention no prompt can state — and the three most
// instructive ones all CONTRADICT their own geometry, which is why this module
// reports the gap and never enforces it.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXAMPLE_LIMIT, exampleAgreement, formatBindingExamples, indexProductsByRoot, resolveBindingExamples,
} from '../src/vm/bindingExamples.ts';
import {
  DEFAULT_COLLECTION, canonicalCollection, collectionKey, distinctCollections, matchesCollection,
} from '../src/vm/collections.ts';
import type { CatalogProduct } from '../src/vm/autoLink.ts';

const p = (reference: string, name: string, subtype: string, dimensions: string, priceUsd: number): CatalogProduct =>
  ({ reference, name, subtype, dimensions, priceUsd });

const CATALOG: CatalogProduct[] = [
  // A DIAM-only ottoman: a width/depth parser reads NOTHING here, and the
  // dealer bound it anyway.
  p('30001111A', 'PRADO ROUND OTTOMAN', 'COMP. ELEMENT', 'DIAM(33.50) - S(14.50)', 1800),
  p('30001111X', 'PRADO ROUND OTTOMAN', 'COMP. ELEMENT', 'DIAM(33.50) - S(14.50)', 2600),
  // The name never says «2»; the COLLECTION field does.
  p('30002222A', 'PRADO 2 LARGE SQUARE OTTOMAN', 'COMP. ELEMENT', 'W(49.25) - D(49.25)', 3000),
  // Twenty centimetres out, and CORRECT: the catalogue has no 120-deep variant.
  p('30003333A', 'PRADO MEDIUM SOFA', 'COMP. ELEMENT', 'W(78.75) - D(39.25)', 6400),
  p('40004444A', 'EXCLUSIF SOFA', 'W/ ARMREST A COMP. ELEMENT', 'W(95.75) - D(39.25)', 9990),
];

const BOUND = [
  { id: 'm1', name: 'Round Ottoman', collection: 'Prado', widthCm: 82, depthCm: 82, productRoot: '30001111' },
  { id: 'm2', name: 'Large Square Ottoman 125', collection: 'Prado 2', widthCm: 125, depthCm: 125, productRoot: '30002222' },
  { id: 'm3', name: 'Medium Sofa 120 Depth', collection: 'Prado', widthCm: 200, depthCm: 120, productRoot: '30003333' },
  { id: 'm4', name: 'EXCLUSIF gd canapé accoudoir A', collection: 'EXCLUSIF', widthCm: 244, depthCm: 102, productRoot: '40004444' },
  // Not bindings at all: no root, no name, or a root the catalogue dropped.
  { id: 'm5', name: 'Untagged', collection: 'Prado', widthCm: 100, depthCm: 100, productRoot: '' },
  { id: 'm6', name: '', collection: 'Prado', widthCm: 100, depthCm: 100, productRoot: '30001111' },
  { id: 'm7', name: 'Discontinued', collection: 'Prado', widthCm: 100, depthCm: 100, productRoot: '99999999' },
];

test('only real bindings teach — a dropped root, a blank name and no root are not', () => {
  const ex = resolveBindingExamples(BOUND, CATALOG);
  assert.deepEqual(ex.map((e) => e.modelId).sort(), ['m1', 'm2', 'm3', 'm4']);
  // A root the catalogue no longer sells would teach a reference nobody can
  // quote.
  assert.ok(!ex.some((e) => e.root === '99999999'));
});

test('a DIAM-only binding survives — and its geometry AGREES on both axes', () => {
  const [round] = resolveBindingExamples([BOUND[0]!], CATALOG);
  assert.equal(round!.productWidthCm, 85.1);
  assert.equal(round!.productDepthCm, 85.1);
  assert.equal(round!.deltaWidthCm, 3.1);
  // The cheapest published grade row is what a price hint reads.
  assert.equal(round!.fromUsd, 1800);
});

test('the gap is REPORTED, never enforced — the loud examples are the useful ones', () => {
  // «Medium Sofa 120 Depth» is 20 cm deeper than the only variant that exists.
  // That is a business decision: learnable from the example, underivable from
  // the geometry, and it must never be dropped for looking wrong.
  const [sofa] = resolveBindingExamples([BOUND[2]!], CATALOG);
  assert.equal(sofa!.deltaDepthCm, 20.3);
  assert.equal(sofa!.root, '30003333', 'still an example, gap and all');
  // A row that publishes no such axis is ABSENCE, not disagreement.
  assert.deepEqual(
    exampleAgreement({ widthCm: 82, depthCm: 82 }, { dims: { widthCm: null, depthCm: null } }),
    { deltaWidthCm: null, deltaDepthCm: null },
  );
});

test('ranking: same collection first, then house style, then closest in size', () => {
  const ex = resolveBindingExamples(BOUND, CATALOG, { collection: 'exclusif', anchorWidthCm: 240 });
  // Case- and accent-folded, so «EXCLUSIF» and «exclusif» are ONE family.
  assert.equal(ex[0]!.modelId, 'm4');
  assert.equal(ex[0]!.sameCollection, true);
  assert.ok(ex.slice(1).every((e) => !e.sameCollection));
  // Within the house-style tier, the closest in width to the piece being
  // decided — an example about a sofa, not about a cushion standing in for one.
  assert.equal(ex[1]!.modelId, 'm3', `expected the 200 cm sofa nearest 240, got ${ex[1]!.modelName}`);

  // «Prado 2» is NOT «Prado»: a digit is a generation, and folding them would
  // merge two families that price differently.
  const prado = resolveBindingExamples(BOUND, CATALOG, { collection: 'Prado' });
  assert.deepEqual(prado.filter((e) => e.sameCollection).map((e) => e.modelId).sort(), ['m1', 'm3']);
});

test('the caller can exclude the piece being decided, and cap the set', () => {
  assert.ok(!resolveBindingExamples(BOUND, CATALOG, { excludeIds: ['m4'] }).some((e) => e.modelId === 'm4'));
  assert.equal(resolveBindingExamples(BOUND, CATALOG, { limit: 2 }).length, 2);
  assert.equal(resolveBindingExamples(BOUND, CATALOG, { limit: 0 }).length, 0);
  assert.equal(EXAMPLE_LIMIT, 12);
  // A pre-built index is accepted verbatim, so a caller indexes once per batch.
  const index = indexProductsByRoot(CATALOG);
  assert.equal(resolveBindingExamples(BOUND, index).length, 4);
  assert.deepEqual(resolveBindingExamples(null, null), []);
});

test('the prompt lines SPELL OUT the gap — that is the point of printing it', () => {
  const lines = formatBindingExamples(resolveBindingExamples([BOUND[2]!], CATALOG));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /«Medium Sofa 120 Depth» 200×120 cm → 30003333 PRADO MEDIUM SOFA/);
  assert.match(lines[0]!, /Δdepth 20\.3 cm/);
  // A model with no measures says so rather than printing NaN.
  const noSize = formatBindingExamples([{ ...resolveBindingExamples([BOUND[0]!], CATALOG)[0]!, widthCm: null, depthCm: null }]);
  assert.match(noSize[0]!, /no measures/);
  assert.deepEqual(formatBindingExamples(null), []);
});

/* ── One spelling, one collection ───────────────────────────────────────────*/

test('the fold is CASE and ACCENT only — it must never touch digits', () => {
  // The live drift: «Exclusif» (12 models) and «EXCLUSIF» (38) read as two
  // collections. A split collection orders twice, fans a finish to half its
  // siblings, and shows the customer two chips for one family.
  assert.equal(collectionKey('Exclusif'), collectionKey('EXCLUSIF'));
  assert.equal(collectionKey(' exclusif '), collectionKey('EXCLUSIF'));
  assert.equal(collectionKey('Élysée'), collectionKey('elysee'));
  // …and «Prado 2» is a different family that prices differently.
  assert.notEqual(collectionKey('Prado'), collectionKey('Prado 2'));
  assert.equal(collectionKey(''), collectionKey(DEFAULT_COLLECTION));
  assert.equal(collectionKey(null), collectionKey(DEFAULT_COLLECTION));
});

test('the display form depends only on the KEY, never on which row was read first', () => {
  assert.equal(canonicalCollection('EXCLUSIF'), 'Exclusif');
  assert.equal(canonicalCollection('exclusif'), 'Exclusif');
  assert.equal(canonicalCollection('  prado   2 '), 'Prado 2', 'a digit is left alone');
  assert.equal(canonicalCollection(''), 'Togo');
});

test('folding preserves FIRST-APPEARANCE order — a palette must not reshuffle', () => {
  assert.deepEqual(
    distinctCollections(['EXCLUSIF', 'Prado', 'exclusif', 'Prado 2', ' Exclusif ']),
    ['Exclusif', 'Prado', 'Prado 2'],
  );
  assert.deepEqual(distinctCollections([]), []);
});

test('a filter matches by KEY, and «all» matches everything', () => {
  assert.equal(matchesCollection('EXCLUSIF', 'exclusif'), true);
  assert.equal(matchesCollection('Prado', 'Prado 2'), false);
  assert.equal(matchesCollection('anything', 'all'), true);
  assert.equal(matchesCollection('anything', ''), true);
});
