/**
 * The two-level picker and the MaterialSource it shares with the renderer.
 * What the visitor taps and what the piece is upholstered in come from the
 * same rows — this pins that they cannot disagree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialSource, pickFromColor, pickLaddersFor, resolveMaterialPicker } from '../src/vm/materials.ts';
import { resolveMaterialFamilies, resolveWidgetCatalog } from '../src/vm/catalog.ts';
import { catalogPayload } from './fixtures.ts';

const { families, colorByCode } = resolveMaterialFamilies(catalogPayload.materials);
const view = (over: Partial<Parameters<typeof resolveMaterialPicker>[1]> = {}) =>
  resolveMaterialPicker(families, { locale: 'es', ...over });

test('level 1 is families; level 2 is that family\'s colours', () => {
  const top = view();
  assert.deepEqual(top.families.map((f) => f.name), ['TISSU', 'CUIR']);
  assert.deepEqual(top.colors, []);
  const open = view({ openFamilyId: 'mat-tissu' });
  assert.equal(open.openFamily?.name, 'TISSU');
  assert.deepEqual(open.colors.map((c) => c.code), ['B0021', 'B0032']);
});

test('the count line is one/other and localized', () => {
  const top = view();
  const tissu = top.families[0];
  const cuir = top.families[1];
  assert.equal(top.countLabel(tissu), '2 colores');
  assert.equal(top.countLabel(cuir), '1 color', 'never "1 colores"');
  assert.equal(view({ locale: 'de' }).countLabel(cuir), '1 Farbe');
});

test('search matches a family name — the whole range stays visible', () => {
  const found = view({ search: 'tis' });
  assert.deepEqual(found.families.map((f) => f.id), ['mat-tissu']);
  assert.equal(found.countLabel(found.families[0]), '2 colores');
});

test('search matches a COLOUR name or code — the tile says how many matched', () => {
  const byName = view({ search: 'bleu' });
  assert.deepEqual(byName.families.map((f) => f.id), ['mat-tissu']);
  assert.equal(byName.countLabel(byName.families[0]), '1 color coincide');
  const byCode = view({ search: 'b00' });
  assert.equal(byCode.countLabel(byCode.families[0]), '2 colores coinciden');
});

test('a search with no hits reports empty rather than an unfiltered list', () => {
  const none = view({ search: 'zzzz' });
  assert.deepEqual(none.families, []);
  assert.equal(none.empty, true);
});

test('the category filter narrows to one kind of material', () => {
  assert.deepEqual(view().categories, ['fabric', 'leather']);
  assert.deepEqual(view({ category: 'leather' }).families.map((f) => f.id), ['mat-cuir']);
});

test('a colour tile becomes the stored pick, grade included', () => {
  const pick = pickFromColor(colorByCode.B0021);
  assert.equal(pick.code, 'B0021');
  assert.equal(pick.fabric, 'Bleu Paon');
  assert.equal(pick.grade, 'C');
  assert.equal(pick.subtype, 'C — Bleu Paon');
  assert.equal(pick.unitPrice, null, 'the price is derived, never carried from a tile');
  // A single-grade catalogue composes the plain name.
  assert.equal(pickFromColor({ ...colorByCode.B0021, grade: '' }).subtype, 'Bleu Paon');
});

test('the MaterialSource answers for every catalogued code and null otherwise', () => {
  const source = createMaterialSource(colorByCode);
  assert.deepEqual(source.resolveColor('B0021'), {
    rgb: '#1d4a5a', textureUrl: 'tex/tissu.jpg', normalUrl: null, tileCm: null, tileCmY: null,
  });
  assert.equal(source.resolveColor('NOPE'), null);
  assert.equal(source.resolveColor(''), null);
});

test('no materials at all is a valid, empty picker (not a crash)', () => {
  const empty = resolveMaterialPicker(null, { locale: 'es' });
  assert.deepEqual(empty.families, []);
  assert.deepEqual(empty.categories, []);
  assert.equal(empty.empty, true);
});

// ── THE WALL IS THE TARGET'S OWN LADDER ─────────────────────────────────────
// Owner rule: only the fabrics that really correspond to a model come up for it.
// A tile the price gate would refuse is a trap — the pick stores, the piece
// reads «sin precio», and the visitor is left holding a piece nobody can quote.
const fireside = resolveWidgetCatalog({ payload: catalogPayload }).modelById['m-fireside'];
const ottoman = resolveWidgetCatalog({ payload: catalogPayload }).modelById['m-ottoman'];

test('the picker offers only the grades the target\'s ladder sells', () => {
  // The Fireside's ladder sells A and C; TISSU is grade C, CUIR is grade X.
  const ladders = pickLaddersFor({ scope: 'piece', model: fireside });
  const walled = resolveMaterialPicker(families, { locale: 'es', ladders });
  assert.deepEqual(walled.families.map((f) => f.id), ['mat-tissu'], 'the off-ladder leather never renders as a tile');
  // …and the drilled-in family shows only its own offered colours.
  const open = resolveMaterialPicker(families, { locale: 'es', ladders, openFamilyId: 'mat-tissu' });
  assert.deepEqual(open.colors.map((c) => c.code), ['B0021', 'B0032']);
});

test('a ladder-less family constrains NOTHING — a catalogue with no grades keeps its wall', () => {
  // The Ottoman is unbound: it prices any grade by construction.
  const ladders = pickLaddersFor({ scope: 'piece', model: ottoman });
  assert.deepEqual(
    resolveMaterialPicker(families, { locale: 'es', ladders }).families.map((f) => f.id),
    ['mat-tissu', 'mat-cuir'],
  );
  assert.deepEqual(view().families.map((f) => f.id), ['mat-tissu', 'mat-cuir'], 'and no ladders at all is the same');
});

test('«apply to all» is the INTERSECTION of every placed piece\'s ladder', () => {
  const ladders = pickLaddersFor({ scope: 'all', models: [fireside, ottoman] });
  const walled = resolveMaterialPicker(families, { locale: 'es', ladders });
  // A cloth that prices on one model and not the other would leave that one
  // silently at its cheapest grade — the same lie, spread thinner.
  assert.deepEqual(walled.families.map((f) => f.id), ['mat-tissu']);
});

test('a PART picks against its own family — a zone re-grades the base SKU', () => {
  const withParts = {
    ...fireside,
    partFamilies: { cushion: { root: 'CUSH', name: 'CUSH', graded: true, grades: ['X'], byGrade: { X: { priceUsd: 90, reference: 'CUSHX' } } } },
  } as unknown as typeof fireside;
  // The cushion ladder sells X only ⇒ the leather is the offer and the tissu is out.
  const part = pickLaddersFor({ scope: 'part', model: withParts, role: 'cushion' });
  assert.deepEqual(resolveMaterialPicker(families, { locale: 'es', ladders: part }).families.map((f) => f.id), ['mat-cuir']);
  // A materialization ZONE has no family of its own: it re-grades the model's.
  const zone = pickLaddersFor({ scope: 'part', model: withParts, role: 'exterior' });
  assert.deepEqual(resolveMaterialPicker(families, { locale: 'es', ladders: zone }).families.map((f) => f.id), ['mat-tissu']);
});

test('NO-VANISH at the door: an empty offer ships the catalogue whole', () => {
  // Disjoint ladders across an «apply to all» can reach this. A picker with
  // nothing on it answers no question at all, so the gates downstream take over.
  const disjoint = pickLaddersFor({
    scope: 'all',
    models: [
      fireside,
      { ...fireside, baseFamily: { root: 'Z', name: 'Z', graded: true, grades: ['Q'], byGrade: { Q: { priceUsd: 1, reference: 'ZQ' } } } } as unknown as typeof fireside,
    ],
  });
  assert.deepEqual(
    resolveMaterialPicker(families, { locale: 'es', ladders: disjoint }).families.map((f) => f.id),
    ['mat-tissu', 'mat-cuir'],
  );
});
