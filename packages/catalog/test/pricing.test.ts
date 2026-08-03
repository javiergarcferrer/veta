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
  isCompleteElement,
  listPriceOf,
  partFamiliesFrom,
  placementTotal,
  priceItems,
  productForGrade,
  safeMultiplier,
  simpleSku,
  validPricingMode,
} from '../src/index.ts';
import type { CatalogModel, Placement, ResolvedById } from '../src/index.ts';

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

test('priceItems prices by grade, falls back only where nothing was picked, then null', () => {
  const items = [
    { modelId: 'togo-3', material: { grade: 'H' } }, // byGrade.H → 200
    { modelId: 'togo-3', material: { grade: 'B' } }, // OFF a real ladder → unpriceable
    { modelId: 'togo-3' },                           // no material → base 100
    { modelId: 'unknown' },                          // no index entry → null
  ];
  const out = priceItems(items, priceIndex, 1);
  assert.equal(out.items[0].priceUsd, 200);
  // THE FALLBACK THAT WAS A LIE: grade B is not on this model's ladder (G, H),
  // and billing the cheapest rung states a confident number for cloth nobody
  // was ever quoted. A grade only means something inside the ladder that bills
  // it; outside it there is no price to state, only one to invent.
  assert.equal(out.items[1].priceUsd, null);
  // NOT a fallback removal: an item with no pick at all still bills the base —
  // the module ships in its cheapest cloth by convention, which is exactly what
  // the palette has always shown.
  assert.equal(out.items[2].priceUsd, 100);
  assert.equal(out.items[3].priceUsd, null);
  assert.equal(out.totalUsd, 300); // 200 + 100, unknown and off-ladder ignored
});

test('priceItems: a model with fewer than two grades has no ladder to be OFF', () => {
  // `graded` needs two rungs — the same rule `familyFor` applies — so a lone or
  // ungraded SKU keeps pricing any pick exactly as it always has. A catalogue
  // with no ladder data is untouched by the gate above.
  const solo = buildPriceIndex(
    [{ id: 'solo', product_root: '99990000' }],
    [{ reference: '99990000A', price_usd: 500 }],
    idRetail,
  );
  assert.equal(priceItems([{ modelId: 'solo', material: { grade: 'Z' } }], solo, 1).items[0].priceUsd, 500);
  // …and a model with no priced SKU at all still prices null, as before.
  const ghost = buildPriceIndex([{ id: 'ghost', product_root: '00000000' }], priceProducts, idRetail);
  assert.equal(priceItems([{ modelId: 'ghost', material: { grade: 'G' } }], ghost, 1).items[0].priceUsd, null);
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

test('priceItems bills tagged parts at their picked grade, unpicked at the cheapest — when MIXED', () => {
  const products = [
    { reference: '11111111A', price_usd: 1000 },
    { reference: '22222222A', price_usd: 100 },
    { reference: '22222222B', price_usd: 150 },
  ];
  const idx = buildPriceIndex([{
    id: 'm1', product_root: '11111111',
    parts: { mats: { a: 'base', b: 'cushion' }, roots: { cushion: '22222222' }, counts: { cushion: 2 } },
  }], products, idRetail);
  // The componentes bill only when the build is NOT one element — i.e. when a
  // componente wears a different fabric CODE from the piece (the fold below).
  const piece = { grade: 'A', code: 'D1' };
  // Picked → that grade.
  assert.equal(
    priceItems([{ modelId: 'm1', material: piece, partMaterials: { cushion: { grade: 'B', code: 'S2' } } }], idx, 1)
      .items[0].priceUsd,
    1000 + 2 * 150,
  );
  // Divergent but unpicked-grade → the family's cheapest: the module ships with
  // the cushions either way.
  assert.equal(
    priceItems([{ modelId: 'm1', material: piece, partMaterials: { cushion: { code: 'S2' } } }], idx, 1)
      .items[0].priceUsd,
    1000 + 2 * 100,
  );
});

/* --------------- EL ELEMENTO COMPLETO (the monocolor fold) --------------- */
/*                                                                          */
/* A build whose componentes all ride the piece's own cloth IS one element,  */
/* so it bills the model's whole SKU ALONE and the componentes are           */
/* "incluido"; any componente in a different fabric bills base + each         */
/* componente (dearer). The stored-item pricer was the ONE layer that never  */
/* applied it: a uniform settee the visitor saw at 12,880 listed to the       */
/* dealer at 23,190. Same lead, two prices, and the dearer one is the one a   */
/* dealer quotes from.                                                       */

const PRADO_ROOT = '11370700';                 // the settee's own ladder
const CUSHION_ROOT = '11370012';
const BOLSTER_ROOT = '11370013';
const ARM_ROOT = '11370014';

const foldProducts = [
  { reference: `${PRADO_ROOT}C`, price_usd: 9800 },
  { reference: `${PRADO_ROOT}S`, price_usd: 12880 },   // the microfibra grade
  { reference: `${CUSHION_ROOT}A`, price_usd: 2435 },  // the cheapest — what the pricer billed
  { reference: `${CUSHION_ROOT}S`, price_usd: 3100 },
  { reference: `${BOLSTER_ROOT}A`, price_usd: 575 },
  { reference: `${BOLSTER_ROOT}S`, price_usd: 720 },
  { reference: `${ARM_ROOT}A`, price_usd: 7300 },
  { reference: `${ARM_ROOT}S`, price_usd: 9050 },
];
const foldParts = {
  mats: { seat: 'cushion', roll: 'bolster', arm: 'armCushion' },
  roots: { cushion: CUSHION_ROOT, bolster: BOLSTER_ROOT, armCushion: ARM_ROOT },
  counts: { cushion: 1, bolster: 1, armCushion: 1 },
};
const foldIndex = buildPriceIndex(
  [{ id: 'm-prado', product_root: PRADO_ROOT, parts: foldParts }],
  foldProducts,
  idRetail,
);
// The piece's own cloth, and the SAME cloth on a componente (same code = same
// fabric, whatever the row says about grade).
const ALCANTARA = { grade: 'S', fabric: 'ALCANTARA', code: '4171' };
const STEPPE = { grade: 'A', fabric: 'STEPPE', code: '9' };

test('the monocolor fold: a UNIFORM build bills the whole SKU ALONE, componentes incluidos', () => {
  const item = {
    modelId: 'm-prado',
    material: ALCANTARA,
    // Every componente EXPLICITLY picked in the very same fabric — a pick that
    // matches must price exactly like no pick at all.
    partMaterials: { cushion: ALCANTARA, bolster: ALCANTARA, armCushion: ALCANTARA },
  };
  const out = priceItems([item], foldIndex, 1);
  assert.equal(out.items[0].priceUsd, 12880, 'the whole piece at its own grade S — and nothing else');
  assert.equal(out.totalUsd, 12880);
  assert.notEqual(out.items[0].priceUsd, 12880 + 2435 + 575 + 7300, 'never the 23,190 the pricer used to state');
  // The "incluido" marker (mirror of the breakdown's base line): this one price
  // already bought the componentes.
  assert.equal(out.items[0].complete, true);
  // CODE is the identity, not grade: a componente pick carrying the piece's own
  // fabric code at another grade is still one element.
  const oddGrade = { ...item, partMaterials: { cushion: { grade: 'C', fabric: 'ALCANTARA', code: '4171' } } };
  assert.equal(priceItems([oddGrade], foldIndex, 1).items[0].priceUsd, 12880);
  // The dealer's multiplier still applies to the folded price, last and alone.
  assert.equal(priceItems([item], foldIndex, 1.25).items[0].priceUsd, 16100);
});

test('the monocolor fold: NO picks at all is the default build — it folds too', () => {
  // A componente with no pick of its own rides the piece's cloth BY
  // CONSTRUCTION, so the default build is the monocolor one — precisely the case
  // the cheaper answer exists for.
  const out = priceItems([{ modelId: 'm-prado', material: ALCANTARA }], foldIndex, 1);
  assert.equal(out.items[0].priceUsd, 12880, 'grade S alone; the componentes ride it');
  assert.equal(out.items[0].complete, true);
  // Not even a fabric on the piece: it prices the family's cheapest grade —
  // still ALONE, never plus the componentes.
  const bare = priceItems([{ modelId: 'm-prado' }], foldIndex, 1);
  assert.equal(bare.items[0].priceUsd, 9800);
  assert.equal(bare.items[0].complete, true);
  // A build that picks only SOME componentes, all in the piece's own cloth.
  const partial = priceItems(
    [{ modelId: 'm-prado', material: ALCANTARA, partMaterials: { bolster: ALCANTARA } }], foldIndex, 1,
  );
  assert.equal(partial.items[0].priceUsd, 12880);
});

test('ONE divergent componente ⇒ base + EVERY componente, exactly as before the fold', () => {
  // The dearer path, byte-for-byte what shipped: the piece at its own grade, the
  // picked componente on its own ladder, and the UNPICKED ones at their family's
  // cheapest grade — pinned so changing that convention has to be a deliberate
  // edit rather than a silent drift.
  const mixed = {
    modelId: 'm-prado',
    material: ALCANTARA,                       // whole piece, grade S → 12,880
    partMaterials: { bolster: STEPPE },        // diverges by CODE → bills by parts
  };
  const out = priceItems([mixed], foldIndex, 1);
  //   12,880 whole piece
  // +  2,435 cushion    — unpicked ⇒ its family's CHEAPEST grade (A)
  // +    575 bolster    — picked STEPPE, grade A on its own ladder
  // +  7,300 armCushion — unpicked ⇒ cheapest (A)
  assert.equal(out.items[0].priceUsd, 23190);
  assert.equal(out.totalUsd, 23190);
  assert.equal(out.items[0].complete, undefined, 'a mixed build is not one element — no "incluido" marker');
  assert.ok((out.items[0].priceUsd as number) > 12880, 'mixing materials costs strictly more — the whole point');
  // A componente picked in the piece's own fabric alongside a diverging one does
  // NOT rescue the fold: one divergence is enough.
  const oneOff = { ...mixed, partMaterials: { cushion: ALCANTARA, bolster: STEPPE } };
  assert.equal(priceItems([oneOff], foldIndex, 1).items[0].priceUsd, 12880 + 3100 + 575 + 7300);
});

test('the fold NEVER resurrects an unresolvable build: an off-ladder uniform piece still prices null', () => {
  // The whole-piece gate runs first and its answer STANDS. A grade the model's
  // own ladder never sold has no price to state, monocolor or not — folding to
  // "the cheapest grade, alone" would be the same invented number one axis over.
  const offLadder = { modelId: 'm-prado', material: { grade: 'I', fabric: 'ARDA/FR', code: 'A9' } };
  const out = priceItems([offLadder], foldIndex, 1);
  assert.equal(out.items[0].priceUsd, null, 'the piece’s own ladder sells C and S — never an I');
  assert.equal(out.totalUsd, null);
  assert.equal(out.items[0].complete, undefined, 'nothing was bought, so nothing is "incluido"');
  // …and a componente ladder can no longer make a MONOCOLOR item unpriceable:
  // that SKU is not being sold here, so a grade it never carried is not a gap.
  // (Same answer the placement path gives — `resolveCompleteSku` short-circuits
  // `unresolvedPartRoles` to [].)
  const monoOddPart = {
    modelId: 'm-prado',
    material: ALCANTARA,
    // Same CODE as the piece (still one element), at a grade no cushion ladder
    // carries: it bills nothing either way.
    partMaterials: { cushion: { grade: 'I', fabric: 'ALCANTARA', code: '4171' } },
  };
  assert.equal(priceItems([monoOddPart], foldIndex, 1).items[0].priceUsd, 12880);
  // A DIVERGENT off-ladder part keeps the old gate, unchanged: nothing prices
  // it, so the item prices nothing.
  const mixedOddPart = {
    modelId: 'm-prado',
    material: ALCANTARA,
    partMaterials: { cushion: { grade: 'I', fabric: 'ARDA/FR', code: 'A9' } },
  };
  assert.equal(priceItems([mixedOddPart], foldIndex, 1).items[0].priceUsd, null);
});

test('a model with NO billed componentes is untouched by the fold', () => {
  // It has only ever had one price — there is nothing to fold in and nothing to
  // mark "incluido", so both the number and the item's SHAPE are byte-identical
  // to before the fold existed.
  const out = priceItems([{ modelId: 'togo-3', material: { grade: 'H' } }], priceIndex, 1);
  assert.deepEqual(out.items[0], { modelId: 'togo-3', material: { grade: 'H' }, priceUsd: 200 });
  assert.equal(priceIndex['togo-3'].billedRoles, undefined, 'no componentes ⇒ no billedRoles key at all');
});

test('isCompleteElement: the divergence test itself — by CODE, no pick rides the piece', () => {
  const entry = foldIndex['m-prado'];
  const mat = (over: Record<string, unknown> = {}) => ({ modelId: 'm-prado', material: ALCANTARA, ...over });
  // No pick anywhere ⇒ every componente rides the piece's cloth.
  assert.equal(isCompleteElement(entry, mat()), true);
  // An explicit pick of the same CODE is not a divergence…
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { cushion: { code: '4171' } } })), true);
  // …a different code is, whatever the fabric NAME says.
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { cushion: { code: '9', fabric: 'ALCANTARA' } } })), false);
  // A pick with no code of its own can't diverge (nothing to compare).
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { cushion: { grade: 'C' } } })), true);
  // A piece wearing NO cloth: a componente that names one has diverged from it.
  assert.equal(isCompleteElement(entry, { modelId: 'm-prado' }), true);
  assert.equal(isCompleteElement(entry, { modelId: 'm-prado', partMaterials: { cushion: { code: '9' } } }), false);
  // Zones and structure are not componentes — `partCount` answers 0 for both, so
  // a bicolor zone can no more break the fold here than it can on the placement
  // side.
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { interior: { code: '9' } } })), true);
  // No billed componente / no entry at all ⇒ never "one element".
  assert.equal(isCompleteElement(priceIndex['togo-3'], mat()), false);
  assert.equal(isCompleteElement(null, mat()), false);
  // Junk picks are shape-refused, never coerced into a divergence.
  assert.equal(isCompleteElement(entry, mat({ partMaterials: 'nope' })), true);
  assert.equal(isCompleteElement(entry, mat({ partMaterials: { cushion: 'nope' } })), true);
});

test('billedRoles covers a componente with a count but NO bound SKU — the fold still sees it', () => {
  // `parts` can't answer the monocolor question: buildPriceIndex only files a
  // role there once it has a root to price. A role tagged and counted with no
  // SKU bound yet is still a componente, and a divergent pick on it still pushes
  // the piece onto the dearer path — exactly as on the placement side, where
  // `partFamiliesFrom` keys it with a null family.
  const idx = buildPriceIndex(
    [{
      id: 'm-half',
      product_root: PRADO_ROOT,
      parts: { mats: { seat: 'cushion', roll: 'bolster' }, roots: { cushion: CUSHION_ROOT } },
    }],
    foldProducts,
    idRetail,
  );
  assert.deepEqual(idx['m-half'].billedRoles, ['cushion', 'bolster']);
  assert.deepEqual(Object.keys(idx['m-half'].parts!), ['cushion'], 'only the bound role can bill');
  // Monocolor: the whole SKU alone.
  assert.equal(priceItems([{ modelId: 'm-half', material: ALCANTARA }], idx, 1).items[0].priceUsd, 12880);
  // The UNBOUND role diverges ⇒ by parts: the piece + the bound cushion at its
  // cheapest (the unbound one bills nothing — it has no SKU to bill).
  const mixed = { modelId: 'm-half', material: ALCANTARA, partMaterials: { bolster: STEPPE } };
  assert.equal(priceItems([mixed], idx, 1).items[0].priceUsd, 12880 + 2435);
});

test('PARITY of the fold with the placement path: one fixture, the same two numbers', () => {
  // The stored-item pricer and the live placement are TWO implementations of one
  // law (a saved lead vs a plan on screen), and they must land on the same
  // numbers or a dealer quotes from a price the visitor was never shown.
  const products = [
    { reference: '25420000A', price_usd: 2000 },
    { reference: '25420000C', price_usd: 2600 },
    { reference: '35420000A', price_usd: 150 },
    { reference: '35420000C', price_usd: 210 },
  ];
  const parts = { mats: { cush: 'cushion' }, roots: { cushion: '35420000' }, counts: { cushion: 2 } };
  const idx = buildPriceIndex([{ id: 'm-prado', product_root: '25420000', parts }], products, idRetail);
  // The same catalogue as the placement projection reads it.
  const baseFamily = familyFor('25420000', products)!;
  const cushionFamily = familyFor('35420000', products)!;
  const resolvedById: ResolvedById = {
    'm-prado': {
      unitPrice: 2000,
      reference: '25420000A',
      parts,
      partFamilies: partFamiliesFrom(parts, new Map([['35420000', cushionFamily]])),
      baseFamily,
      completeFamily: null,
    },
  };
  const priceOf = (item: Record<string, unknown>, placement: Placement): [number | null, number | null] => [
    priceItems([item], idx, 1).items[0].priceUsd as number | null,
    placementTotal(placement, resolvedById),
  ];

  // MONOCOLOR — the cushions ride the piece's fabric (no pick of their own).
  // The pick carries the `unitPrice` the picker stamped when it was made: that
  // is what the live base line reads, while the stored pricer re-resolves the
  // grade off its own index. The two roads must arrive at the same number — a
  // stamp that disagrees with the ladder is exactly the drift this pins.
  const material = { grade: 'C', fabric: 'Steppe', code: '9', unitPrice: 2600 };
  const [monoStored, monoLive] = priceOf(
    { modelId: 'm-prado', material },
    { uid: 'u1', pieceId: 'm-prado', material },
  );
  assert.equal(monoStored, 2600, 'the elemento completo');
  assert.equal(monoLive, 2600);
  assert.notEqual(monoStored, 2600 + 2 * 150, 'never base + the cojines at their cheapest');

  // An explicit pick in the SAME fabric is still monocolor.
  const same = { cushion: { grade: 'C', fabric: 'Steppe', code: '9' } };
  assert.deepEqual(
    priceOf(
      { modelId: 'm-prado', material, partMaterials: same },
      { uid: 'u1', pieceId: 'm-prado', material, partMaterials: same },
    ),
    [2600, 2600],
  );

  // MIXED — the cushions in another fabric: base + 2 × 210.
  const other = { cushion: { grade: 'C', fabric: 'Alcantara', code: '4171' } };
  assert.deepEqual(
    priceOf(
      { modelId: 'm-prado', material, partMaterials: other },
      { uid: 'u1', pieceId: 'm-prado', material, partMaterials: other },
    ),
    [3020, 3020],
  );

  // No material at all: the cheapest grade, as ONE elemento completo.
  assert.deepEqual(priceOf({ modelId: 'm-prado' }, { uid: 'u1', pieceId: 'm-prado' }), [2000, 2000]);
});
