/**
 * Placement pricing — the money half of the reference configurator, ported with
 * its own cases from `tests/togoConfigurator.test.js` and the pricing fixtures
 * of `tests/togoQuote.test.js`.
 *
 * The load-bearing invariants, in the order they can hurt:
 *   • ELEMENTO COMPLETO — a monocolor build IS one element and bills on the
 *     model's own SKU alone; mixing fabrics bills by parts and costs strictly
 *     more. Which applies is the CUSTOMER's doing, resolved at placement time.
 *   • MATERIALIZATION ZONES — a bicolor pick re-grades the ONE base SKU
 *     (dearest wins, MAX not last-write) and never adds a billed line.
 *   • ESTRUCTURA IS INVISIBLE TO MONEY — a tagged metal part prices identically
 *     to an untagged one, even carrying a stray SKU root and a typed count.
 *   • THE COUNT CEILING — a fat-fingered «se cobra ×» falls BACK to the one set
 *     SKU the tagging implies; it never saturates and never multiplies.
 *   • `placementBreakdown` FOOTS to `placementTotal` — same math, itemized. A
 *     Resumen that doesn't add up to the tile price is a quote nobody can
 *     explain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { PartsMap } from '@veta/materials';
import {
  compoundSubtotal,
  familyFor,
  firstWithoutFabric,
  isPricedComponent,
  lr8DigitGrade,
  materializedBase,
  offeredMaterials,
  partFamiliesFrom,
  partPricesFor,
  piecePartsTotal,
  placementBreakdown,
  placementTotal,
  productForGrade,
  resolveCompleteSku,
  splitSkuOrRoot,
  unresolvedPartRoles,
  unresolvedWholePiece,
} from '../src/index.ts';
import type { Placement, PriceFamily, ResolvedById } from '../src/index.ts';

/* ------------------------------- the fixture rig ------------------------------- */
// The palette projection, reduced to its PRICING half: a model + the catalogue
// becomes the resolved piece the placement helpers read. (The reference builds
// this inside `resolveTogoModels`, which also carries geometry/mesh/collection
// concerns this package deliberately doesn't own.)

type ProductRow = { reference: string; name?: string; priceUsd?: number };
type ModelRow = { id: string; productRoot?: string | null; parts?: PartsMap | null };

function familiesOf(products: readonly ProductRow[]): Map<string, PriceFamily> {
  const map = new Map<string, PriceFamily>();
  for (const p of products) {
    const { root } = splitSkuOrRoot(lr8DigitGrade, p.reference);
    if (map.has(root)) continue;
    const fam = familyFor(root, products);
    if (fam) map.set(root, fam);
  }
  return map;
}

function resolveModels(models: readonly ModelRow[], products: readonly ProductRow[]): ResolvedById {
  const families = familiesOf(products);
  const out: ResolvedById = {};
  for (const m of models) {
    const fam = (m.productRoot ? families.get(m.productRoot) : null) || null;
    let unitPrice: number | null = null;
    let reference = '';
    if (fam) {
      // A bound model's sticker price is its CHEAPEST grade — the quoted base.
      const p = productForGrade(fam, fam.graded ? fam.grades[0] : '');
      if (p) { unitPrice = Number(p.priceUsd) || 0; reference = p.reference || ''; }
    }
    out[m.id] = {
      unitPrice,
      reference,
      parts: m.parts || null,
      partFamilies: partFamiliesFrom(m.parts || null, families),
      baseFamily: fam,
      completeFamily: null,
    };
  }
  return out;
}

/* ------------------------------- per-part SKUs ------------------------------- */

test('per-part SKUs: a monocolor build is ONE element, a mixed one bills by parts', () => {
  const products: ProductRow[] = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '11111111B', name: 'Prado settee', priceUsd: 1200 },
    { reference: '22222222A', name: 'Prado back cushion', priceUsd: 100 },
    { reference: '22222222B', name: 'Prado back cushion', priceUsd: 150 },
    { reference: '33333333A', name: 'Prado bolster', priceUsd: 50 },
  ];
  const models: ModelRow[] = [{
    id: 'm1',
    productRoot: '11111111',
    parts: {
      mats: { matA: 'base', matB: 'cushion', matC: 'cushion', matD: 'bolster' },
      roots: { cushion: '22222222', bolster: '33333333' },
    },
  }];
  const resolvedById = resolveModels(models, products);
  const r = resolvedById.m1!;
  assert.equal(r.unitPrice, 1000, 'base sticker stays base-only (cheapest grade)');
  assert.ok(r.partFamilies!.cushion && r.partFamilies!.bolster, 'part roots resolve to their own families');

  // SET SEMANTICS: the bound cushion SKU is the SET matching the module, so the
  // two physical cushions bill ONE set SKU — when they bill at all.
  //
  // NOTHING PICKED is the ELEMENTO COMPLETO case: every componente rides the
  // base fabric, so the piece is one element and prices on the model's own SKU
  // ALONE (1000). The componentes are included, not summed.
  const p: Placement = { uid: 'u1', pieceId: 'm1' };
  assert.equal(placementTotal(p, resolvedById), 1000);

  // A cushion picked in its OWN fabric breaks monocolor, so the piece goes back
  // to being sold by parts: 1000 + 150 (cushion set at grade B) + 50 (bolster).
  const picked: Placement = { ...p, partMaterials: { cushion: { grade: 'B', fabric: 'Divina', code: 'X1' } } };
  assert.equal(placementTotal(picked, resolvedById), 1200);
  assert.ok(placementTotal(picked, resolvedById)! > placementTotal(p, resolvedById)!,
    'mixing materials costs more than matching them');

  // No set in the catalogue → the dealer overrides: 2 × the single-cushion SKU.
  const twoSingles = resolveModels(
    [{ ...models[0], id: 'm3', parts: { ...models[0].parts, counts: { cushion: 2 } } }],
    products,
  );
  const two: Placement = { uid: 'u3', pieceId: 'm3' };
  assert.equal(placementTotal(two, twoSingles), 1000, 'unpicked ⇒ still one element, still the base SKU');
  assert.equal(
    placementTotal({ ...two, partMaterials: { cushion: { grade: 'A', fabric: 'Hallingdal', code: 'X9' } } }, twoSingles),
    1250, // 1000 + 2×100 + 50
  );

  // An UNBOUND part role adds no phantom $0 line.
  const unbound = resolveModels([{ id: 'm2', productRoot: '11111111', parts: { mats: { matB: 'cushion' }, roots: {} } }], products);
  assert.equal(unbound.m2!.partFamilies!.cushion, null);
  assert.equal(placementBreakdown({ uid: 'u2', pieceId: 'm2' }, unbound).lines.length, 1, 'unbound part → base line only');
});

test('elemento completo: judged by fabric CODE, and only when there are billed componentes', () => {
  const products: ProductRow[] = [
    { reference: '25420000A', name: 'Prado Settee', priceUsd: 2000 },
    { reference: '25420000C', name: 'Prado Settee', priceUsd: 2600 },
    { reference: '35420000A', name: 'Juego 2 Cojines', priceUsd: 150 },
    { reference: '35420000C', name: 'Juego 2 Cojines', priceUsd: 210 },
    { reference: '15420000A', name: 'Togo Fireside', priceUsd: 1000 },
    { reference: '15420000C', name: 'Togo Fireside', priceUsd: 1400 },
  ];
  const resolvedById = resolveModels([
    { id: 'm-prado', productRoot: '25420000', parts: { mats: { cushmat: 'cushion' }, roots: { cushion: '35420000' }, counts: { cushion: 2 } } },
    { id: 'm-togo', productRoot: '15420000', parts: null },
  ], products);
  const material = { grade: 'C', fabric: 'Steppe', code: '9', unitPrice: 2600 };

  // ONE material everywhere (the cushions ride the base fabric — no pick of
  // their own, the DEFAULT build and exactly what this is for).
  const mono: Placement = { uid: 'a', pieceId: 'm-prado', material };
  assert.equal(placementTotal(mono, resolvedById), 2600);
  assert.equal(resolveCompleteSku(
    { ...resolvedById['m-prado'], ...material }, mono,
  )!.reference, '25420000C', 'the model’s OWN base SKU at the picked grade');
  // The identical default build used to quote base + the cushions at the
  // family's CHEAPEST grade. Monocolor is ONE element — base ALONE.
  assert.ok(placementTotal(mono, resolvedById)! < 2600 + 2 * 150, 'base ALONE, not base + componentes');

  // The cushions in ANOTHER fabric ⇒ the piece is no longer one element.
  const mixed: Placement = { ...mono, partMaterials: { cushion: { grade: 'C', fabric: 'Alcantara', code: '4171' } } };
  assert.equal(placementTotal(mixed, resolvedById), 2600 + 2 * 210, 'by parts: the base plus each componente');
  assert.ok(placementTotal(mixed, resolvedById)! > placementTotal(mono, resolvedById)!,
    'mixing materials costs strictly more — the whole point');

  // A componente picked in the SAME fabric as the base is STILL monocolor: an
  // explicit pick that happens to match must price like no pick at all.
  const same: Placement = { ...mono, partMaterials: { cushion: { grade: 'C', fabric: 'Steppe', code: '9' } } };
  assert.equal(placementTotal(same, resolvedById), 2600);

  // A model with NO billed componentes is untouched by any of this.
  const bare: Placement = { uid: 'b', pieceId: 'm-togo', material: { grade: 'C', fabric: 'Steppe', code: '9', unitPrice: 1400 } };
  assert.equal(resolveCompleteSku({ ...resolvedById['m-togo'] }, bare), null, 'nothing to fold in ⇒ no complete ladder');
  assert.equal(placementTotal(bare, resolvedById), 1400);
});

test('the count CEILING: a fat-fingered «se cobra ×» falls back, never multiplies', () => {
  // The studio's typed count is the one dealer-entered number that rides into a
  // quote as a QUANTITY: 100000 billed the cushion SKU 100000 times (a measured
  // $30M on an ordinary bicolor build), on a path that WhatsApps the result to
  // the client with nobody reading it first. The ceiling lives in
  // @veta/materials (`COUNT_MAX`) and is never restated here.
  const products: ProductRow[] = [
    { reference: '25420000A', name: 'Prado Settee', priceUsd: 2000 },
    { reference: '25420000C', name: 'Prado Settee', priceUsd: 2600 },
    { reference: '35420000A', name: 'Juego 2 Cojines', priceUsd: 150 },
    { reference: '35420000C', name: 'Juego 2 Cojines', priceUsd: 210 },
  ];
  const sane: PartsMap = { mats: { cushmat: 'cushion' }, roots: { cushion: '35420000' }, counts: { cushion: 2 } };
  const poison: PartsMap = { ...sane, counts: { cushion: 100000 } };
  const lead: Placement = {
    uid: 'u1', pieceId: 'm-prado',
    material: { grade: 'C', fabric: 'Steppe', code: '9', unitPrice: 2600 },
    partMaterials: { cushion: { grade: 'C', fabric: 'Alcantara', code: '4171' } },
  };

  const poisoned = resolveModels([{ id: 'm-prado', productRoot: '25420000', parts: poison }], products);
  const { lines, totalUsd } = placementBreakdown(lead, poisoned);
  assert.equal(lines[1].qty, 1, 'falls back to the one set SKU — never 100000, never a saturated 20');
  assert.equal(totalUsd, 2600 + 210, 'base + ONE cushion set');
  assert.ok(totalUsd! < 10_000, 'a quote, not a catastrophe');

  // An IN-RANGE count still means exactly what it says (the ordinary juego de 2).
  const ok = resolveModels([{ id: 'm-prado', productRoot: '25420000', parts: sane }], products);
  assert.equal(placementTotal(lead, ok), 2600 + 2 * 210);
});

/* ------------------------------ estructura ------------------------------ */

test('estructura: a tagged metal part is INVISIBLE to money — same price, same lines', () => {
  // «Estructura» (patas, marcos, bases en acero o lacado negro) is a real
  // client-facing choice that must never move a quote. The pin is a DIFFERENCE
  // test: the same settee, tagged and untagged, must price identically —
  // anything else means the tag leaked into the money.
  const products: ProductRow[] = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '11111111C', name: 'Prado settee', priceUsd: 1400 },
    { reference: '22222222A', name: 'Prado back cushion', priceUsd: 100 },
    { reference: '22222222C', name: 'Prado back cushion', priceUsd: 150 },
  ];
  const mats = { matA: 'base', matB: 'cushion' };
  const roots = { cushion: '22222222' };
  const resolvedById = resolveModels([
    { id: 'plain', productRoot: '11111111', parts: { mats, roots } },
    {
      id: 'legs',
      productRoot: '11111111',
      parts: {
        mats: { ...mats, legs: 'structure' },
        // A stray root and a typed count ride along: neither may charge.
        roots: { ...roots, structure: '11111111' },
        counts: { structure: 4 },
        labels: { legs: 'Patas' },
      },
    },
  ], products);

  assert.deepEqual(Object.keys(resolvedById.legs!.partFamilies!), ['cushion'], 'a structure binds no family');
  assert.deepEqual(resolvedById.legs!.partFamilies, resolvedById.plain!.partFamilies);

  const material = { grade: 'A', fabric: 'Divina', code: 'D1', unitPrice: 1000 };
  for (const partMaterials of [
    null,                                                         // monocolor → the elemento completo (1000)
    { cushion: { grade: 'C', fabric: 'Steelcut', code: 'S2' } },  // mixed → by parts (1000 + 150)
  ]) {
    const label = partMaterials ? 'mixed' : 'monocolor';
    const plain: Placement = { uid: 'a', pieceId: 'plain', material, ...(partMaterials ? { partMaterials } : {}) };
    const legs: Placement = { ...plain, uid: 'b', pieceId: 'legs' };
    assert.equal(placementTotal(legs, resolvedById), placementTotal(plain, resolvedById), `total (${label})`);
    assert.equal(placementTotal(plain, resolvedById), partMaterials ? 1150 : 1000, `the real price (${label})`);
    assert.deepEqual(
      placementBreakdown(legs, resolvedById).lines,
      placementBreakdown(plain, resolvedById).lines,
      `lines (${label})`,
    );
  }
});

/* ------------------ NO-VANISH: a pick nothing can price ------------------ */
// Reproduced from the reference catalogue: a Large Square Settee whose cushions
// were dressed in a Grade I cloth. The cushion family 11370012 offers A and C
// and no I, so `partPricesFor` answered null — the SAME null it answers for an
// UNBOUND family — and every consumer read it as "this role doesn't bill". The
// cushion line left the sheet and the piece totalled 10,895 + 575 + 7,300 =
// 18,770 for a build that is 26,070: the visitor was quoted a settee whose
// cushions nobody had priced, CHEAPER than the monocolor version it is supposed
// to be dearer than.

const NOVANISH_PRODUCTS: ProductRow[] = [
  { reference: '11370000A', name: 'Large Square Settee', priceUsd: 10895 },
  { reference: '11370000C', name: 'Large Square Settee', priceUsd: 12000 },
  // The cushion ladder — A and C, and no I. THIS is the whole bug.
  { reference: '11370012A', name: 'Juego de cojines', priceUsd: 6000 },
  { reference: '11370012C', name: 'Juego de cojines', priceUsd: 7300 },
  { reference: '11370013A', name: 'Rulo', priceUsd: 575 },
  { reference: '11370013C', name: 'Rulo', priceUsd: 700 },
  { reference: '11370014A', name: 'Cojín de brazo', priceUsd: 7300 },
  { reference: '11370014C', name: 'Cojín de brazo', priceUsd: 8000 },
];
const NOVANISH_MODELS: ModelRow[] = [{
  id: 'settee',
  productRoot: '11370000',
  parts: {
    mats: { body: 'base', cush: 'cushion', roll: 'bolster', arm: 'armCushion' },
    roots: { cushion: '11370012', bolster: '11370013', armCushion: '11370014' },
  },
}];
// Dressed in Tona (grade A) with the cushions in a DIFFERENT code, so the build
// is sold by parts (the dearer ladder) — the case that broke.
const NOVANISH_PLACED: Placement = {
  uid: 'u1', pieceId: 'settee',
  material: { grade: 'A', fabric: 'Tona · Écru', code: 'T1', unitPrice: 10895 },
  partMaterials: { cushion: { grade: 'I', fabric: 'ARDA/FR · Gris', code: 'A9' } },
};

test('NO-VANISH: a part picked at a grade its SKU ladder never offered keeps its line', () => {
  const resolvedById = resolveModels(NOVANISH_MODELS, NOVANISH_PRODUCTS);
  const r = resolvedById.settee!;
  assert.deepEqual(unresolvedPartRoles(r, NOVANISH_PLACED), ['cushion'],
    'the cushion pick is off its ladder; the unpicked rulo/brazo default to grades[0] and resolve');

  const { lines, totalUsd } = placementBreakdown(NOVANISH_PLACED, resolvedById);
  assert.deepEqual(lines.map((l) => l.role), ['base', 'cushion', 'bolster', 'armCushion'],
    'every componente the piece ships with is still on the sheet — nothing dropped out');

  const cush = lines.find((l) => l.role === 'cushion')!;
  assert.equal(cush.unresolved, true, 'flagged, so a View can read "sin precio"');
  assert.equal(cush.unitUsd, null);
  assert.equal(cush.totalUsd, null, 'no money on a line nobody priced');
  assert.equal(cush.included, undefined, '…and never "incluido" — that would be a promise nobody costed');
  assert.equal(cush.fabric, 'ARDA/FR · Gris', 'the customer’s own pick is named');
  assert.equal(cush.qty, 1);
  assert.equal(cush.defaultGrade, false, 'it IS a pick — it just has no price');

  // The rest of the piece still prices normally: the gap is stated, not spread.
  assert.equal(lines.find((l) => l.role === 'base')!.totalUsd, 10895);
  assert.equal(lines.find((l) => l.role === 'bolster')!.totalUsd, 575);
  assert.equal(lines.find((l) => l.role === 'armCushion')!.totalUsd, 7300);

  // THE TRAP, stated: the priced lines DO foot to a perfectly plausible number.
  const footed = lines.reduce((s, l) => s + (l.totalUsd || 0), 0);
  assert.equal(footed, 18770, 'exactly the wrong total the dealer was shown');
  assert.equal(totalUsd, null, '…which is why the placement has NO total, rather than that one');
  assert.equal(placementTotal(NOVANISH_PLACED, resolvedById), null);

  // An UNBOUND family is the OPPOSITE case and keeps its opposite answer: no SKU
  // at all ⇒ the part is not sold separately ⇒ no phantom line, no gap to close.
  const unbound = resolveModels(
    [{ id: 'nb', productRoot: '11370000', parts: { mats: { cush: 'cushion' }, roots: {} } }],
    NOVANISH_PRODUCTS,
  );
  const bare: Placement = { uid: 'u2', pieceId: 'nb' };
  assert.deepEqual(unresolvedPartRoles(unbound.nb!, bare), []);
  assert.equal(placementBreakdown(bare, unbound).lines.length, 1);
});

test('NO-VANISH: a resolvable grade prices exactly as before, and monocolor never fails', () => {
  const resolvedById = resolveModels(NOVANISH_MODELS, NOVANISH_PRODUCTS);
  // The same build with the cushions in a grade the ladder DOES sell: 10,895 +
  // 7,300 (cushion set at C) + 575 (rulo) + 7,300 (brazo) = 26,070 — the real
  // price of the piece the visitor was quoted 18,770 for.
  const fixed: Placement = { ...NOVANISH_PLACED, partMaterials: { cushion: { grade: 'C', fabric: 'Steppe', code: 'S2' } } };
  assert.deepEqual(unresolvedPartRoles(resolvedById.settee!, fixed), []);
  assert.equal(placementTotal(fixed, resolvedById), 26070);
  assert.ok(placementTotal(fixed, resolvedById)! > 18770, 'by-parts is DEARER than the vanished total');
  const { lines, totalUsd } = placementBreakdown(fixed, resolvedById);
  assert.equal(totalUsd, 26070);
  assert.equal(lines.reduce((s, l) => s + (l.totalUsd || 0), 0), 26070, 'still foots exactly');
  assert.ok(lines.every((l) => !l.unresolved));

  // MONOCOLOR: the very same off-ladder grade, but the cushion rides the piece's
  // own CODE ⇒ elemento completo ⇒ the componentes bill nothing, so no
  // componente grade can move the price and there is nothing to fail.
  const mono: Placement = { ...NOVANISH_PLACED, partMaterials: { cushion: { grade: 'I', fabric: 'Tona · Écru', code: 'T1' } } };
  assert.deepEqual(unresolvedPartRoles(resolvedById.settee!, mono), []);
  assert.equal(placementTotal(mono, resolvedById), 10895, 'one SKU, the cheaper answer');
  const monoCush = placementBreakdown(mono, resolvedById).lines.find((l) => l.role === 'cushion')!;
  assert.equal(monoCush.included, true, 'listed as bought-by-the-whole-piece, not as unpriced');
  assert.equal(monoCush.unresolved, undefined);
});

/* ------------- WHOLE-PIECE GRADE HONESTY: the piece's own cloth ------------- */
// The part gate above closed the componente ladders and left the model's OWN
// open. Measured on the reference catalogue: a settee's family is priced in six
// grades while the picker offered every one of the 55 fabrics the model is
// linked to, spanning seventeen — so 32 of them stored a grade that SKU has
// never been sold in, and NOTHING said so: a pick stamps the model's CHEAPEST
// grade whenever `productForGrade` comes back empty, so a Grade E settee quoted
// at the Grade C price and read as a perfectly normal quote. Owner's rule: only
// the fabrics that really correspond to a model should come up for it.
//
// The wall below carries ONE material per grade the real wall spans, so the
// counts are the live shape at reading size: 17 in, 5 out.
const SETTEE_LADDER = ['C', 'D', 'L', 'M', 'S', 'V'];
const WHOLEPIECE_PRODUCTS: ProductRow[] = SETTEE_LADDER.map((g, i) => ({
  reference: `11370700${g}`, name: 'Large Square Settee', priceUsd: 10895 + i * 700,
}));
const WHOLEPIECE_WALL = [
  { name: 'ACATE', grade: 'A' }, { name: 'SILVERTEX/FR', grade: 'B' }, { name: 'ARA', grade: 'C' },
  { name: 'CLOUD', grade: 'D' }, { name: 'TONA', grade: 'E' }, { name: 'ROMA', grade: 'F' },
  { name: 'LEO', grade: 'G' }, { name: 'PHLOX', grade: 'H' }, { name: 'ARDA/FR', grade: 'I' },
  { name: 'UNIFORM MELANGE/FR', grade: 'L' }, { name: 'GENTLE/FR', grade: 'N' },
  { name: 'BYRAM/FR', grade: 'P' }, { name: 'FLORALY', grade: 'R' },
  { name: 'ALCANTARA - A', grade: 'S' }, { name: 'INDIANA', grade: 'U' },
  { name: 'DIVA', grade: 'V' }, { name: 'KYOTO', grade: 'X' },
];
const WHOLEPIECE_MODELS: ModelRow[] = [{ id: 'settee7', productRoot: '11370700' }];
// Dressed in TONA — Grade E. A real fabric, offered on this model, and one its
// own SKU has never carried a price for. `unitPrice` is what the pick STAMPED:
// `productForGrade(E)` found nothing, so the picker wrote the model's cheapest
// grade. This row IS the bug, frozen.
const WHOLEPIECE_PLACED: Placement = {
  uid: 'w1', pieceId: 'settee7',
  material: { grade: 'E', fabric: 'TONA · Écru', code: 'T1', unitPrice: 10895 },
};

test('WHOLE PIECE: the picker only offers fabrics the targeted model’s own ladder can price', () => {
  const resolvedById = resolveModels(WHOLEPIECE_MODELS, WHOLEPIECE_PRODUCTS);
  const family = resolvedById.settee7!.baseFamily!;
  assert.deepEqual(family.grades.slice().sort(), SETTEE_LADDER, 'the ladder under test');
  assert.equal(WHOLEPIECE_WALL.length, 17, 'every grade the model’s linked fabrics span');

  const offer = offeredMaterials(WHOLEPIECE_WALL, [family]);
  // The offer is the ladder ∩ the wall, and it is SMALLER than both: twelve
  // tiles go (their grade isn't sold), and the ladder's own M has no linked
  // fabric wearing it — exactly the live shape.
  assert.equal(offer.length, 5);
  assert.deepEqual(offer.map((m) => m.grade), ['C', 'D', 'L', 'S', 'V']);
  assert.deepEqual(offer.map((m) => m.name), ['ARA', 'CLOUD', 'UNIFORM MELANGE/FR', 'ALCANTARA - A', 'DIVA']);

  // THE INVARIANT, not the arithmetic: what the picker OFFERS is exactly what
  // the price gate ACCEPTS. A normalization drift on either side (case,
  // trimming, a different grade key) shows up here as a disagreement rather than
  // as builds silently reading "sin precio" in production.
  const r = resolvedById.settee7!;
  for (const m of WHOLEPIECE_WALL) {
    const placed: Placement = { uid: 'x', pieceId: 'settee7', material: { grade: m.grade, fabric: m.name, code: 'k' } };
    assert.equal(offer.includes(m), !unresolvedWholePiece(r, placed),
      `${m.name} (grade ${m.grade}): the picker and the price gate must agree`);
  }

  // "APPLY TO ALL" is the INTERSECTION of every target's ladder — a cloth that
  // prices on four models and not the fifth would leave the fifth silently at
  // its cheapest grade, the same lie spread thinner.
  const narrow = familyFor('44440000', [
    { reference: '44440000C', priceUsd: 500 },
    { reference: '44440000S', priceUsd: 700 },
  ])!;
  assert.deepEqual(offeredMaterials(WHOLEPIECE_WALL, [family, narrow]).map((m) => m.grade), ['C', 'S']);

  // NO-VANISH AT THE DOOR: a model with no ladder data filters NOTHING…
  assert.equal(offeredMaterials(WHOLEPIECE_WALL, [null]).length, 17);
  assert.equal(offeredMaterials(WHOLEPIECE_WALL, []).length, 17);
  // …a lone ungraded SKU is not a ladder either (`graded` needs two)…
  const solo = familyFor('99990000', [{ reference: '99990000A', name: 'Solo', priceUsd: 500 }])!;
  assert.equal(solo.graded, false);
  assert.equal(offeredMaterials(WHOLEPIECE_WALL, [solo]).length, 17);
  // …and DISJOINT ladders, which "apply to all" can reach, ship the wall whole
  // rather than an empty picker that answers no question at all.
  const disjoint = familyFor('55550000', [
    { reference: '55550000A', priceUsd: 100 },
    { reference: '55550000B', priceUsd: 120 },
  ])!;
  assert.equal(offeredMaterials(WHOLEPIECE_WALL, [family, disjoint]).length, 17);
  assert.deepEqual(offeredMaterials(null, [family]), []);
});

test('WHOLE PIECE: a stored off-ladder pick prices NOTHING — never the model’s cheapest grade', () => {
  const resolvedById = resolveModels(WHOLEPIECE_MODELS, WHOLEPIECE_PRODUCTS);
  const r = resolvedById.settee7!;
  assert.equal(unresolvedWholePiece(r, WHOLEPIECE_PLACED), true);
  assert.deepEqual(unresolvedPartRoles(r, WHOLEPIECE_PLACED), [], 'the PART axis is clean — this is the piece’s own cloth');

  // THE TRAP, stated: the stamped price is a real, plausible, WRONG number.
  assert.equal(r.unitPrice, 10895, 'the model’s cheapest grade, wearing Grade E’s name');
  assert.equal(placementTotal(WHOLEPIECE_PLACED, resolvedById), null, 'so the piece has NO price, rather than that one');

  const { lines, totalUsd } = placementBreakdown(WHOLEPIECE_PLACED, resolvedById);
  assert.equal(lines.length, 1);
  const base = lines[0];
  assert.equal(base.role, 'base');
  assert.equal(base.unresolved, true, 'flagged, so a View reads "sin precio"');
  assert.equal(base.unitUsd, null);
  assert.equal(base.totalUsd, null);
  assert.equal(base.complete, undefined, 'and never "Elemento completo" — nothing costed it');
  assert.equal(base.fabric, 'TONA · Écru', 'the customer’s own pick is still named');
  assert.equal(base.defaultGrade, false, 'it IS a pick — it just has no price');
  assert.equal(totalUsd, null);
});

test('WHOLE PIECE: an on-ladder grade prices exactly as before, and no pick at all is never gated', () => {
  const resolvedById = resolveModels(WHOLEPIECE_MODELS, WHOLEPIECE_PRODUCTS);
  // Grade D — on the ladder. 10,895 + 1×700 = 11,595, byte for byte what it was.
  const ok: Placement = { ...WHOLEPIECE_PLACED, material: { grade: 'D', fabric: 'CLOUD', code: 'C1', unitPrice: 11595 } };
  assert.equal(unresolvedWholePiece(resolvedById.settee7!, ok), false);
  assert.equal(placementTotal(ok, resolvedById), 11595);
  const okLines = placementBreakdown(ok, resolvedById).lines;
  assert.equal(okLines[0].totalUsd, 11595);
  assert.equal(okLines[0].unresolved, undefined);

  // NO PICK AT ALL. The sticker price is the family's cheapest grade by
  // documented convention; it resolves by construction and is not a lie about
  // anything the visitor chose, so the gate never fires.
  const bare: Placement = { uid: 'w2', pieceId: 'settee7' };
  assert.equal(unresolvedWholePiece(resolvedById.settee7!, bare), false);
  assert.equal(placementTotal(bare, resolvedById), 10895);

  // A model with NO ladder is untouched too: nothing to be off.
  const noFam = resolveModels([{ id: 'nf', productRoot: null }], WHOLEPIECE_PRODUCTS);
  const wild: Placement = { uid: 'w3', pieceId: 'nf', material: { grade: 'Z', fabric: 'X', code: 'z', unitPrice: 999 } };
  assert.equal(unresolvedWholePiece(noFam.nf!, wild), false);
  assert.equal(placementTotal(wild, noFam), 999, 'prices exactly as today');
});

/* --------------------------- materialization zones --------------------------- */

test('ottoman zones: bicolor re-grades the base SKU (dearest wins) and never bills a line', () => {
  const products: ProductRow[] = [
    { reference: '11370200A', name: 'Prado small square ottoman', priceUsd: 3145 },
    { reference: '11370200C', name: 'Prado small square ottoman', priceUsd: 3460 },
    { reference: '11370200F', name: 'Prado small square ottoman', priceUsd: 3785 },
  ];
  const resolvedById = resolveModels(
    [{ id: 'ott', productRoot: '11370200', parts: { mats: { body: 'exterior', plinth: 'interior' } } }],
    products,
  );
  const r = resolvedById.ott!;
  assert.equal(r.unitPrice, 3145, 'sticker = cheapest grade');
  assert.equal(r.partFamilies, null, 'zones bind no SKU family of their own');
  assert.ok(r.baseFamily, 'the model’s own family rides for zone re-grading');

  // MONOCOLOR (no zone picks): the base pick prices as always.
  const mono: Placement = { uid: 'u1', pieceId: 'ott', material: { grade: 'A', fabric: 'Tona', code: 'T1', unitPrice: 3145 } };
  assert.equal(placementTotal(mono, resolvedById), 3145);

  // BICOLOR: exterior stays A, interior picks the dearer F → the ONE SKU
  // re-grades to F. No extra line ever appears.
  const bi: Placement = { ...mono, partMaterials: { interior: { grade: 'F', fabric: 'Alcantara', code: 'AL1' } } };
  assert.equal(placementTotal(bi, resolvedById), 3785);
  assert.equal(materializedBase({ ...r, ...bi.material }, bi.partMaterials).reference, '11370200F',
    'the factory-invoiced SKU is the dearest grade');

  const { lines, totalUsd } = placementBreakdown(bi, resolvedById);
  assert.equal(totalUsd, 3785);
  assert.equal(lines[0].role, 'base');
  assert.equal(lines[0].totalUsd, 3785, 'the dearest-zone price shows on the base line');
  const zones = lines.filter((l) => l.included);
  assert.deepEqual(zones.map((l) => l.role), ['exterior', 'interior'], 'both zones list as included');
  assert.equal(zones[1].fabric, 'Alcantara');
  assert.equal(zones[1].totalUsd, null, 'a zone never carries money');
  assert.equal(zones[0].defaultGrade, true, 'unpicked exterior whispers "tela base"');
  const footed = lines.reduce((s, l) => s + (l.totalUsd || 0), 0);
  assert.equal(footed, totalUsd, 'included lines don’t double-count');

  // A dearer BASE pick beats a cheaper zone: MAX, not last-write.
  const baseC: Placement = {
    ...bi,
    material: { grade: 'C', fabric: 'Tona', code: 'T1', unitPrice: 3460 },
    partMaterials: { interior: { grade: 'A', fabric: 'Alc', code: 'A1' } },
  };
  assert.equal(placementTotal(baseC, resolvedById), 3460);

  // NO-VANISH, the zone flavour: a zone bills no line, so an off-ladder zone
  // pick can't drop one — it just gets IGNORED, leaving the piece at its
  // cheaper grade. Same lie, quieter voice: the dearest-zone rule silently
  // didn't run, and nobody said so.
  const badZone: Placement = { ...mono, partMaterials: { interior: { grade: 'I', fabric: 'ARDA/FR', code: 'A9' } } };
  assert.deepEqual(unresolvedPartRoles(r, badZone), ['interior']);
  assert.equal(placementTotal(badZone, resolvedById), null, 'not 3145 — that is the base pretending to be the piece');
  const badLines = placementBreakdown(badZone, resolvedById).lines;
  const inner = badLines.find((l) => l.role === 'interior')!;
  assert.equal(inner.unresolved, true);
  assert.equal(inner.included, undefined, 'a zone the SKU can’t re-grade is not "incluido"');
  assert.equal(inner.fabric, 'ARDA/FR', 'the pick still shows — it never leaves the sheet');
  assert.equal(badLines.find((l) => l.role === 'exterior')!.included, true, 'the resolvable zone is untouched');
});

/* ------------------------------ the breakdown ------------------------------ */

test('placementBreakdown itemizes base + parts and always foots to placementTotal', () => {
  const products: ProductRow[] = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '22222222A', name: 'Back cushion', priceUsd: 100 },
    { reference: '22222222B', name: 'Back cushion', priceUsd: 150 },
    { reference: '33333333A', name: 'Bolster', priceUsd: 50 },
  ];
  const resolvedById = resolveModels([{
    id: 'm1',
    productRoot: '11111111',
    parts: {
      mats: { a: 'base', b: 'cushion', c: 'cushion', d: 'bolster' },
      roots: { cushion: '22222222', bolster: '33333333' },
    },
  }], products);
  const p: Placement = {
    uid: 'u1', pieceId: 'm1',
    material: { grade: 'A', fabric: 'Divina', code: 'D1', unitPrice: 1000 },
    partMaterials: { cushion: { grade: 'B', fabric: 'Steelcut', code: 'S2' } },
  };
  const { lines, totalUsd } = placementBreakdown(p, resolvedById);
  assert.equal(lines.length, 3, 'base + cushion + bolster lines');
  const [base, cush, bols] = lines;
  assert.equal(base.role, 'base');
  // «Cuerpo», not «Base»: presentation only — the role TOKEN is still `base`.
  assert.equal(base.label, 'Cuerpo');
  assert.equal(base.fabric, 'Divina');
  assert.equal(base.totalUsd, 1000);
  assert.equal(cush.qty, 1, 'the bound SKU is the SET covering both cushions');
  assert.equal(cush.unitUsd, 150);            // the picked grade B
  assert.equal(cush.totalUsd, 150);
  assert.equal(cush.fabric, 'Steelcut');
  assert.equal(cush.defaultGrade, false);
  assert.equal(cush.skuName, 'Back cushion', 'the catalogue name (it says single/juego) rides the line');
  assert.equal(bols.qty, 1);
  assert.equal(bols.unitUsd, 50);             // unpicked → cheapest grade
  assert.equal(bols.defaultGrade, true, 'unpicked part reads as default-grade');
  // The itemization FOOTS to the single roll-up number every surface shows.
  assert.equal(lines.reduce((s, l) => s + (l.totalUsd || 0), 0), totalUsd);
  assert.equal(totalUsd, placementTotal(p, resolvedById));

  // A model with NO tagged parts itemizes as the lone base line.
  const solo = resolveModels([{ id: 'm2', productRoot: '11111111' }], products);
  assert.equal(placementBreakdown({ uid: 'u2', pieceId: 'm2' }, solo).lines.length, 1);
});

test('placementBreakdown marks a monocolor build as ONE element, componentes included', () => {
  const products: ProductRow[] = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '22222222A', name: 'Juego 2 cojines', priceUsd: 100 },
  ];
  const resolvedById = resolveModels([{
    id: 'm1', productRoot: '11111111',
    parts: { mats: { a: 'base', b: 'cushion' }, roots: { cushion: '22222222' } },
  }], products);
  const { lines, totalUsd } = placementBreakdown(
    { uid: 'u1', pieceId: 'm1', material: { grade: 'A', fabric: 'Divina', code: 'D1' } },
    resolvedById,
  );
  assert.equal(lines[0].label, 'Elemento completo');
  assert.equal(lines[0].complete, true);
  assert.equal(lines[0].totalUsd, 1000);
  // The componente is still LISTED — the customer must see what the piece is
  // made of — but it is not charged: that one SKU already bought it.
  assert.equal(lines[1].role, 'cushion');
  assert.equal(lines[1].included, true);
  assert.equal(lines[1].unitUsd, null);
  assert.equal(lines[1].totalUsd, null);
  assert.equal(totalUsd, 1000);
  assert.equal(lines.reduce((s, l) => s + (l.totalUsd || 0), 0), totalUsd, 'included lines don’t double-count');
});

/* --------------------------- the primitives, directly --------------------------- */

test('piecePartsTotal: null base stays null, an unpriced role can never contribute', () => {
  const parts: PartsMap = { mats: { a: 'base', b: 'cushion', legs: 'structure', body: 'exterior' }, counts: { structure: 4, exterior: 3 } };
  assert.equal(piecePartsTotal(null, parts, { cushion: 100 }), null);
  // Even handed a price, a never-bills role multiplies by a count of 0.
  assert.equal(piecePartsTotal(1000, parts, { cushion: 100, structure: 999, exterior: 999 }), 1100);
  assert.equal(piecePartsTotal(1000, parts, null), 1000);
  assert.equal(piecePartsTotal(0.1 + 0.2, null, null), 0.3, 'rounded to the cent, never 0.30000000000000004');
});

test('partPricesFor: picked grade wins, unpicked defaults to the cheapest, unbound prices null', () => {
  const products: ProductRow[] = [
    { reference: '22222222A', name: 'Cushion', priceUsd: 100 },
    { reference: '22222222B', name: 'Cushion', priceUsd: 150 },
  ];
  const families = familiesOf(products);
  const partFamilies = partFamiliesFrom(
    { mats: { b: 'cushion', d: 'bolster' }, roots: { cushion: '22222222' } },
    families,
  )!;
  assert.deepEqual(partPricesFor({ partFamilies }, { cushion: { grade: 'B' } }), { cushion: 150, bolster: null });
  assert.deepEqual(partPricesFor({ partFamilies }, null), { cushion: 100, bolster: null });
  assert.equal(partPricesFor({ partFamilies: null }, null), null);
});

test('materializedBase passes a zone-less piece through untouched', () => {
  assert.deepEqual(materializedBase({ unitPrice: 1200, reference: '15420000A' }, { cushion: { grade: 'C' } }),
    { unitUsd: 1200, reference: '15420000A' });
  assert.deepEqual(materializedBase(null, null), { unitUsd: null, reference: '' });
});

/* ---------------------------- compound roll-up ---------------------------- */

test('a configured layout totals to compoundSubtotal — screen and quote can’t diverge', () => {
  const products: ProductRow[] = [
    { reference: '15420000A', name: 'Togo Armchair', priceUsd: 1200 },
    { reference: '15430000A', name: 'Togo Settee', priceUsd: 2600 },
  ];
  const resolvedById = resolveModels([
    { id: 'a', productRoot: '15420000' },
    { id: 'gb', productRoot: '15430000' },
  ], products);
  const placed: Placement[] = [
    { uid: 'u1', pieceId: 'a' },
    { uid: 'u2', pieceId: 'gb' },
    { uid: 'u3', pieceId: 'a' },
  ];
  // The quote line a promoted layout becomes: one component per breakdown row.
  const components = placed.flatMap((p, i) => placementBreakdown(p, resolvedById).lines
    .filter((l) => l.totalUsd != null)
    .map((l) => ({ moduleGroup: `mod-${i}`, qty: l.qty, unitPrice: l.unitUsd })));
  const expected = 1200 + 2600 + 1200;
  assert.equal(compoundSubtotal({ components }), expected);
  assert.equal(placed.reduce((s, p) => s + (placementTotal(p, resolvedById) || 0), 0), expected);

  // A per-placement material overrides the price and flows into the total.
  const repriced: Placement[] = [placed[0], { ...placed[1], material: { grade: 'G', fabric: 'ALCANTARA', code: 'A1', unitPrice: 3000 } }];
  assert.equal(placementTotal(repriced[1], resolvedById), 3000);
  assert.equal(repriced.reduce((s, p) => s + (placementTotal(p, resolvedById) || 0), 0), 1200 + 3000);
});

test('compoundSubtotal counts only PRICED components', () => {
  const line = {
    components: [
      { qty: 1, unitPrice: 100 },
      { qty: 2, unitPrice: 50 },
      { qty: 1, unitPrice: 999, isOptional: true },
      { qty: 1, unitPrice: 999, moduleOptional: true },
      { qty: 1, unitPrice: 999, alternativeGroup: 'g', isSelectedAlternative: false },
      { qty: 1, unitPrice: 40, alternativeGroup: 'g', isSelectedAlternative: true },
      { qty: 1, unitPrice: 999, moduleAlternativeGroup: 'm', moduleSelected: false },
    ],
  };
  assert.equal(compoundSubtotal(line), 100 + 100 + 40);
  assert.equal(compoundSubtotal({ components: [] }), 0);
  assert.equal(compoundSubtotal(null), 0);
  assert.equal(isPricedComponent(null), true, 'a plain component always counts');
  assert.equal(isPricedComponent({ qty: 1 }), true);
});

test('firstWithoutFabric targets the first piece missing a material pick', () => {
  assert.equal(firstWithoutFabric([]), null);
  assert.equal(firstWithoutFabric(null), null);
  assert.equal(firstWithoutFabric([{ uid: 'a', material: { grade: 'A' } }]), null);
  assert.equal(firstWithoutFabric([
    { uid: 'a', material: { grade: 'A' } },
    { uid: 'b' },
    { uid: 'c' },
  ]), 'b');
});
