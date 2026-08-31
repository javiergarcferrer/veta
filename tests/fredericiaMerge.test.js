/**
 * LAS DOS FUENTES, JUNTAS — y lo que pasa cuando no se puede estar seguro.
 *
 * Fredericia publishes the product; Anthom Design House publishes the shop. The
 * manufacturer is authoritative about what EXISTS (named axes, real SKUs,
 * swatches, dimensions) and the distributor about what it COSTS HERE, because
 * the manufacturer's page prices in DKK and EUR and in nine internal groups
 * whose meaning it does not publish.
 *
 * The whole difficulty is that they write the same thing differently:
 *
 *   FABRICANTE                       ANTHOM
 *   Oak oil, FSC Mix 70%             Oak Oiled
 *   Smoked oak, olied, FSC Mix 70%   Oak Smoked Oiled      ← «olied», su errata
 *   Leather, natural                 Natural Saddle
 *
 * Every fixture here is real: the manufacturer capture beside the rows the
 * Anthom importer actually wrote into `products`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { shapeFredericiaProduct } from '../supabase/functions/fredericia-catalog/parse.ts';
import {
  coreTokens, matchAxisValue, planFredericiaMerge, dimensionLine,
} from '../src/brands/fredericia/mergeSources.js';
import { splitConfiguration } from '../src/lib/variantFacets.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fredericia');
const PRODUCT = shapeFredericiaProduct(
  JSON.parse(readFileSync(join(FIX, 'spanishChair.pageProps.json'), 'utf8')),
);

/** The Anthom rows for 2226, verbatim from `products`. */
const ANTHOM = [
  ['FRE-2226-CLT-OO', 'Oak Oiled · Cognac Saddle'],
  ['FRE-2226-BLT-OO', 'Oak Oiled · Black Saddle'],
  ['FRE-2226-DBLT-OO', 'Oak Oiled · Dark Brown Saddle'],
  ['FRE-2226-NLT-OO', 'Oak Oiled · Natural Saddle'],
  ['FRE-2226-CLT-OLO', 'Oak Light Oiled · Cognac Saddle'],
  ['FRE-2226-NLT-OLO', 'Oak Light Oiled · Natural Saddle'],
  ['FRE-2226-CLT-OSO', 'Oak Smoked Oiled · Cognac Saddle'],
  ['FRE-2226-BLT-OSO', 'Oak Smoked Oiled · Black Saddle'],
  ['FRE-2226-NLT-OSO', 'Oak Smoked Oiled · Natural Saddle'],
  ['FRE-2226-CLT-OS', 'Oak Soap · Cognac Saddle'],
  ['FRE-2226-NLT-OS', 'Oak Soap · Natural Saddle'],
  ['FRE-2226-CLT-WO', 'Walnut Oiled · Cognac Saddle'],
  ['FRE-2226-NLT-WO', 'Walnut Oiled · Natural Saddle'],
].map(([reference, conf]) => ({ id: `fre-${reference}`, reference, configuration: splitConfiguration(conf) }));

const WOOD = () => PRODUCT.axes.find((a) => a.name === 'Wood').options.map((o) => o.label);

/* ──────────────────── el núcleo: lo que de verdad nombra la opción ──────── */

test('el núcleo tira lo que dicen TODAS las opciones del eje', () => {
  // The certification is on every Fredericia oak; the substance noun is on
  // every hide, leading on one side and trailing on the other. Neither tells
  // you which one you are buying.
  assert.deepEqual([...coreTokens('Oak oil, FSC Mix 70%')].sort(), ['oak', 'oil']);
  assert.deepEqual([...coreTokens('Oak Oiled')].sort(), ['oak', 'oil']);
  assert.deepEqual([...coreTokens('Leather, natural')].sort(), ['natural']);
  assert.deepEqual([...coreTokens('Natural Saddle')].sort(), ['natural']);
  // …and the manufacturer's own typo folds like the word it meant.
  assert.deepEqual([...coreTokens('Smoked oak, olied, FSC Mix 70%')].sort(), ['oak', 'oil', 'smoked']);
  assert.deepEqual([...coreTokens('Oak Smoked Oiled')].sort(), ['oak', 'oil', 'smoked']);
});

test('un valor que sea TODO ruido no cruza nada', () => {
  // An empty core must read as "cannot join", never as "matches anything" —
  // which is what an empty-set intersection would silently mean.
  assert.equal(coreTokens('FSC Mix 70%').size, 0);
  assert.equal(matchAxisValue('FSC Mix 70%', WOOD()), null);
  assert.equal(matchAxisValue('', WOOD()), null);
  assert.equal(matchAxisValue('Oak Oiled', []), null);
  assert.equal(matchAxisValue('Oak Oiled', null), null);
});

test('los cinco robles se separan, y ninguno se queda con el del vecino', () => {
  const wood = WOOD();
  const pick = (t) => matchAxisValue(t, wood)?.value;
  assert.equal(pick('Oak Oiled'), 'Oak oil, FSC Mix 70%');
  // The one that has to be right: `Oak Oiled` shares {oak,oil} with BOTH the
  // plain and the light oil, and only the leftover count separates them.
  assert.equal(pick('Oak Light Oiled'), 'Oak light oil, FSC Mix 70%');
  assert.equal(pick('Oak Smoked Oiled'), 'Smoked oak, olied, FSC Mix 70%');
  assert.equal(pick('Oak Soap'), 'Oak soap, FSC Mix 70%');
  assert.equal(pick('Walnut Oiled'), 'Walnut oiled');
  // Every one is an exact core match, not a lucky lean.
  for (const t of ['Oak Oiled', 'Oak Light Oiled', 'Oak Smoked Oiled', 'Oak Soap', 'Walnut Oiled']) {
    assert.equal(matchAxisValue(t, wood).spare, 0, t);
  }
});

test('un empate NO se resuelve tomando el primero', () => {
  // Joining the wrong wood puts a $10,000 walnut price on a $7,315 oak chair,
  // and nobody catches that by reading the quote.
  assert.equal(matchAxisValue('Oak', ['Oak oil', 'Oak soap']), null, 'dos candidatos idénticos');
  // …while an unambiguous one still answers.
  assert.equal(matchAxisValue('Oak oil', ['Oak oil', 'Oak soap']).value, 'Oak oil');
});

/* ────────────────────────────── el plan entero ──────────────────────────── */

test('las doce filas de Anthom cruzan con la página del fabricante', () => {
  const plan = planFredericiaMerge(PRODUCT, ANTHOM);
  assert.equal(plan.summary.matched, 13);
  assert.deepEqual(plan.unmatched, []);
  const row = plan.rows.find((r) => r.reference === 'FRE-2226-NLT-OO');
  // The MANUFACTURER's wording, because it is what parses into named axes.
  assert.equal(row.name, 'The Spanish Chair · Leather, natural · Oak oil, FSC Mix 70%');
  assert.equal(row.family, 'The Spanish Chair');
  assert.equal(row.familyCode, '2226');
  assert.equal(row.category, 'Lounge chairs');
  assert.ok(row.subtype.includes('Børge Mogensen'));
  assert.ok(row.subtype.includes('3-4 weeks'));
});

test('las medidas que la reventa nunca publicó', () => {
  // Anthom's storefront carries not one dimension, so the importer wrote `''`
  // on all ~6,700 references.
  const plan = planFredericiaMerge(PRODUCT, ANTHOM);
  assert.equal(plan.rows[0].dimensions, '82.5 × 60 × 67 cm · asiento 33 cm');
  assert.equal(dimensionLine(null), '');
  assert.equal(dimensionLine({ width: '80' }), '', 'una medida suelta no es una caja');
});

test('el SKU de fábrica sólo donde el fabricante publica esa variante', () => {
  // Fredericia's page carries FIVE stocked variants of the twenty Anthom sells.
  // The other fifteen get no factory SKU — a real fact about what is stocked,
  // written as a blank rather than guessed from a neighbour.
  const plan = planFredericiaMerge(PRODUCT, ANTHOM);
  const withSku = plan.rows.filter((r) => r.supplierSku);
  assert.ok(withSku.length > 0 && withSku.length < plan.rows.length, `${withSku.length}/${plan.rows.length}`);
  const natOak = plan.rows.find((r) => r.reference === 'FRE-2226-NLT-OO');
  assert.equal(natOak.supplierSku, '222620550500');
  for (const r of withSku) assert.match(r.supplierSku, /^\d{10,14}$/);
});

test('TODAS las fotos, y la de ESTA configuración primero', () => {
  // The manufacturer shoots each variant separately — 4 to 8 packshots named
  // for exactly this wood and this hide — and those are what a catalogue row
  // must lead with: the chair somebody is actually buying, not the model's
  // default photograph.
  const plan = planFredericiaMerge(PRODUCT, ANTHOM);
  const smoked = plan.rows.find((r) => r.reference === 'FRE-2226-BLT-OSO');
  assert.match(smoked.imageSrc, /smokedoak_black/, smoked.imageSrc);
  const natOak = plan.rows.find((r) => r.reference === 'FRE-2226-NLT-OO');
  assert.match(natOak.imageSrc, /oak_clear_oil_natural_leather/, natOak.imageSrc);

  // …and the model's whole gallery follows it, all 44.
  assert.ok(natOak.imageSrcs.length > PRODUCT.images.length, `${natOak.imageSrcs.length}`);
  for (const u of natOak.imageSrcs) assert.ok(u.startsWith('https://res.cloudinary.com/'), u);
  assert.equal(natOak.imageSrcs[0], natOak.imageSrc, 'la portada es la primera');
  // One photograph twice in a lightbox is a bug the dealer sees.
  assert.equal(new Set(natOak.imageSrcs).size, natOak.imageSrcs.length, 'sin repetidas');

  // A configuration the manufacturer does not stock still gets the full model
  // gallery rather than nothing.
  const soap = plan.rows.find((r) => r.reference === 'FRE-2226-CLT-OS');
  assert.equal(soap.imageSrcs.length, PRODUCT.images.length);
});

test('los packshots van ANTES que las fotos de ambiente', () => {
  // Cloudinary files the two kinds under different folders, and the order is a
  // decision: a catalogue row wants the product, a page banner wants the room.
  const kinds = PRODUCT.images.map((i) => i.kind);
  assert.ok(kinds.includes('packshot') && kinds.includes('lifestyle'), kinds.join(','));
  assert.equal(kinds.indexOf('lifestyle') > kinds.lastIndexOf('packshot'), true);
});

test('NINGÚN PRECIO sale del merge', () => {
  // This enriches rows the distributor importer already priced. A merge that
  // also carried a price would be a second opinion about money, and the whole
  // reason the sources are split is that only one of them has one.
  const plan = planFredericiaMerge(PRODUCT, ANTHOM);
  for (const r of plan.rows) {
    assert.equal('priceUsd' in r, false);
    assert.equal('price' in r, false);
    assert.equal('cost' in r, false);
  }
});

test('una fila que no cruza se REPORTA con el porqué', () => {
  const plan = planFredericiaMerge(PRODUCT, [
    ...ANTHOM.slice(0, 2),
    { id: 'fre-XX', reference: 'FRE-2226-XX-ZZ', configuration: splitConfiguration('Teak Oiled · Cognac Saddle') },
    { id: 'fre-SOLO', reference: 'FRE-2226-SOLO', configuration: splitConfiguration('Cognac Saddle') },
    { id: 'fre-VACIO', reference: 'FRE-2226-VACIO', configuration: [] },
  ]);
  assert.equal(plan.summary.matched, 2);
  assert.equal(plan.unmatched.length, 3);
  assert.match(plan.unmatched.find((u) => u.reference === 'FRE-2226-XX-ZZ').why, /Teak Oiled/);
  assert.match(plan.unmatched.find((u) => u.reference === 'FRE-2226-SOLO').why, /1 de 2 ejes/);
  assert.match(plan.unmatched.find((u) => u.reference === 'FRE-2226-VACIO').why, /configuración/);
});

test('sobrevive a una página vacía o a filas rotas', () => {
  assert.deepEqual(planFredericiaMerge(null, ANTHOM).rows, []);
  assert.deepEqual(planFredericiaMerge({}, ANTHOM).rows, []);
  assert.deepEqual(planFredericiaMerge(PRODUCT, null).rows, []);
  assert.deepEqual(planFredericiaMerge(PRODUCT, [{ id: 'x', reference: '' }]).rows, []);
  // …y una fila sin id tampoco se escribe: sería un INSERT sin precio.
  assert.deepEqual(planFredericiaMerge(PRODUCT, [{ reference: 'FRE-2226-CLT-OO', configuration: ['Oak Oiled', 'Cognac Saddle'] }]).rows, []);
});
