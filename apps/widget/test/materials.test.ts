/**
 * The two-level picker and the MaterialSource it shares with the renderer.
 * What the visitor taps and what the piece is upholstered in come from the
 * same rows — this pins that they cannot disagree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialSource, pickFromColor, resolveMaterialPicker } from '../src/vm/materials.ts';
import { resolveMaterialFamilies } from '../src/vm/catalog.ts';
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
