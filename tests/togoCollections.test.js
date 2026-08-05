// COLECCIÓN — one spelling, one collection.
//
// The live catalog held «Exclusif» (12 models) and «EXCLUSIF» (38) as two
// separate collections. The collection is the unit of ORDER in the palette, the
// unit an estructura finish fans out across, and the unit every filter and the
// client menu group by — so a split collection orders twice, fans a finish to
// half its siblings, and shows the customer two chips for one family.
//
// The pin that matters most is the one that must NOT fold: «Prado» and
// «Prado 2» are different collections in the same live catalog (12 and 6
// models), exactly like the EXCLUSIF/EXCLUSIF 2 generations in the price list.
// A normaliser that ate the digit would merge two families that price
// differently — the same class of mistake as binding a piece to its cheap twin.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectionKey, canonicalCollection, distinctCollections, matchesCollection, DEFAULT_COLLECTION,
} from '../src/lib/togo/collections.js';
import { resolveModelManager } from '../src/core/quote/views/modelManager.js';
import { resolveTogoModels, resolveTogoModelCards, resolveCollectionMenu } from '../src/core/quote/views/configuratorView.js';

const model = (over = {}) => ({
  id: 'm1', name: 'Pieza', svg: '<svg/>', widthCm: 174, depthCm: 102, active: true, ...over,
});

/* ── the fold ─────────────────────────────────────────────────────────────── */

test('case and accents fold; the two live Exclusif spellings are ONE key', () => {
  assert.equal(collectionKey('EXCLUSIF'), collectionKey('Exclusif'));
  assert.equal(collectionKey('  exclusif  '), collectionKey('EXCLUSIF'));
  assert.equal(collectionKey('Élysée'), collectionKey('ELYSEE'));
});

test('DIGITS NEVER FOLD — «Prado» and «Prado 2» stay two collections', () => {
  assert.notEqual(collectionKey('Prado'), collectionKey('Prado 2'));
  assert.notEqual(collectionKey('EXCLUSIF'), collectionKey('EXCLUSIF 2'));
  assert.notEqual(canonicalCollection('Prado'), canonicalCollection('Prado 2'));
});

test('the display form is the dealer\'s own convention — Título Capitalizado', () => {
  assert.equal(canonicalCollection('EXCLUSIF'), 'Exclusif');
  assert.equal(canonicalCollection('Exclusif'), 'Exclusif');
  assert.equal(canonicalCollection('exclusif'), 'Exclusif');
  assert.equal(canonicalCollection('Prado 2'), 'Prado 2');
  // Blank keeps the long-standing default rather than inventing an empty chip.
  assert.equal(canonicalCollection(''), DEFAULT_COLLECTION);
  assert.equal(canonicalCollection(null), DEFAULT_COLLECTION);
  assert.equal(canonicalCollection('   '), DEFAULT_COLLECTION);
});

test('a non-word token is left alone, never mangled', () => {
  assert.equal(canonicalCollection('CORNER S 45°'), 'Corner S 45°');
});

test('distinctCollections dedupes but PRESERVES first-appearance order', () => {
  // Palette order is the dealer's own ordering; folding must not reshuffle it.
  const out = distinctCollections(['Prado', 'EXCLUSIF', 'Prado 2', 'Exclusif', null, 'prado']);
  assert.deepEqual(out, ['Prado', 'Exclusif', 'Prado 2', DEFAULT_COLLECTION]);
});

test('matchesCollection understands the filter vocabulary', () => {
  assert.equal(matchesCollection('EXCLUSIF', 'Exclusif'), true);
  assert.equal(matchesCollection('Exclusif', 'EXCLUSIF'), true);
  assert.equal(matchesCollection('Prado', 'Prado 2'), false);
  for (const all of ['all', '', null, undefined]) {
    assert.equal(matchesCollection('whatever', all), true, `«${String(all)}» must match everything`);
  }
});

/* ── the surfaces that group by it ────────────────────────────────────────── */

const SPLIT = [
  model({ id: 'a', collection: 'EXCLUSIF' }),
  model({ id: 'b', collection: 'Exclusif' }),
  model({ id: 'c', collection: 'Prado' }),
  model({ id: 'd', collection: 'Prado 2' }),
];

test('the GESTOR offers one Exclusif, and its filter catches both spellings', () => {
  const all = resolveModelManager(SPLIT);
  assert.deepEqual(all.collections, ['Exclusif', 'Prado', 'Prado 2']);
  const only = resolveModelManager(SPLIT, { collection: 'Exclusif' });
  assert.deepEqual(only.rows.map((r) => r.id).sort(), ['a', 'b'], 'both spellings must be in the collection');
  // And the sibling collection is untouched by the fold.
  assert.deepEqual(resolveModelManager(SPLIT, { collection: 'Prado' }).rows.map((r) => r.id), ['c']);
});

test('the PALETTE lists one Exclusif chip, not two', () => {
  const vm = resolveTogoModels(SPLIT, []);
  assert.deepEqual(vm.collections, ['Exclusif', 'Prado', 'Prado 2']);
  assert.equal(vm.resolvedById.a.collection, 'Exclusif');
  assert.equal(vm.resolvedById.b.collection, 'Exclusif', 'the lowercase twin must read the same');
});

test('the model CARDS file both spellings under one collection', () => {
  const cards = resolveTogoModelCards(SPLIT, []);
  const cols = [...new Set(cards.map((c) => c.collection))].sort();
  assert.deepEqual(cols, ['Exclusif', 'Prado', 'Prado 2']);
});

/* ── the widget's two halves ──────────────────────────────────────────────── */

// The public payload ships `togo_models.collection` RAW, so the configurador
// folds TWICE over the same rows: `resolveCollectionMenu` builds the index tile
// the visitor taps (and the name it hands back), while the piece grid scopes the
// rows by `collectionKey` against that name. Fold on one side only and the tile
// opens on an EMPTY grid — which is exactly how Exclusif's ONE published piece
// became unreachable in the widget: the tile said «Exclusif», the row said
// «EXCLUSIF», and a `===` between them matched nothing.
const gridFor = (models, name) => models.filter((m) => collectionKey(m.collection) === collectionKey(name));

test('the WIDGET index and its piece grid agree on every collection', () => {
  const menu = resolveCollectionMenu(SPLIT, []);
  assert.deepEqual(
    menu.map((e) => e.collection),
    distinctCollections(SPLIT.map((m) => m.collection)),
    'the tiles and the step list must be the same names, in the same order',
  );
  for (const e of menu) {
    assert.equal(
      gridFor(SPLIT, e.collection).length, e.count,
      `«${e.collection}»: the tile promises ${e.count} and the grid shows ${gridFor(SPLIT, e.collection).length}`,
    );
  }
});

test('a collection published ONLY under the shouting spelling still opens', () => {
  // The live catalogue, 2026-08: every «Exclusif» row is a borrador and the one
  // published piece is stored «EXCLUSIF», so the widget serves a single row
  // whose stored name differs from the name its own tile shows.
  const served = [model({ id: 'x', collection: 'EXCLUSIF' })];
  const [entry] = resolveCollectionMenu(served, []);
  assert.equal(entry.collection, 'Exclusif');
  assert.equal(entry.count, 1);
  assert.deepEqual(gridFor(served, entry.collection).map((m) => m.id), ['x']);
});
