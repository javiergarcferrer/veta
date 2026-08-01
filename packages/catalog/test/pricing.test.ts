/**
 * Catalogue pricing — the money rules ported from the reference app's
 * `togo-embed/dealer.ts`, with the reference's own cases
 * (`tests/togoDealer.test.js`) carried over.
 *
 * What is pinned here: the cheapest priced SKU under a root IS the quoted base;
 * a family's grades sort by PRICE, never alphabetically; per-dealer pricing
 * scales a SHARED catalogue WITHOUT mutating it (the reference's non-mutation
 * test — a mutation would leak one dealer's markup into the next response); the
 * pricing-mode lever decides how much price ever reaches a browser; and a bad
 * multiplier is identity, never zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDealerPricing,
  applyPricingMode,
  baseProductFor,
  buildPriceIndex,
  clampPct,
  familyFor,
  listPriceOf,
  priceItems,
  productForGrade,
  safeMultiplier,
  simpleSku,
  validPricingMode,
} from '../src/index.ts';
import type { CatalogModel } from '../src/index.ts';

/* --------------------------- baseProductFor / familyFor --------------------------- */

// A graded root '15420000' with two priced SKUs (grade G cheapest = the base).
const priceProducts = [
  { reference: '15420000G', name: 'Togo Fireside', price_usd: 100 },
  { reference: '15420000H', name: 'Togo Fireside', price_usd: 200 },
];

test('baseProductFor picks the CHEAPEST SKU under the root — the quoted base', () => {
  assert.equal(baseProductFor('15420000', priceProducts)!.reference, '15420000G');
  // Order in the list must not decide it.
  assert.equal(baseProductFor('15420000', [...priceProducts].reverse())!.reference, '15420000G');
});

test('baseProductFor is null-safe: no root, no products, no match', () => {
  assert.equal(baseProductFor(null, priceProducts), null);
  assert.equal(baseProductFor('', priceProducts), null);
  assert.equal(baseProductFor('15420000', null), null);
  assert.equal(baseProductFor('99999999', priceProducts), null);
});

test('familyFor sorts grades by PRICE ascending, never alphabetically', () => {
  // Grade B is DEARER than C here — a letter sort would put the wrong grade
  // first and quote every "desde" price at the wrong number.
  const fam = familyFor('15420000', [
    { reference: '15420000B', name: 'Togo', price_usd: 400 },
    { reference: '15420000C', name: 'Togo', price_usd: 300 },
    { reference: '15420000A', name: 'Togo', price_usd: 100 },
  ])!;
  assert.deepEqual(fam.grades, ['A', 'C', 'B']);
  assert.equal(fam.graded, true);
  assert.equal(fam.name, 'Togo');
  assert.equal(fam.byGrade.C.reference, '15420000C');
});

test('familyFor applies the retail margin to every grade', () => {
  const withMargin = (n: number) => Math.round(n * 1.2 * 100) / 100;
  const fam = familyFor('15420000', priceProducts, withMargin)!;
  assert.equal(fam.byGrade.G.priceUsd, 120);
  assert.equal(fam.byGrade.H.priceUsd, 240);
});

test('familyFor: a LONE SKU is a standalone product, not a graded model', () => {
  const fam = familyFor('33333333', [{ reference: '33333333A', name: 'Bolster', price_usd: 50 }])!;
  assert.equal(fam.graded, false);
  assert.deepEqual(fam.grades, ['A']);
  // …and productForGrade hands back that sole member whatever grade is asked.
  assert.equal(productForGrade(fam, 'Q')!.priceUsd, 50);
  assert.equal(productForGrade(fam, '')!.reference, '33333333A');
});

test('familyFor ignores rows whose reference is not a graded variant of the root', () => {
  const fam = familyFor('15420000', [
    ...priceProducts,
    { reference: '15420000', name: 'bare root', price_usd: 1 },   // no grade
    { reference: '15420000T', name: 'off-ladder', price_usd: 1 }, // T is not a grade
    { reference: '99999999A', name: 'other model', price_usd: 1 },
  ])!;
  assert.deepEqual(fam.grades, ['G', 'H']);
  assert.equal(familyFor('15420000', [{ reference: '15420000', price_usd: 1 }]), null);
});

test('familyFor under simpleSku forms a family of one at the empty tier', () => {
  const fam = familyFor('WIDGET-7', [{ reference: 'WIDGET-7', name: 'Widget', price_usd: 42 }], undefined, simpleSku)!;
  assert.deepEqual(fam.grades, ['']);
  assert.equal(fam.graded, false);
  assert.equal(productForGrade(fam, 'anything')!.priceUsd, 42);
});

test('listPriceOf reads either spelling, and never yields NaN', () => {
  assert.equal(listPriceOf({ priceUsd: 12.5 }), 12.5);
  assert.equal(listPriceOf({ price_usd: '99.99' }), 99.99);
  assert.equal(listPriceOf({ priceUsd: null, price_usd: 7 }), 7);
  assert.equal(listPriceOf({}), 0);
  assert.equal(listPriceOf(null), 0);
});

/* ------------------------------ applyDealerPricing ------------------------------ */

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'togo-3',
  name: 'Togo Fireside Chair',
  priceUsd: 100,
  family: {
    root: '15420000',
    name: 'Togo',
    graded: true,
    grades: ['G', 'H'],
    byGrade: {
      G: { priceUsd: 100, reference: '15420000G' },
      H: { priceUsd: 200, reference: '15420000H' },
    },
  },
  ...over,
});

const gradePrice = (m: CatalogModel, g: string): unknown => m.family?.byGrade?.[g]?.priceUsd;

test('applyDealerPricing scales priceUsd and every byGrade price, rounded to 2dp', () => {
  const out = applyDealerPricing(model(), 1.15);
  assert.equal(out.priceUsd, 115);
  assert.equal(gradePrice(out, 'G'), 115);
  assert.equal(gradePrice(out, 'H'), 230);
  // reference (and every other byGrade field) rides through untouched.
  assert.equal(out.family?.byGrade?.G.reference, '15420000G');
  assert.equal(out.family?.byGrade?.H.reference, '15420000H');
});

test('applyDealerPricing rounds to 2 decimals', () => {
  const out = applyDealerPricing(model({ priceUsd: 99.99, family: null }), 1.1);
  assert.equal(out.priceUsd, 109.99); // 99.99 * 1.1 = 109.989 → 109.99
});

test('applyDealerPricing treats a bad multiplier as 1 (identity)', () => {
  for (const bad of [0, -2, NaN, Infinity, -Infinity, 'x', null, undefined]) {
    const out = applyDealerPricing(model(), bad);
    assert.equal(out.priceUsd, 100, `multiplier ${String(bad)} should be identity`);
    assert.equal(gradePrice(out, 'G'), 100);
    assert.equal(gradePrice(out, 'H'), 200);
  }
});

test('applyDealerPricing does NOT mutate the input model or its family', () => {
  const input = model();
  const snapshot = JSON.parse(JSON.stringify(input));
  applyDealerPricing(input, 2);
  assert.deepEqual(input, snapshot);
});

test('applyDealerPricing keeps a null priceUsd null and a null family null', () => {
  const out = applyDealerPricing(model({ priceUsd: null, family: null }), 2);
  assert.equal(out.priceUsd, null);
  assert.equal(out.family, null);
});

test('applyDealerPricing scales the PART families exactly like the base', () => {
  const withParts = model({
    partFamilies: {
      cushion: { byGrade: { A: { priceUsd: 100, reference: '22222222A' } } },
      bolster: null,
    },
  });
  const out = applyDealerPricing(withParts, 1.5);
  assert.equal(out.partFamilies!.cushion!.byGrade!.A.priceUsd, 150);
  assert.equal(out.partFamilies!.bolster, null);
  // …and still without mutating the shared catalogue row.
  assert.equal(withParts.partFamilies!.cushion!.byGrade!.A.priceUsd, 100);
});

/* ------------------------------- applyPricingMode ------------------------------- */

test("applyPricingMode 'full' leaves priceUsd and family intact", () => {
  const out = applyPricingMode(model(), 'full');
  assert.equal(out.priceUsd, 100);
  assert.equal(gradePrice(out, 'H'), 200);
});

test("applyPricingMode 'from' keeps priceUsd but nulls family (no client repricing)", () => {
  const out = applyPricingMode(model(), 'from');
  assert.equal(out.priceUsd, 100);
  assert.equal(out.family, null);
  assert.equal(out.partFamilies, null);
});

test("applyPricingMode 'hidden' nulls BOTH priceUsd and family", () => {
  const out = applyPricingMode(model(), 'hidden');
  assert.equal(out.priceUsd, null);
  assert.equal(out.family, null);
  assert.equal(out.partFamilies, null);
});

test('applyPricingMode falls back to full for an invalid mode', () => {
  const out = applyPricingMode(model(), 'bogus');
  assert.equal(out.priceUsd, 100);
  assert.equal(gradePrice(out, 'H'), 200);
  assert.equal(validPricingMode('bogus'), 'full');
  assert.equal(validPricingMode(null), 'full');
  assert.equal(validPricingMode('from'), 'from');
  assert.equal(validPricingMode('hidden'), 'hidden');
});

test('applyPricingMode does NOT mutate the input model', () => {
  const input = model();
  const snapshot = JSON.parse(JSON.stringify(input));
  applyPricingMode(input, 'hidden');
  applyPricingMode(input, 'from');
  assert.deepEqual(input, snapshot);
});

test('applyDealerPricing then applyPricingMode compose (the payload pipeline)', () => {
  const priced = applyDealerPricing(model(), 1.5);
  const fromOut = applyPricingMode(priced, 'from');
  assert.equal(fromOut.priceUsd, 150);
  assert.equal(fromOut.family, null);
  const hiddenOut = applyPricingMode(priced, 'hidden');
  assert.equal(hiddenOut.priceUsd, null);
  assert.equal(hiddenOut.family, null);
});

/* ------------------------------ safeMultiplier / clampPct ------------------------------ */

test('safeMultiplier: only a finite POSITIVE number survives — identity otherwise', () => {
  assert.equal(safeMultiplier(1.25), 1.25);
  assert.equal(safeMultiplier('2'), 2);
  for (const bad of [0, -1, NaN, Infinity, 'x', null, undefined, {}]) {
    assert.equal(safeMultiplier(bad), 1, `multiplier ${String(bad)} should be identity`);
  }
});

test('clampPct floors at 0 and ceils at the max (500 by default, a MARGIN)', () => {
  assert.equal(clampPct(40), 40);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(900), 500);
  assert.equal(clampPct('12.5'), 12.5);
  assert.equal(clampPct(NaN), 0);
  assert.equal(clampPct(null), 0);
  // A DISCOUNT field must ask for the 100 ceiling explicitly.
  assert.equal(clampPct(140, 100), 100);
});

/* -------------------------------- buildPriceIndex -------------------------------- */

// Identity margin — keeps the retail step transparent so the assertions read
// the raw list prices; the margin fn is exercised separately.
const idRetail = (n: number) => n;
const priceModels = [{ id: 'togo-3', product_root: '15420000' }];

test('buildPriceIndex distills base (cheapest SKU) + per-grade retail prices per model id', () => {
  const idx = buildPriceIndex(priceModels, priceProducts, idRetail);
  assert.deepEqual(idx['togo-3'], { baseUsd: 100, byGrade: { G: 100, H: 200 } });
});

test('buildPriceIndex applies the retail margin fn to base and every grade', () => {
  const withMargin = (n: number) => Math.round(n * 1.2 * 100) / 100;
  const idx = buildPriceIndex(priceModels, priceProducts, withMargin);
  assert.deepEqual(idx['togo-3'], { baseUsd: 120, byGrade: { G: 120, H: 240 } });
});

test('buildPriceIndex yields base null + empty byGrade for a model with no priced SKUs', () => {
  const idx = buildPriceIndex([{ id: 'ghost', product_root: '99999999' }], priceProducts, idRetail);
  assert.deepEqual(idx['ghost'], { baseUsd: null, byGrade: {} });
});

test('buildPriceIndex skips a model with no id, and reads either root spelling', () => {
  assert.deepEqual(buildPriceIndex([{ product_root: '15420000' }], priceProducts, idRetail), {});
  const camel = buildPriceIndex([{ id: 'togo-3', productRoot: '15420000' }], priceProducts, idRetail);
  assert.equal(camel['togo-3'].baseUsd, 100);
});

test('buildPriceIndex prices a model’s BILLED parts alongside — and only those', () => {
  const products = [
    { reference: '11111111A', name: 'Settee', price_usd: 1000 },
    { reference: '22222222A', name: 'Cushion set', price_usd: 100 },
    { reference: '22222222B', name: 'Cushion set', price_usd: 150 },
  ];
  const idx = buildPriceIndex([{
    id: 'm1',
    product_root: '11111111',
    parts: {
      mats: { a: 'base', b: 'cushion', legs: 'structure', body: 'exterior' },
      // A stray root on a NEVER-BILLS role rides along: it must not price.
      roots: { cushion: '22222222', structure: '11111111', exterior: '11111111' },
      counts: { structure: 4 },
    },
  }], products, idRetail);
  assert.deepEqual(Object.keys(idx['m1'].parts!), ['cushion']);
  assert.deepEqual(idx['m1'].parts!.cushion, { count: 1, baseUsd: 100, byGrade: { A: 100, B: 150 } });
});

/* ---------------------------------- priceItems ---------------------------------- */

const priceIndex = buildPriceIndex(priceModels, priceProducts, idRetail);

test('priceItems prices by grade, falls back to the base price, then null', () => {
  const items = [
    { modelId: 'togo-3', material: { grade: 'H' } }, // byGrade.H → 200
    { modelId: 'togo-3', material: { grade: 'B' } }, // grade absent → base 100
    { modelId: 'togo-3' },                           // no material → base 100
    { modelId: 'unknown' },                          // no index entry → null
  ];
  const out = priceItems(items, priceIndex, 1);
  assert.equal(out.items[0].priceUsd, 200);
  assert.equal(out.items[1].priceUsd, 100);
  assert.equal(out.items[2].priceUsd, 100);
  assert.equal(out.items[3].priceUsd, null);
  assert.equal(out.totalUsd, 400); // 200 + 100 + 100, unknown ignored
});

test('priceItems matches a lowercase stored grade against the uppercase family keys', () => {
  const out = priceItems([{ modelId: 'togo-3', material: { grade: 'h' } }], priceIndex, 1);
  assert.equal(out.items[0].priceUsd, 200);
});

test('priceItems multiplies by the dealer multiplier and rounds each price to 2dp', () => {
  assert.equal(priceItems([{ modelId: 'togo-3', material: { grade: 'H' } }], priceIndex, 1.15).items[0].priceUsd, 230);
  const idx = buildPriceIndex(
    [{ id: 'm', product_root: '30000000' }],
    [{ reference: '30000000A', price_usd: 99.99 }],
    idRetail,
  );
  assert.equal(priceItems([{ modelId: 'm' }], idx, 1.1).items[0].priceUsd, 109.99);
});

test('priceItems treats a bad multiplier as identity', () => {
  const items = [{ modelId: 'togo-3', material: { grade: 'H' } }];
  for (const bad of [0, -1, NaN, Infinity, 'x', null, undefined]) {
    assert.equal(priceItems(items, priceIndex, bad).items[0].priceUsd, 200, `multiplier ${String(bad)}`);
  }
});

test('priceItems is null-safe: empty/non-array items, unknown model, junk item', () => {
  assert.deepEqual(priceItems([], priceIndex, 1), { items: [], totalUsd: null });
  assert.deepEqual(priceItems(null, priceIndex, 1), { items: [], totalUsd: null });
  const out = priceItems([{ modelId: 'nope' }, null, 42], priceIndex, 1);
  assert.equal(out.items[0].priceUsd, null);
  assert.equal(out.items[1].priceUsd, null);
  assert.equal(out.items[2].priceUsd, null);
  assert.equal(out.totalUsd, null); // nothing priced ⇒ null, never a fake 0
});

test('priceItems carries priceUsd through, preserving every field of the item', () => {
  const out = priceItems(
    [{ modelId: 'togo-3', x: 3, y: 4, rot: 90, material: { grade: 'H', fabric: 'Alcantara' } }],
    priceIndex,
    1,
  );
  assert.deepEqual(out.items[0], {
    modelId: 'togo-3', x: 3, y: 4, rot: 90,
    material: { grade: 'H', fabric: 'Alcantara' }, priceUsd: 200,
  });
});

test('priceItems: a ZONE pick re-grades the base SKU (dearest wins) and adds no line', () => {
  const idx = buildPriceIndex(
    [{ id: 'ott', product_root: '11370200', parts: { mats: { body: 'exterior', plinth: 'interior' } } }],
    [
      { reference: '11370200A', price_usd: 3145 },
      { reference: '11370200C', price_usd: 3460 },
      { reference: '11370200F', price_usd: 3785 },
    ],
    idRetail,
  );
  assert.equal(idx['ott'].parts, undefined, 'a zone binds no billed part');
  const bicolor = [{ modelId: 'ott', material: { grade: 'A' }, partMaterials: { interior: { grade: 'F' } } }];
  assert.equal(priceItems(bicolor, idx, 1).items[0].priceUsd, 3785);
  // A dearer BASE pick beats a cheaper zone — max, not last-write.
  const baseWins = [{ modelId: 'ott', material: { grade: 'C' }, partMaterials: { interior: { grade: 'A' } } }];
  assert.equal(priceItems(baseWins, idx, 1).items[0].priceUsd, 3460);
});

test('priceItems bills tagged parts at their picked grade, unpicked at the cheapest', () => {
  const products = [
    { reference: '11111111A', price_usd: 1000 },
    { reference: '22222222A', price_usd: 100 },
    { reference: '22222222B', price_usd: 150 },
  ];
  const idx = buildPriceIndex([{
    id: 'm1', product_root: '11111111',
    parts: { mats: { a: 'base', b: 'cushion' }, roots: { cushion: '22222222' }, counts: { cushion: 2 } },
  }], products, idRetail);
  // Unpicked → the family's cheapest grade: the module ships with the cushions.
  assert.equal(priceItems([{ modelId: 'm1' }], idx, 1).items[0].priceUsd, 1000 + 2 * 100);
  // Picked → that grade.
  assert.equal(
    priceItems([{ modelId: 'm1', partMaterials: { cushion: { grade: 'B' } } }], idx, 1).items[0].priceUsd,
    1000 + 2 * 150,
  );
});
