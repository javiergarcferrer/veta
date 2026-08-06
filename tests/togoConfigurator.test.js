// Togo configurator — pins the asset footprints, the plan math (rotation +
// snapping), and the load-bearing invariant: a placed layout is a NORMAL modular
// quote line, so the configurator's subtotal IS the pricing engine's
// `compoundSubtotal`. If that parity ever breaks, screen ≠ quote — fail loudly.
//
// SANDBOX pins: the plan is an unbounded floor (no clamp, no walls — a piece
// goes wherever it's dropped) and rotation is FREE (any angle, footprints are
// the rotated AABB, exact at the cardinal angles). Never reintroduce a plan
// boundary "for safety" — the viewport normalizes around the build instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The widget's snapshot ENCODER and the Edge Function's snapshot DECODER, both
// imported here on purpose: they are the two ends of one wire and the only way
// to prove they agree is to run them against each other (the webpush /
// jarvisTools / quotePickParity precedent — code crosses the Deno↔Vite wall for
// a TEST, never at runtime).
import {
  canvasPngDataUrl, isPngDataUrl, snapshotFieldFor, SNAPSHOT_MAX_URL_CHARS,
  togoThumbStoreKey, togoThumbStamp, bakedThumbUrl, TILE_THUMB, ROW_THUMB,
} from '../src/components/togo/togoThumbnails.js';
import { buildFabricByCode } from '../src/lib/togo/fabricIndex.js';
import { snapshotBytesFromDataUrl, SNAPSHOT_MAX_BYTES } from '../supabase/functions/togo-embed/dealer.ts';

import {
  footprintOf, snapPlacement, snapPlacementInfo, resolvePlacement,
  buildTogoComponents, buildTogoModularSeed, resolveConfigurator, resolveTogoModels,
  resolveTogoModelCards, planTogoReorder, togoPickerFamilies,
  placementsFromPlaced, placementsFromComponents, resolveTogoDxf, lineHasTogoPlan,
  createHistory, historyPush, historyUndo, historyRedo, canUndo, canRedo,
  firstWithoutFabric, placementDressed, dressableRoles, duplicatePlacement, cyclePieceUid, EDGE_SNAP_CM, PLAN_MARGIN_CM, linkOverlap,
  placementMode, componentRoles, planModeSwitch, componentViewOf, sellsByComponentsOnly, effectivePartMaterials,
  placementTotalUsd, placementBreakdown, scenePlacementsFromPlaced, scenePlacementsFromComponents,
  resolveLaunchHero, resolveCollectionMenu, planHeroPin, unresolvedPartRoles, unresolvedWholePiece,
} from '../src/core/quote/views/configuratorView.js';
// The exact question the widget's material wall asks of every tile it renders
// (TogoEmbed `pickableMaterials`) — imported here so the OFFER and the PRICE
// gate below are checked against one another rather than described twice.
import { productForGrade } from '../src/lib/catalog.js';
import { compoundSubtotal } from '../src/lib/pricing.js';
// What the CLIENT is actually offered off a resolved model's `parts`.
import { structureGroupsOf } from '../src/lib/togo/meshParts.js';
// The pure core of the stage's selection highlight — what the gold outline and
// the emissive glow are BOTH allowed to cover, for each of the three focus modes.
import { focusMeshes, DRESSABLE_ROLE } from '../src/components/togo/TogoStage.jsx';
import { modulesOf, isModularLine } from '../src/lib/modules.js';
import { isPricedComponent } from '../src/lib/constants.js';
import { TOGO_PIECES } from '../src/assets/togo/pieces.js';

// A deterministic id factory (the app passes db.newId).
const ids = () => { let i = 0; return () => `id${i++}`; };

// The five Togo footprints MEASURED from the DWG "Mobilier 2D" layer. Pinning
// them guards a bad asset re-generation (wrong layer, wrong units, broken parse).
const EXPECTED = {
  chauf: [87, 102], a: [102, 102], gb: [174, 102], mc: [198, 102], lounge: [131, 162],
};

test('the generated Togo manifest carries the measured cm footprints', () => {
  assert.equal(TOGO_PIECES.length, 5);
  for (const p of TOGO_PIECES) {
    assert.ok(EXPECTED[p.id], `unexpected piece id ${p.id}`);
    assert.deepEqual([p.widthCm, p.depthCm], EXPECTED[p.id], `footprint drift on ${p.id}`);
    assert.ok(p.svgFile && /\.svg$/.test(p.svgFile), `${p.id} missing svgFile`);
    assert.ok(Array.isArray(p.match) && p.match.includes('togo'), `${p.id} missing match keywords`);
  }
});

test('footprintOf swaps width/depth at 90° and 270°, not at 0°/180° — integer-exact', () => {
  const piece = { widthCm: 174, depthCm: 102 };
  assert.deepEqual(footprintOf(piece, 0), { w: 174, h: 102 });
  assert.deepEqual(footprintOf(piece, 180), { w: 174, h: 102 });
  assert.deepEqual(footprintOf(piece, 90), { w: 102, h: 174 });
  assert.deepEqual(footprintOf(piece, 270), { w: 102, h: 174 });
  assert.deepEqual(footprintOf(piece, -90), { w: 102, h: 174 }); // normalises
});

test('footprintOf at a FREE angle is the rotated AABB (the sandbox allows any rotation)', () => {
  const piece = { widthCm: 174, depthCm: 102 };
  // 45°: both extents = (174+102)·√2/2.
  const d45 = footprintOf(piece, 45);
  assert.equal(d45.w, +((174 + 102) * Math.SQRT2 / 2).toFixed(2));
  assert.equal(d45.w, d45.h, '45° AABB is symmetric');
  // 30°: w = 174·cos30 + 102·sin30, h = 174·sin30 + 102·cos30.
  const d30 = footprintOf(piece, 30);
  assert.equal(d30.w, +(174 * Math.cos(Math.PI / 6) + 102 * 0.5).toFixed(2));
  assert.equal(d30.h, +(174 * 0.5 + 102 * Math.cos(Math.PI / 6)).toFixed(2));
  // The AABB never shrinks below the piece and never exceeds its diagonal.
  const diag = Math.hypot(174, 102);
  for (const rot of [7, 33.3, 61, 120.5, 205, 359]) {
    const f = footprintOf(piece, rot);
    assert.ok(f.w >= 102 - 0.01 && f.w <= diag + 0.01, `w in range at ${rot}°`);
    assert.ok(f.h >= 102 - 0.01 && f.h <= diag + 0.01, `h in range at ${rot}°`);
  }
});

test('snapPlacement rounds to the grid and clicks flush to a neighbour edge', () => {
  // Grid rounding with no neighbours.
  assert.deepEqual(snapPlacement({ x: 101, y: 51, w: 50, h: 50 }, []), { x: 102, y: 52 });

  // A piece nudged just past a settee's right edge (shared 102 cm depth band)
  // snaps flush: its left edge lands exactly on the settee's right edge.
  const settee = { x: 0, y: 0, w: 174, h: 102 };
  const snapped = snapPlacement({ x: 170, y: 3, w: 102, h: 102 }, [settee]);
  assert.equal(snapped.x, 174, 'left edge should meet the settee right edge');
  assert.equal(snapped.y, 0, 'tops should align');

  // Out of range → no snap, just the grid round.
  const far = snapPlacement({ x: 400, y: 300, w: 102, h: 102 }, [settee]);
  assert.deepEqual(far, { x: 400, y: 300 });

  // OVERLAP HAZARD: a piece dragged INSIDE the (wide) settee must NOT stay
  // embedded — pieces COLLIDE: it's pushed out along the axis of least
  // penetration to the nearest TOUCHING position (here: just below the settee).
  const onTop = snapPlacement({ x: 8, y: 4, w: 100, h: 100 }, [settee]);
  assert.equal(onTop.x, 8, 'the shallow axis is untouched');
  assert.equal(onTop.y, 102, 'pushed out to touch the settee bottom edge — never interpenetrating');
  // …but a flush JOIN from a near distance still locks: right edge ~6 cm shy of
  // the settee's left snaps butt-flush (and stays overlap-free).
  const joined = snapPlacement({ x: -94, y: 4, w: 100, h: 100 }, [settee]);
  assert.equal(joined.x, -100, 'right edge joins the settee left edge (-100+100=0, touching)');
});

test('pieces collide, never interpenetrate: an embedded drop resolves to flush contact (Prado)', () => {
  // The user scenario behind "magnetizing too close": two Prado settees
  // (160×179), the second shoved ~30 cm INTO the first and released. The old
  // fallback committed the embedded spot — the 3D meshes visibly crossed. Now
  // it must resolve to the nearest touching edge: flush contact, zero overlap.
  const a = { x: 0, y: 0, w: 160, h: 179 };
  const shoved = snapPlacementInfo({ x: 130, y: 0, w: 160, h: 179 }, [a]);
  assert.equal(shoved.x, 160, 'pushed out to touch a\'s right edge');
  assert.equal(shoved.y, 0);
  assert.equal(shoved.snapped, true, 'landing flush reads as snapped');
  // No gap either — they JUST touch (left edge of b == right edge of a).
  assert.equal(shoved.x, a.x + a.w);

  // Deep embed past the midpoint resolves to the NEAR side of that axis…
  const deep = snapPlacementInfo({ x: 20, y: 40, w: 160, h: 179 }, [a]);
  const overlapFree = !(deep.x < a.x + a.w && deep.x + 160 > a.x && deep.y < a.y + a.h && deep.y + 179 > a.y);
  assert.ok(overlapFree, 'wherever it resolves, the result is overlap-free');

  // …and a chain (pushed into a SECOND neighbour) settles overlap-free too.
  const b = { x: 160, y: 0, w: 160, h: 179 };
  const chained = snapPlacementInfo({ x: 150, y: 10, w: 160, h: 179 }, [a, b]);
  const freeOfBoth = [a, b].every((o) =>
    !(chained.x < o.x + o.w - 0.5 && chained.x + 160 > o.x + 0.5 && chained.y < o.y + o.h - 0.5 && chained.y + 179 > o.y + 0.5));
  assert.ok(freeOfBoth, 'multi-neighbour push settles clear of every piece');
});

test('link overlap: same-collection pieces NEST by the collection amount; others dock flush', () => {
  // Saparella modules nest by LINK_OVERLAP_CM.saparella (tuned to the Sofo join).
  const NEST = linkOverlap('Saparella', 'Saparella');
  assert.ok(NEST > 0, 'Saparella nests');
  assert.equal(linkOverlap('saparella', 'SAPARELLA'), NEST, 'case-insensitive');
  assert.equal(linkOverlap('Saparella', 'Prado'), 0, 'different collections never nest');
  assert.equal(linkOverlap('Prado', 'Prado'), 0, 'non-linking collection docks flush');
  assert.equal(linkOverlap(null, null), 0);

  // A Saparella fireside dropped flush-right of a diavolo (as addPiece does,
  // top-aligned) nests NEST cm into it — the overlap is the INTENDED join, not a
  // collision, so it's never pushed apart.
  // Docking uses the FIRM range (addPiece/release-dock) so a nest deeper than the
  // gentle 12 cm live magnet still engages.
  const firm = { edgeCm: 50 };
  const diavolo = { x: 0, y: 0, w: 82, h: 100, col: 'Saparella' };
  const nested = snapPlacement({ x: 82, y: 0, w: 78, h: 100, col: 'Saparella' }, [diavolo], firm);
  assert.equal(nested.x, 82 - NEST, 'fireside left edge sits NEST cm INTO the diavolo');
  assert.equal(nested.y, 0, 'stays top-aligned');
  assert.ok(nested.x < 82, 'nested, not flush');

  // The 90° turn: a Saparella piece below a neighbour nests on the Y axis.
  const belowNest = snapPlacement({ x: 0, y: 100, w: 78, h: 78, col: 'Saparella' }, [{ x: 0, y: 0, w: 100, h: 100, col: 'Saparella' }], firm);
  assert.equal(belowNest.y, 100 - NEST, 'top edge sits NEST cm into the piece above');

  // No collection (legacy) and cross-collection stay EXACTLY flush — no regression.
  const settee = { x: 0, y: 0, w: 174, h: 102 };
  assert.equal(snapPlacement({ x: 170, y: 3, w: 102, h: 102 }, [settee]).x, 174, 'legacy still docks flush');
  const deeper = snapPlacement({ x: 20, y: 0, w: 100, h: 100, col: 'Saparella' }, [{ x: 0, y: 0, w: 100, h: 100, col: 'Saparella' }]);
  const overlapPast = 100 - deeper.x;   // how far the candidate's left sits inside the neighbour
  assert.ok(overlapPast <= NEST + 0.01, 'a piece shoved deeper than the nest is pushed back OUT to the nest depth');
});

test('snapPlacementInfo reports WHICH axes engaged (the View\'s snap feedback), same x/y as snapPlacement', () => {
  const settee = { x: 0, y: 0, w: 174, h: 102 };

  // A flush join reports snapped on X (edges met) and Y (tops aligned).
  const joined = snapPlacementInfo({ x: 170, y: 3, w: 102, h: 102 }, [settee]);
  assert.deepEqual({ x: joined.x, y: joined.y }, snapPlacement({ x: 170, y: 3, w: 102, h: 102 }, [settee]));
  assert.equal(joined.snappedX, true);
  assert.equal(joined.snappedY, true);
  assert.equal(joined.snapped, true);

  // Already flush (distance 0) still reads as snapped — staying locked IS locked.
  const locked = snapPlacementInfo({ x: 174, y: 0, w: 102, h: 102 }, [settee]);
  assert.equal(locked.snapped, true);

  // Far away → grid round only, no snap flags.
  const far = snapPlacementInfo({ x: 400, y: 300, w: 102, h: 102 }, [settee]);
  assert.deepEqual(far, { x: 400, y: 300, snappedX: false, snappedY: false, snapped: false });

  // A collision push-out lands flush against the neighbour — that IS an edge
  // engagement, so the flush feedback (glow/haptic) fires on the pushed axis.
  const onTop = snapPlacementInfo({ x: 8, y: 4, w: 100, h: 100 }, [settee]);
  assert.equal(onTop.snapped, true);
  assert.equal(onTop.snappedY, true, 'pushed out on Y → flush on Y');
  assert.equal(onTop.snappedX, false);

  // No neighbours → never snapped.
  assert.equal(snapPlacementInfo({ x: 101, y: 51, w: 50, h: 50 }, []).snapped, false);
});

test('the magnet is an assist, not a barrier: gentle threshold, and no clamp exists', async () => {
  // The edge snap must stay GENTLE — a strong magnet (the old 26 cm) teleports
  // pieces mid-drag and fights a free arrangement.
  assert.ok(EDGE_SNAP_CM <= 12, 'edge snap must stay a gentle assist');
  // The sandbox has no walls: the old clampToPlan barrier must stay deleted.
  const mod = await import('../src/core/quote/views/configuratorView.js');
  assert.equal(mod.clampToPlan, undefined, 'no plan clamp — the floor is unbounded');
});

// ---- the parity that matters: layout → a real modular line ----
const resolved = {
  a: { id: 'a', label: 'Sillón', name: 'Togo Armchair', reference: '15420000A', subtype: 'A', widthCm: 102, depthCm: 102, unitPrice: 1200, dimensions: '102×102 cm', baseFamily: { root: '15420000', family: 'TOGO' } },
  gb: { id: 'gb', label: 'Sofá', name: 'Togo Settee', reference: '15430000A', subtype: 'A', widthCm: 174, depthCm: 102, unitPrice: 2600, dimensions: '174×102 cm', baseFamily: { root: '15430000', family: 'TOGO' } },
};
const placed = [
  { uid: 'u1', pieceId: 'a', x: 0, y: 0, rot: 0 },
  { uid: 'u2', pieceId: 'gb', x: 0, y: 110, rot: 90 },
  { uid: 'u3', pieceId: 'a', x: 110, y: 0, rot: 0 },
];

test('placed pieces build a MODULAR line whose subtotal === compoundSubtotal', () => {
  const seed = buildTogoModularSeed(placed, resolved, ids());
  // The line FILES under the CATALOG's family (products.family via the bound
  // root) — never the collection name; the collection only NAMES the line.
  assert.equal(seed.family, 'TOGO');
  assert.equal(seed.name, 'Togo — configuración');
  assert.equal(seed.components.length, 3);

  const line = { components: seed.components };
  // Each placed piece is its OWN module (a Togo "complete element").
  assert.ok(isModularLine(line), 'a per-component moduleGroup must read as modular');
  assert.equal(modulesOf(seed.components).length, 3, 'one module per placed piece');

  // Every component is priced (no optionals/alternatives) and carries its plan.
  for (const c of seed.components) {
    assert.ok(isPricedComponent(c), 'a configured piece must count toward the total');
    assert.ok(c.moduleGroup, 'each piece needs its own module group');
    assert.ok(c.plan && Number.isFinite(c.plan.x) && Number.isFinite(c.plan.y), 'plan geometry rides on the component');
  }

  // The engine the editor/PDF/bridge use agrees with our sum, to the cent.
  const expected = 1200 + 2600 + 1200;
  assert.equal(compoundSubtotal(line), expected);
});

test('a per-placement material overrides price/subtype/swatch and flows into the total', () => {
  const r = { a: { id: 'a', label: 'A', widthCm: 102, depthCm: 102, unitPrice: 1000, subtype: 'A', reference: '15420000A' } };
  const withMat = [
    { uid: 'u1', pieceId: 'a', x: 0, y: 0, rot: 0 },
    { uid: 'u2', pieceId: 'a', x: 0, y: 110, rot: 0, material: { unitPrice: 1500, subtype: 'G · ALCANTARA', swatchImageId: 'img-9', reference: '15420000G', fabric: 'ALCANTARA', grade: 'G' } },
  ];
  // resolvePlacement overlays the material onto the model defaults.
  assert.equal(resolvePlacement(withMat[0], r).unitPrice, 1000);
  assert.equal(resolvePlacement(withMat[1], r).unitPrice, 1500);

  const comps = buildTogoComponents(withMat, r, ids());
  assert.equal(comps[0].unitPrice, 1000);
  assert.equal(comps[1].unitPrice, 1500);
  assert.equal(comps[1].subtype, 'G · ALCANTARA');
  assert.equal(comps[1].swatchImageId, 'img-9');
  assert.equal(comps[1].reference, '15420000G');
  // The repriced fabric lands in the engine's compound total.
  assert.equal(compoundSubtotal({ components: comps }), 2500);
});

test('module groups are unique per piece, and rotation rides on the plan', () => {
  const comps = buildTogoComponents(placed, resolved, ids());
  const groups = new Set(comps.map((c) => c.moduleGroup));
  assert.equal(groups.size, comps.length, 'module groups must not collide');
  assert.equal(comps[1].plan.rot, 90, 'the settee was placed rotated 90°');
  assert.equal(comps[1].plan.pieceId, 'gb');
});

test('the plan component carries its collection so a promoted quote keeps its seam bleed', () => {
  const withCollection = {
    p: { id: 'p', label: 'Large Sofa', widthCm: 240, depthCm: 147, unitPrice: 5000, collection: 'Prado' },
    t: { id: 't', label: 'Togo', widthCm: 174, depthCm: 102, unitPrice: 2600 },   // legacy: no collection
  };
  const comps = buildTogoComponents(
    [{ uid: 1, pieceId: 'p', x: 0, y: 0, rot: 0 }, { uid: 2, pieceId: 't', x: 240, y: 0, rot: 0 }],
    withCollection, ids(),
  );
  assert.equal(comps[0].plan.collection, 'Prado');
  assert.equal(comps[1].plan.collection, null);
});

// ---- the palette projection shared by the builder + the Solicitudes inbox ----
test('resolveTogoModels prices each model at its cheapest grade, drops inactive/empty', () => {
  const products = [
    { reference: '15420000A', name: 'Togo Armchair', priceUsd: 1200, brand: 'ligne-roset', dimensions: '102×102 cm' },
    { reference: '15420000G', name: 'Togo Armchair', priceUsd: 1500, brand: 'ligne-roset' },
  ];
  const models = [
    { id: 'm1', name: 'Sillón Togo', productRoot: '15420000', widthCm: 102, depthCm: 102, svg: '<svg/>', active: true, sortOrder: 1 },
    { id: 'm2', name: 'Sin vincular', productRoot: null, widthCm: 87, depthCm: 102, svg: '<svg/>', active: true, sortOrder: 0 },
    { id: 'm3', name: 'Inactivo', productRoot: '15420000', widthCm: 0, depthCm: 0, svg: '<svg/>', active: false, sortOrder: 2 },
    { id: 'm4', name: 'Sin dibujo', productRoot: null, widthCm: 1, depthCm: 1, svg: '', active: true, sortOrder: 3 },
  ];
  const { activeModels, resolvedById, svgById } = resolveTogoModels(models, products);

  // Inactive + svg-less models are dropped; the rest sort by sortOrder.
  assert.deepEqual(activeModels.map((m) => m.id), ['m2', 'm1']);
  assert.equal(svgById.m1, '<svg/>');
  assert.equal(svgById.m3, undefined);

  // A bound model prices at its CHEAPEST grade (A=1200, not G=1500).
  assert.equal(resolvedById.m1.unitPrice, 1200);
  assert.equal(resolvedById.m1.reference, '15420000A');
  // An unbound model has no price; dimensions fall back to its footprint.
  assert.equal(resolvedById.m2.unitPrice, null);
  assert.equal(resolvedById.m2.dimensions, '87×102 cm');

  // A request's placements replay through the SAME resolved palette → real total.
  const placed = [{ uid: 'u1', pieceId: 'm1', x: 0, y: 0, rot: 0 }];
  assert.equal(resolveConfigurator(placed, resolvedById, { scale: 1 }).subtotalUsd, 1200);
});

// ---- the Modelos tab: bound state is a row property, the catalog is lazy ----
test('resolveTogoModelCards reads bound state from the row, enriches only when the catalog is loaded', () => {
  const models = [
    { id: 'm1', name: 'Sillón', productRoot: '15420000', widthCm: 102, depthCm: 102, svg: '<svg/>', sortOrder: 1 },
    { id: 'm2', name: 'Sin vincular', productRoot: null, widthCm: 87, depthCm: 102, svg: '<svg/>', sortOrder: 0 },
  ];

  // Catalog NOT loaded (families empty) — bound state must STILL be correct.
  // This is the bug fix: it used to derive "vinculado" from the loaded list, so a
  // bound model flickered "Sin vincular" for the ~10s the catalog took to load.
  const cold = resolveTogoModelCards(models, []);
  assert.deepEqual(cold.map((c) => c.id), ['m2', 'm1'], 'sorted by sortOrder');
  const m1cold = cold.find((c) => c.id === 'm1');
  assert.equal(m1cold.bound, true, 'bound comes from productRoot, not the loaded list');
  assert.equal(m1cold.familyName, null, 'no enrichment until the catalog loads');
  assert.equal(cold.find((c) => c.id === 'm2').bound, false);

  // Catalog loaded → name + grade count enrich the bound row.
  const products = [
    { reference: '15420000A', name: 'Togo Armchair', priceUsd: 1200, brand: 'ligne-roset' },
    { reference: '15420000G', name: 'Togo Armchair', priceUsd: 1500, brand: 'ligne-roset' },
  ];
  const warm = resolveTogoModelCards(models, togoPickerFamilies(products));
  const m1warm = warm.find((c) => c.id === 'm1');
  assert.equal(m1warm.bound, true);
  assert.equal(m1warm.familyName, 'Togo Armchair');
  assert.equal(m1warm.graded, true);
  assert.equal(m1warm.gradeCount, 2);
});

// ---- modular collections: the palette groups by family, the seed names it ----
test('collections: legacy rows read as Togo, palette lists them in order, the seed is named after the build', () => {
  const models = [
    { id: 't1', name: 'Sillón Togo', widthCm: 102, depthCm: 102, svg: '<svg/>', active: true, sortOrder: 0 },
    { id: 'p1', name: 'Prado Chaise', collection: 'Prado', widthCm: 180, depthCm: 100, svg: '<svg/>', active: true, sortOrder: 1 },
    { id: 'p2', name: 'Prado Módulo', collection: 'Prado', widthCm: 100, depthCm: 100, svg: '<svg/>', active: true, sortOrder: 2 },
  ];
  const { resolvedById, collections } = resolveTogoModels(models, []);
  // Legacy rows (no collection column value) file under Togo; order = first
  // appearance in palette order, so the picker chips are stable.
  assert.deepEqual(collections, ['Togo', 'Prado']);
  assert.equal(resolvedById.t1.collection, 'Togo');
  assert.equal(resolvedById.p1.collection, 'Prado');

  // Uniform build → the quote line is NAMED after its collection… but FILES
  // under the catalog family only (these unbound models have none → '' — the
  // configurator never invents a category).
  const prado = buildTogoModularSeed(
    [{ uid: 'u1', pieceId: 'p1', x: 0, y: 0, rot: 0 }, { uid: 'u2', pieceId: 'p2', x: 200, y: 0, rot: 0 }],
    resolvedById, ids(),
  );
  assert.equal(prado.family, '');
  assert.equal(prado.name, 'Prado — configuración');
  // …a mixed-collection build is NAMED Modular (never mislabels one family).
  const mixed = buildTogoModularSeed(
    [{ uid: 'u1', pieceId: 't1', x: 0, y: 0, rot: 0 }, { uid: 'u2', pieceId: 'p1', x: 200, y: 0, rot: 0 }],
    resolvedById, ids(),
  );
  assert.equal(mixed.family, '');
  assert.equal(mixed.name, 'Modular — configuración');
});

/**
 * ── THE ESTRUCTURA IS THE COLECCIÓN'S, AND IT ARRIVES BY ITSELF ─────────────
 *
 * An estructura palette is a colección-level parameter but storage is per model,
 * so a pieza marked Estructura whose row carries no `finishes` used to offer the
 * client NOTHING (`structureGroupsOf` reads that model's own `parts`) — it took
 * a dealer pressing «Usarlos en este modelo». Owner, 2026-07: «QUITA LO DE USAR
 * EN ESTE MODELO. HAZLO AUTOMATICO». So `resolveTogoModels` INJECTS it at read
 * time, which is also what heals every row saved before the palette existed.
 *
 * Pinned: it reaches a sibling that shares NO key, it never crosses a colección,
 * a model's OWN palette always wins, the INPUT rows are not mutated, and — the
 * one that matters — it adds `finishes` ONLY, so no price can move.
 */
test('resolveTogoModels injects the colección’s estructura into the models that lack one', () => {
  const products = [
    { reference: '15420000A', name: 'Prado Settee', priceUsd: 1200, brand: 'ligne-roset' },
    { reference: '15420000G', name: 'Prado Settee', priceUsd: 1500, brand: 'ligne-roset' },
  ];
  const acero = { label: 'Patas', options: [{ id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1 }], default: 'acero' };
  const negro = { label: 'Patas', options: [{ id: 'negro', label: 'Acero negro', rgb: '#17181c', metal: 1 }], default: 'negro' };
  // pCon names the settee's legs `metal_01` and the armchair's `metal_02` — the
  // exact reason a key-based rule could never reach the armchair.
  const models = [
    { id: 'settee', name: 'Settee', collection: 'Prado', updatedAt: 300, widthCm: 200, depthCm: 100, svg: '<svg/>', productRoot: '15420000',
      parts: { mats: { metal_01: 'structure', body: 'base' }, finishes: { metal_01: acero }, roots: { cushion: '15420000' }, counts: { cushion: 2 } } },
    { id: 'chair', name: 'Armchair', collection: 'Prado', updatedAt: 200, widthCm: 100, depthCm: 100, svg: '<svg/>', productRoot: '15420000',
      parts: { mats: { metal_02: 'structure', seat: 'base' }, roots: { cushion: '15420000' }, counts: { cushion: 2 } } },
    // Its OWN palette — own always wins over the colección's.
    { id: 'ottoman', name: 'Ottoman', collection: 'Prado', updatedAt: 100, widthCm: 80, depthCm: 80, svg: '<svg/>',
      parts: { mats: { pata: 'structure' }, finishes: { pata: negro } } },
    // Marked Estructura, but in ANOTHER colección: Prado's acabado is none of
    // its business.
    { id: 'togo', name: 'Togo', collection: 'Togo', updatedAt: 900, widthCm: 100, depthCm: 100, svg: '<svg/>',
      parts: { mats: { metal_01: 'structure' } } },
    // Prado, but nothing marked Estructura ⇒ never touched.
    { id: 'table', name: 'Table', collection: 'Prado', updatedAt: 50, widthCm: 60, depthCm: 60, svg: '<svg/>',
      parts: { mats: { top: 'base' } } },
  ];
  const before = JSON.parse(JSON.stringify(models));
  const { resolvedById } = resolveTogoModels(models, products);

  // The armchair is merely MARKED — and it carries the colección's palette.
  assert.deepEqual(resolvedById.chair.parts.finishes, { metal_02: acero });
  assert.deepEqual(structureGroupsOf(resolvedById.chair.parts).map((s) => s.group), ['metal_02']);
  assert.deepEqual(
    structureGroupsOf(resolvedById.chair.parts)[0].spec.options.map((o) => o.id),
    ['acero'],
    'the client is offered the colección’s acabados off a row that stores none',
  );
  // Own wins; another colección never inherits; no estructura ⇒ nothing added.
  assert.deepEqual(resolvedById.ottoman.parts.finishes, { pata: negro });
  assert.equal(resolvedById.togo.parts.finishes, undefined);
  assert.equal(resolvedById.table.parts.finishes, undefined);
  assert.deepEqual(resolvedById.settee.parts.finishes, { metal_01: acero }, 'the source row is unchanged');

  // The INPUT rows are never mutated — the studio still edits/saves what is
  // stored, and a second resolve can't compound onto the first.
  assert.deepEqual(models, before, 'resolveTogoModels mutates nothing');

  // MONEY: the injection adds `finishes` and NOTHING else.
  for (const id of ['settee', 'chair', 'ottoman', 'togo', 'table']) {
    const raw = before.find((m) => m.id === id).parts;
    const out = resolvedById[id].parts;
    assert.deepEqual(out.mats, raw.mats, `${id}: mats untouched`);
    assert.deepEqual(out.roots, raw.roots, `${id}: roots untouched`);
    assert.deepEqual(out.counts, raw.counts, `${id}: counts untouched`);
    assert.deepEqual(out.merges, raw.merges, `${id}: merges untouched`);
  }
  // …and the armchair prices IDENTICALLY with and without it: the same rows
  // resolved as a colección that has no estructura palette to give (BOTH the
  // settee's and the ottoman's — the union takes whichever row still has one).
  const noPalette = before.map((m) => ({ ...m, parts: { ...m.parts, finishes: undefined } }));
  const bare = resolveTogoModels(noPalette, products).resolvedById;
  assert.equal(bare.chair.parts.finishes, undefined, 'nothing to inject ⇒ nothing injected');
  const place = (rb) => resolveConfigurator([{ uid: 'u1', pieceId: 'chair', x: 0, y: 0, rot: 0 }], rb, { scale: 1 });
  assert.equal(place(resolvedById).subtotalUsd, place(bare).subtotalUsd);
  assert.equal(
    placementTotalUsd({ uid: 'u1', pieceId: 'chair', x: 0, y: 0, rot: 0 }, resolvedById),
    placementTotalUsd({ uid: 'u1', pieceId: 'chair', x: 0, y: 0, rot: 0 }, bare),
    'a finish has never moved a price, and the injection cannot be the first',
  );
  assert.deepEqual(resolvedById.chair.partFamilies, bare.chair.partFamilies);
});

test('resolveTogoModelCards: collection + the configurator-shaped mesh ride on the card', () => {
  const models = [
    { id: 'm1', name: 'Sillón', collection: 'Prado', widthCm: 102, depthCm: 102, svg: '<svg/>', sortOrder: 0,
      meshUrl: 'https://x/m.fbx', meshScale: null, meshUpAxis: 'z', meshRotateY: 90 },
    { id: 'm2', name: 'Viejo', widthCm: 87, depthCm: 102, svg: '<svg/>', sortOrder: 1 },
  ];
  const cards = resolveTogoModelCards(models, []);
  assert.equal(cards[0].collection, 'Prado');
  assert.equal(cards[1].collection, 'Togo', 'legacy rows file under Togo');
  // The card's mesh is the SAME shape the palette/renderTogoThumb consume, so
  // the Modelos tab renders the identical studio-rig 3D preview.
  assert.deepEqual(cards[0].mesh, { url: 'https://x/m.fbx', scale: null, upAxis: 'z', rotateY: 90 });
  assert.equal(cards[1].mesh, null);
});

test('togoPickerFamilies is empty until the catalog loads, then lists Togo families first', () => {
  assert.deepEqual(togoPickerFamilies(null), []);
  assert.deepEqual(togoPickerFamilies(undefined), []);
  const products = [
    { reference: '99990000A', name: 'Aaa Sofa', priceUsd: 100, brand: 'ligne-roset' },
    { reference: '99990000B', name: 'Aaa Sofa', priceUsd: 120, brand: 'ligne-roset' },
    { reference: '15420000A', name: 'Togo Armchair', priceUsd: 1200, brand: 'ligne-roset' },
  ];
  const fams = togoPickerFamilies(products);
  assert.equal(fams[0].name, 'Togo Armchair', 'Togo families sort ahead of the rest');
});

test('resolveConfigurator mirrors compoundSubtotal and lays tiles out in px', () => {
  const vm = resolveConfigurator(placed, resolved, { scale: 1 });
  assert.equal(vm.count, 3);
  assert.equal(vm.subtotalUsd, compoundSubtotal({ components: buildTogoComponents(placed, resolved, ids()) }));
  assert.equal(vm.subtotalUsd, 5000);
  assert.ok(vm.priced, 'all three pieces are priced');

  // The rotated settee tile (gb @ 90°) has a swapped footprint: 102 wide × 174 tall.
  const gbTile = vm.tiles.find((t) => t.uid === 'u2');
  assert.equal(gbTile.wPx, 102);
  assert.equal(gbTile.hPx, 174);
  // The svg inner box stays the UNrotated size (it rotates inside the tile).
  assert.equal(gbTile.innerWPx, 174);
  assert.equal(gbTile.innerHPx, 102);

  // An unpriced piece flips `priced` false.
  const vm2 = resolveConfigurator(
    [{ uid: 'x', pieceId: 'a', x: 0, y: 0, rot: 0 }],
    { a: { ...resolved.a, unitPrice: null } },
    { scale: 1 },
  );
  assert.equal(vm2.priced, false);
  assert.equal(vm2.subtotalUsd, 0);

  // An EMPTY layout is not priced (every() is vacuously true on []).
  const vmEmpty = resolveConfigurator([], resolved, { scale: 1 });
  assert.equal(vmEmpty.priced, false);
  assert.equal(vmEmpty.count, 0);
});

// ---- assembled dimensions: the union footprint of every placed piece ----
test('resolveConfigurator reports the overall assembled footprint (cm)', () => {
  // a@(0,0) → 102×102; gb@(0,110) rot90 → 102×174 (swapped); a@(110,0) → 102×102.
  const vm = resolveConfigurator(placed, resolved, { scale: 1 });
  assert.deepEqual(vm.overallCm, { widthCm: 212, depthCm: 284 });
  // Empty plan → zeroed, never NaN/Infinity.
  assert.deepEqual(resolveConfigurator([], resolved).overallCm, { widthCm: 0, depthCm: 0 });
});

// ---- sandbox viewport: the canvas hugs the build, wherever it was left ----
test('resolveConfigurator normalizes the tile viewport around the layout (unbounded floor)', () => {
  // A build left far from the origin — even at NEGATIVE coordinates — renders
  // framed: tiles are offset so the layout starts at the margin, and the canvas
  // is the overall footprint plus the margin all around.
  const farOut = [
    { uid: 'u1', pieceId: 'a', x: -300, y: -150, rot: 0 },
    { uid: 'u2', pieceId: 'a', x: -198, y: -150, rot: 0 },
  ];
  const vm = resolveConfigurator(farOut, resolved, { scale: 1 });
  assert.equal(vm.tiles[0].leftPx, PLAN_MARGIN_CM, 'leftmost piece sits at the margin');
  assert.equal(vm.tiles[0].topPx, PLAN_MARGIN_CM);
  assert.equal(vm.tiles[1].leftPx, PLAN_MARGIN_CM + 102, 'relative geometry is preserved');
  assert.deepEqual(vm.overallCm, { widthCm: 204, depthCm: 102 });
  assert.equal(vm.canvas.wPx, 204 + PLAN_MARGIN_CM * 2);
  assert.equal(vm.canvas.hPx, 102 + PLAN_MARGIN_CM * 2);
});

// ---- free rotation rides end-to-end: tile AABB, quote plan, DXF placement ----
test('a free-rotated piece keeps its AABB tile and its angle through the quote round-trip', () => {
  const rotated = [{ uid: 'u1', pieceId: 'gb', x: 0, y: 0, rot: 33.333 }];
  const vm = resolveConfigurator(rotated, resolved, { scale: 1 });
  // The tile box is the rotated AABB; the svg inner box stays the unrotated size.
  assert.equal(vm.tiles[0].wPx, footprintOf(resolved.gb, 33.333).w);
  assert.equal(vm.tiles[0].innerWPx, 174);
  assert.equal(vm.tiles[0].rot, 33.3, 'angles are normalized at 0.1° — no float dust');
  // The quote component stores the angle at 0.1° (tidy JSON, no float noise)…
  const comps = buildTogoComponents(rotated, resolved, ids());
  assert.equal(comps[0].plan.rot, 33.3);
  // …and it replays into DXF placements with the angle intact.
  const placements = placementsFromComponents(comps, {});
  assert.equal(placements[0].rot, 33.3);
});

// ---- undo/redo: the configurator's history stack ----
test('history push/undo/redo walks the placed snapshots; a new change clears redo', () => {
  const s0 = [];
  const s1 = [{ uid: 'u1' }];
  const s2 = [{ uid: 'u1' }, { uid: 'u2' }];

  let h = createHistory();
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
  assert.equal(historyUndo(h, s0), null, 'nothing to undo on a fresh stack');
  assert.equal(historyRedo(h, s0), null, 'nothing to redo on a fresh stack');

  h = historyPush(h, s0);          // change s0 → s1
  h = historyPush(h, s1);          // change s1 → s2
  assert.equal(canUndo(h), true);

  const u1 = historyUndo(h, s2);   // back to s1
  assert.equal(u1.present, s1);
  assert.equal(canRedo(u1.hist), true);

  const u2 = historyUndo(u1.hist, u1.present);   // back to s0
  assert.equal(u2.present, s0);
  assert.equal(canUndo(u2.hist), false);

  const r1 = historyRedo(u2.hist, u2.present);   // forward to s1
  assert.equal(r1.present, s1);
  const r2 = historyRedo(r1.hist, r1.present);   // forward to s2
  assert.equal(r2.present, s2);
  assert.equal(canRedo(r2.hist), false);

  // A NEW change after an undo abandons the redo branch.
  const back = historyUndo(h, s2);
  const branched = historyPush(back.hist, back.present);
  assert.equal(canRedo(branched), false);

  // The stack is bounded: oldest snapshots fall off, never grows past the limit.
  let cap = createHistory();
  for (let i = 0; i < 10; i++) cap = historyPush(cap, [i], 3);
  assert.equal(cap.past.length, 3);
  assert.deepEqual(cap.past, [[7], [8], [9]]);
});

test('firstWithoutFabric targets the first piece missing a material pick', () => {
  assert.equal(firstWithoutFabric([]), null);
  assert.equal(firstWithoutFabric([{ uid: 'a', material: { grade: 'A' } }]), null);
  assert.equal(firstWithoutFabric([
    { uid: 'a', material: { grade: 'A' } },
    { uid: 'b' },
    { uid: 'c' },
  ]), 'b');
});

// The keyboard Tab-cycle order over the plan: pieces are walked in spatial
// READING order (top→bottom, then left→right), NOT insertion order — so a
// SR/keyboard user steps through the layout the way the eye scans it, no matter
// how the arrangement was dragged together.
test('cyclePieceUid walks the placed pieces in reading order, wrapping both ways', () => {
  // Placed out of reading order: reading order is b(y0,x0) → a(y0,x50) → c(y100).
  const placed = [
    { uid: 'c', x: 0, y: 100 },
    { uid: 'a', x: 50, y: 0 },
    { uid: 'b', x: 0, y: 0 },
  ];

  // Forward from null starts at the first piece, then steps and WRAPS.
  assert.equal(cyclePieceUid(placed, null), 'b');
  assert.equal(cyclePieceUid(placed, 'b'), 'a');
  assert.equal(cyclePieceUid(placed, 'a'), 'c');
  assert.equal(cyclePieceUid(placed, 'c'), 'b', 'forward wraps past the last');

  // Backward: null → the LAST in reading order; then steps back and wraps.
  assert.equal(cyclePieceUid(placed, null, -1), 'c');
  assert.equal(cyclePieceUid(placed, 'b', -1), 'c', 'backward wraps past the first');

  // An unknown currentUid falls to the first piece going forward.
  assert.equal(cyclePieceUid(placed, 'zzz'), 'b');

  // Nothing to cycle → null.
  assert.equal(cyclePieceUid([], null), null);
  assert.equal(cyclePieceUid(null, 'b'), null);

  // A single piece cycles onto itself (both directions).
  const one = [{ uid: 'x', x: 0, y: 0 }];
  assert.equal(cyclePieceUid(one, 'x'), 'x');
  assert.equal(cyclePieceUid(one, 'x', -1), 'x');
  assert.equal(cyclePieceUid(one, null), 'x');
});

test('duplicatePlacement clones rotation + fabric and drops the copy flush to the right', () => {
  const r = { a: { id: 'a', label: 'Sillón', widthCm: 102, depthCm: 102, unitPrice: 1200 } };
  const one = [{ uid: 'u1', pieceId: 'a', x: 0, y: 0, rot: 0, material: { grade: 'G', fabric: 'ALCANTARA', unitPrice: 1500 } }];

  const dup = duplicatePlacement(one, 'u1', r, 'u9');
  assert.equal(dup.uid, 'u9');
  assert.equal(dup.placed.length, 2);
  const copy = dup.placed[1];
  assert.equal(copy.uid, 'u9');
  assert.equal(copy.pieceId, 'a');
  // Flush against the source's right edge, same row.
  assert.equal(copy.x, 102);
  assert.equal(copy.y, 0);
  // The fabric pick is CLONED, not shared (mutating one must not touch the other).
  assert.deepEqual(copy.material, one[0].material);
  assert.notEqual(copy.material, one[0].material);
  // The original list is untouched (immutably extended).
  assert.equal(one.length, 1);

  // Unknown uid → null (the View no-ops).
  assert.equal(duplicatePlacement(one, 'nope', r, 'u9'), null);

  // The floor is unbounded: a copy past the old 760 cm "plan edge" just keeps
  // the row growing — no wall pushes it back.
  const edge = [{ uid: 'e1', pieceId: 'a', x: 658, y: 0, rot: 0 }];
  const atEdge = duplicatePlacement(edge, 'e1', r, 'e2');
  assert.equal(atEdge.placed[1].x, 760, 'flush right of the source, wherever that is');
});

// ---- DXF export: a placed plan → a downloadable CAD file ----
test('resolveTogoDxf builds a named DXF from the configurator placements', () => {
  const placements = placementsFromPlaced(placed, resolved, { a: '<svg viewBox="0 0 102 102"><path d="M0 0L102 0"/></svg>' });
  assert.equal(placements.length, 3);
  assert.equal(placements[0].widthCm, 102);
  assert.equal(placements[1].rot, 90);

  const { dxf, filename, count } = resolveTogoDxf(placements, { name: 'María / López' });
  assert.equal(count, 3);
  // Filename is filesystem-safe (slashes stripped) and carries the contact.
  assert.equal(filename, 'Plano Togo - María López.dxf');
  assert.ok(dxf.startsWith('0\r\nSECTION'));
  assert.ok(/\r\n0\r\nEOF\r\n$/.test(dxf));
});

test('placementsFromComponents replays a promoted quote line, lineHasTogoPlan detects it', () => {
  const seed = buildTogoModularSeed(placed, resolved, ids());
  const line = { components: seed.components };
  assert.equal(lineHasTogoPlan(line), true);
  assert.equal(lineHasTogoPlan({ components: [{ name: 'Sofá' }] }), false);

  const placements = placementsFromComponents(seed.components, {});
  assert.equal(placements.length, 3);
  // The geometry + module label rode on the component plan → exported placement.
  assert.equal(placements[1].rot, 90);
  assert.equal(placements[1].widthCm, 174);
  assert.equal(placements[0].label, 'Sillón'); // moduleName survives the round-trip
});

// ── Per-part SKUs (Prado): base per model + shared cushion/bolster products ──

test('per-part SKUs: parts bill as their own components and every surface agrees', () => {
  const products = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '11111111B', name: 'Prado settee', priceUsd: 1200 },
    { reference: '22222222A', name: 'Prado back cushion', priceUsd: 100 },
    { reference: '22222222B', name: 'Prado back cushion', priceUsd: 150 },
    { reference: '33333333A', name: 'Prado bolster', priceUsd: 50 },
  ];
  const models = [{
    id: 'm1', name: 'Settee', widthCm: 160, depthCm: 179, svg: '<svg/>', active: true,
    productRoot: '11111111', collection: 'Prado',
    parts: {
      mats: { matA: 'base', matB: 'cushion', matC: 'cushion', matD: 'bolster' },
      roots: { cushion: '22222222', bolster: '33333333' },
    },
  }];
  const { resolvedById } = resolveTogoModels(models, products);
  const r = resolvedById.m1;
  assert.equal(r.unitPrice, 1000, 'base sticker stays base-only (cheapest grade)');
  assert.ok(r.partFamilies.cushion && r.partFamilies.bolster, 'part roots resolve to their own families');

  // SET SEMANTICS: the bound cushion SKU is the SET matching the module (the
  // catalog sells singles / juego de 2 / juego de 3), so the two physical
  // cushions bill ONE set SKU — when they bill at all.
  //
  // NOTHING PICKED is the ELEMENTO COMPLETO case: every componente rides the
  // base fabric, so the piece is one element and prices on the model's own SKU
  // ALONE (1000). The componentes are included, not summed — that is the whole
  // point of the cheaper whole-piece ladder (resolveCompleteSku).
  const p = { uid: 'u1', pieceId: 'm1', x: 0, y: 0, rot: 0 };
  assert.equal(placementTotalUsd(p, resolvedById), 1000);

  // A cushion picked in its own fabric IN MODO PIEZA changes no money: this
  // mode buys the model's SKU and the componentes come with it. (It used to
  // flip the build to base + componentes — the sum that bills the body twice
  // wherever a componente's SKU IS the body. That path is gone.)
  const picked = { ...p, partMaterials: { cushion: { grade: 'B', fabric: 'Divina', code: 'X1' } } };
  assert.equal(placementTotalUsd(picked, resolvedById), 1000);

  // MODO COMPONENTES is the other answer: the componentes ALONE. Every one of
  // them has to be chosen for there to be a price at all.
  const byParts = {
    ...p,
    partsMode: true,
    partMaterials: {
      cushion: { grade: 'B', fabric: 'Divina', code: 'X1' },
      bolster: { grade: 'A', fabric: 'Tona', code: 'X2' },
    },
  };
  assert.equal(placementTotalUsd(byParts, resolvedById), 150 + 50);

  // The quote line: the SAME two componentes, in the same module, priced at
  // their grades — and compoundSubtotal (the engine the quote uses) agrees with
  // the tile price, so screen and quote can't diverge. The base component stays
  // at ZERO: it is not sold here, it is what carries the plan.
  let n = 0;
  const comps = buildTogoComponents([byParts], resolvedById, () => `id${n++}`);
  assert.equal(comps.length, 3, 'base (unsold, carries the plan) + cushion + bolster');
  const [base, cush, bols] = comps;
  assert.ok(comps.every((c) => c.moduleGroup === base.moduleGroup), 'parts live INSIDE the piece module');
  assert.equal(base.unitPrice, 0, 'modo componentes does not sell the model\'s own SKU');
  assert.equal(base.plan.partsMode, true, 'the mode rides the plan, so a promoted quote replays in it');
  assert.equal(cush.qty, 1, 'the set SKU bills once');
  assert.equal(cush.unitPrice, 150);
  assert.equal(cush.reference, '22222222B', 'the picked grade selects the part SKU');
  assert.equal(bols.qty, 1);
  assert.equal(bols.unitPrice, 50);
  assert.deepEqual(base.plan.partMaterials.cushion, { grade: 'B', fabric: 'Divina', code: 'X1' });
  assert.equal(base.plan.parts.roots.cushion, '22222222', 'the tagging snapshots into the plan');
  assert.equal(compoundSubtotal({ components: comps }), 200);
  const vm = resolveConfigurator([byParts], resolvedById, { scale: 1 });
  assert.equal(vm.tiles[0].priceUsd, 200);
  assert.equal(vm.subtotalUsd, 200);

  // …and in modo pieza the componentes add no lines at all: one SKU bought them.
  const compsWhole = buildTogoComponents([picked], resolvedById, ids());
  assert.equal(compsWhole.length, 1, 'modo pieza ⇒ the piece is ONE component');
  assert.equal(compsWhole[0].unitPrice, 1000);
  assert.equal(compsWhole[0].plan.partsMode, undefined, 'and its plan is byte-identical to a pre-modes one');

  // No set in the catalog → the dealer overrides: 2 × the single-cushion SKU.
  const twoSingles = [{
    ...models[0], id: 'm3',
    parts: { ...models[0].parts, counts: { cushion: 2 } },
  }];
  const rb2 = resolveTogoModels(twoSingles, products).resolvedById;
  const two = { uid: 'u3', pieceId: 'm3', x: 0, y: 0, rot: 0 };
  // Modo pieza ⇒ the base SKU alone, count override or not…
  assert.equal(placementTotalUsd(two, rb2), 1000);
  // …and the override shows up in modo componentes: 2×100 + 50, no base SKU.
  assert.equal(
    placementTotalUsd({
      ...two,
      partsMode: true,
      partMaterials: {
        cushion: { grade: 'A', fabric: 'Hallingdal', code: 'X9' },
        bolster: { grade: 'A', fabric: 'Tona', code: 'X2' },
      },
    }, rb2),
    250,
  );

  // An UNBOUND part role adds no phantom $0 component.
  const unbound = [{ ...models[0], id: 'm2', parts: { mats: { matB: 'cushion' }, roots: {} } }];
  const r2 = resolveTogoModels(unbound, products).resolvedById.m2;
  assert.equal(r2.partFamilies.cushion, null);
  const comps2 = buildTogoComponents(
    [{ uid: 'u2', pieceId: 'm2', x: 0, y: 0, rot: 0 }], resolveTogoModels(unbound, products).resolvedById, ids(),
  );
  assert.equal(comps2.length, 1, 'unbound part → base component only');
});

test('estructura: a tagged metal part is INVISIBLE to money — same price, same components', () => {
  // «Estructura» (patas, marcos, bases en acero o lacado negro) is a real
  // client-facing choice that must never move a quote (owner, 2026-07: «se
  // eligen pero no cambian el precio»). The pin is a DIFFERENCE test: the same
  // settee, tagged and untagged, must price identically and seed the identical
  // quote components — anything else means the tag leaked into the money.
  const products = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '11111111C', name: 'Prado settee', priceUsd: 1400 },
    { reference: '22222222A', name: 'Prado back cushion', priceUsd: 100 },
    { reference: '22222222C', name: 'Prado back cushion', priceUsd: 150 },
  ];
  const mats = { matA: 'base', matB: 'cushion' };
  const roots = { cushion: '22222222' };
  const model = {
    name: 'Settee', widthCm: 160, depthCm: 179, svg: '<svg/>', active: true,
    productRoot: '11111111', collection: 'Prado',
  };
  const models = [
    { ...model, id: 'plain', parts: { mats, roots } },
    {
      ...model,
      id: 'legs',
      parts: {
        mats: { ...mats, legs: 'structure' },
        // A stray root and a typed count ride along: neither may charge.
        roots: { ...roots, structure: '11111111' },
        counts: { structure: 4 },
        labels: { legs: 'Patas' },
        finishes: {
          legs: {
            label: 'Acabado',
            default: 'acero',
            options: [
              { id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1 },
              { id: 'acero-negro', label: 'Acero lacado negro', rgb: '#17181c', metal: 1 },
            ],
          },
        },
      },
    },
  ];
  const { resolvedById } = resolveTogoModels(models, products);
  assert.deepEqual(Object.keys(resolvedById.legs.partFamilies), ['cushion'], 'a structure binds no family');
  assert.deepEqual(resolvedById.legs.partFamilies, resolvedById.plain.partFamilies);

  // The plan (pieceId + the tagging snapshot that replays the 3D) is the ONLY
  // thing allowed to differ between the two builds.
  const strip = (comps) => comps.map((c) => ({
    ...c,
    ...(c.plan ? { plan: { ...c.plan, pieceId: null, parts: null } } : {}),
  }));
  const material = { grade: 'A', fabric: 'Divina', code: 'D1', unitPrice: 1000 };
  // The difference test runs in BOTH modes: an estructura may not move the
  // money in either one, and the metal is invisible to both engines.
  for (const [label, over, expected] of [
    ['modo pieza', {}, 1000],
    ['modo pieza, componente distinto', { partMaterials: { cushion: { grade: 'C', fabric: 'Steelcut', code: 'S2' } } }, 1000],
    ['modo componentes', { partsMode: true, partMaterials: { cushion: { grade: 'C', fabric: 'Steelcut', code: 'S2' } } }, 150],
  ]) {
    const plain = { uid: 'a', pieceId: 'plain', x: 0, y: 0, rot: 0, material, ...over };
    const legs = { ...plain, uid: 'b', pieceId: 'legs' };
    assert.equal(placementTotalUsd(legs, resolvedById), placementTotalUsd(plain, resolvedById), `total (${label})`);
    assert.equal(placementTotalUsd(plain, resolvedById), expected, `the real price (${label})`);
    assert.deepEqual(
      strip(buildTogoComponents([legs], resolvedById, ids())),
      strip(buildTogoComponents([plain], resolvedById, ids())),
      `components (${label})`,
    );
  }

  // PICKING an acabado doesn't move it either: the choice only NAMES the module
  // (and rides the plan, so the promoted quote replays it in 3D).
  const picked = { uid: 'b', pieceId: 'legs', x: 0, y: 0, rot: 0, material, partFinishes: { legs: 'acero-negro' } };
  assert.equal(placementTotalUsd(picked, resolvedById), 1000);
  const comps = buildTogoComponents([picked], resolvedById, ids());
  assert.equal(comps.length, 1, 'a structure adds no component of its own');
  assert.equal(compoundSubtotal({ components: comps }), 1000);
  assert.match(comps[0].subtype, /acero-negro/, 'the pick reads on the module description');
  assert.equal(comps[0].plan.partFinishes.legs, 'acero-negro');
  assert.equal(comps[0].plan.parts.mats.legs, 'structure', 'the tagging snapshots for the 3D replay');
});

// ── THE HIGHLIGHT'S SCOPE — the same estructura/cloth split, in the viewport ──
// The money rule above says a structure is a DIFFERENT AXIS from cloth; this is
// that rule as the visitor meets it. Owner, 2026-08-01: «when I first click the
// piece … only the parts that have editable fabrics to be selected … the
// structure should not be part of that highlight. If I wanna edit the structure,
// I click the structure.» The gold line used to hug the metal feet on a plain
// tap, promising a gesture that cannot touch them.
//
// `focusMeshes` is the pure core of TogoStage's `focusMeshesFor` — the ONE
// filter both highlight channels (the outline's mask pass and the emissive glow)
// read, so a fixture of stamped meshes pins what either one can ever cover.
const M = (partRole, partKey = null) => ({ userData: { partRole, ...(partKey ? { partKey } : {}) } });
// One settee as the scene builder stamps it: base shell, two cushions, four legs
// merged into ONE group key — plus an UNTAGGED mesh, which reads as 'base'.
const PIECE_MESHES = [
  M('base'), M('cushion'), M('cushion'), M('bolster'),
  M('structure', 'legs'), M('structure', 'legs'), M('structure', 'legs'), M('structure', 'legs'),
  { userData: {} },
];

test('the plain-selection highlight is DRESSABLE — every mesh except the estructura', () => {
  const got = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null });
  assert.equal(got.length, 5, 'base + 2 cojines + rulo + the untagged mesh');
  assert.equal(
    got.some((m) => (m.userData.partRole || 'base') === 'structure'), false,
    'a leg can NEVER enter the dressable highlight — that is the whole ask',
  );
  // …and it is a strict SUBSET of the whole piece: narrower than "everything",
  // never a different set.
  assert.ok(got.length < PIECE_MESHES.length, 'dressable ⊂ whole piece');
  for (const m of got) assert.ok(PIECE_MESHES.includes(m));
});

test('the other two focus modes are unchanged — a role is all of it, a group is one', () => {
  // Tapping «Cojín» lights every cushion, not the one that was tapped.
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'cushion', groupKey: null }).length, 2);
  // Tapping «Estructura» lights the legs ALONE — the exact complement of
  // dressable, so the two highlights never overlap by a single mesh.
  const legs = focusMeshes(PIECE_MESHES, { role: 'structure', groupKey: 'legs' });
  assert.equal(legs.length, 4);
  const dress = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null });
  assert.equal(legs.filter((m) => dress.includes(m)).length, 0, 'dressable ∩ estructura = ∅');
  assert.equal(legs.length + dress.length, PIECE_MESHES.length, 'together they are the whole piece');
  // A groupKey OUTRANKS the role it arrives with (the finish target sends both).
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'cushion', groupKey: 'legs' }).length, 4);
});

test('NO-VANISH: a filter that matches nothing falls back to the whole piece', () => {
  // Null is what every caller reads as "the whole piece" — a selected piece is
  // never left unoutlined, whatever the model is tagged like.
  assert.equal(focusMeshes([M('structure', 'legs')], { role: DRESSABLE_ROLE, groupKey: null }), null,
    'an ALL-estructura piece keeps its whole-piece outline, not an empty one');
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'armCushion', groupKey: null }), null, 'a role the piece lacks');
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'structure', groupKey: 'stale' }), null, 'a stale group key');
  assert.equal(focusMeshes(PIECE_MESHES, { role: null, groupKey: null }), null, 'no scope at all');
  assert.equal(focusMeshes([], { role: DRESSABLE_ROLE, groupKey: null }), null, 'no meshes');
  // Legacy models carry no `partRole` at all: they read as base, so the
  // dressable highlight degrades to the whole piece rather than to nothing.
  const untagged = [{ userData: {} }, { userData: {} }];
  assert.equal(focusMeshes(untagged, { role: DRESSABLE_ROLE, groupKey: null }).length, 2);
});

test('seat-mounted accessories float: mounted at height, never colliding', () => {
  const models = [
    { id: 'sofa', name: 'Sofa', widthCm: 200, depthCm: 120, svg: '<svg/>', collection: 'Prado' },
    { id: 'cush', name: 'Cojín suelto', widthCm: 60, depthCm: 60, svg: '<svg/>', collection: 'Prado', mount: 'seat', mountHeightCm: 38 },
  ];
  const { resolvedById } = resolveTogoModels(models, []);
  const placed = [
    { uid: 'a', pieceId: 'sofa', x: 0, y: 0, rot: 0 },
    { uid: 'b', pieceId: 'cush', x: 50, y: 30, rot: 0 },   // sits ON the sofa's tile
  ];
  const scene = scenePlacementsFromPlaced(placed, resolvedById);
  assert.equal(scene[0].mountHeightCm, 0, 'modules sit on the floor');
  assert.equal(scene[1].mountHeightCm, 38, 'a loose cushion rides at seat height');

  // Duplicating the cushion never snaps/collides — it floats beside the original.
  const dup = duplicatePlacement(placed, 'b', resolvedById, 'b2');
  assert.equal(dup.placed[2].x, 110, 'src.x + width, no snap');
  assert.equal(dup.placed[2].y, 30);

  // And the mount survives the quote round-trip (plan → scene placements).
  const comps = buildTogoComponents(placed, resolvedById, ids());
  const replay = scenePlacementsFromComponents(comps);
  assert.equal(replay[0].mountHeightCm, 0);
  assert.equal(replay[1].mountHeightCm, 38);
});

test('placementBreakdown itemizes base + parts and always foots to placementTotalUsd', () => {
  const products = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '22222222A', name: 'Back cushion', priceUsd: 100 },
    { reference: '22222222B', name: 'Back cushion', priceUsd: 150 },
    { reference: '33333333A', name: 'Bolster', priceUsd: 50 },
  ];
  const models = [{
    id: 'm1', name: 'Settee', widthCm: 160, depthCm: 160, svg: '<svg/>', active: true,
    productRoot: '11111111', collection: 'Prado',
    parts: { mats: { a: 'base', b: 'cushion', c: 'cushion', d: 'bolster' }, roots: { cushion: '22222222', bolster: '33333333' } },
  }];
  const { resolvedById } = resolveTogoModels(models, products);
  const p = {
    uid: 'u1', pieceId: 'm1', x: 0, y: 0, rot: 0,
    material: { grade: 'A', fabric: 'Divina', code: 'D1', unitPrice: 1000 },
    partMaterials: { cushion: { grade: 'B', fabric: 'Steelcut', code: 'S2' } },
  };
  // MODO PIEZA — one SKU bought the lot, so the componentes are listed and
  // «Incluido». Every line is still THERE: the customer must see what the piece
  // is made of, and what fabric each part is wearing.
  const whole = placementBreakdown(p, resolvedById);
  assert.equal(whole.lines.length, 3, 'base + cushion + bolster lines');
  assert.equal(whole.lines[0].role, 'base');
  assert.equal(whole.lines[0].fabric, 'Divina');
  assert.equal(whole.lines[0].totalUsd, 1000);
  assert.equal(whole.lines[0].complete, true);
  for (const l of whole.lines.slice(1)) {
    assert.equal(l.included, true, 'a componente is bought by the piece SKU, not charged');
    assert.equal(l.totalUsd, null);
  }
  assert.equal(whole.totalUsd, 1000);
  assert.equal(whole.totalUsd, placementTotalUsd(p, resolvedById));

  // MODO COMPONENTES — the componentes carry the money and the piece's own SKU
  // carries none, flagged so the View never prints a price nobody is charged.
  const byParts = {
    ...p,
    partsMode: true,
    partMaterials: { cushion: { grade: 'B', fabric: 'Steelcut', code: 'S2' }, bolster: { grade: 'A', fabric: 'Tona', code: 'T1' } },
  };
  const { lines, totalUsd } = placementBreakdown(byParts, resolvedById);
  assert.equal(lines.length, 3, 'base + cushion + bolster lines');
  const [base, cush, bols] = lines;
  assert.equal(base.role, 'base');
  assert.equal(base.byParts, true);
  assert.equal(base.totalUsd, null, 'the model\'s own SKU is not sold in this mode');
  assert.equal(cush.qty, 1, 'the bound SKU is the SET covering both cushions');
  assert.equal(cush.unitUsd, 150);            // the picked grade B
  assert.equal(cush.totalUsd, 150);
  assert.equal(cush.fabric, 'Steelcut');
  assert.equal(cush.defaultGrade, false);
  assert.equal(cush.skuName, 'Back cushion', 'the catalog name (it says single/juego) rides the line');
  assert.equal(bols.qty, 1);
  assert.equal(bols.unitUsd, 50);
  // The itemization FOOTS to the single roll-up number every surface shows.
  const footed = lines.reduce((s, l) => s + (l.totalUsd || 0), 0);
  assert.equal(footed, totalUsd);
  assert.equal(totalUsd, placementTotalUsd(byParts, resolvedById));
  assert.equal(totalUsd, 200);

  // …and a componente still unchosen in that mode is a GAP, never «Incluido»:
  // the mode has no price at all until every one is picked.
  const gap = placementBreakdown({ ...byParts, partMaterials: { cushion: byParts.partMaterials.cushion } }, resolvedById);
  assert.equal(gap.totalUsd, null);
  assert.equal(gap.lines.find((l) => l.role === 'bolster').pending, true);

  // A model with NO tagged parts itemizes as the lone base line.
  const plain = [{ id: 'm2', name: 'Solo', widthCm: 100, depthCm: 100, svg: '<svg/>', productRoot: '11111111' }];
  const solo = placementBreakdown({ uid: 'u2', pieceId: 'm2', x: 0, y: 0, rot: 0 }, resolveTogoModels(plain, products).resolvedById);
  assert.equal(solo.lines.length, 1);
});

// ── NO-VANISH: a pick nothing can price never shrinks the money ─────────────
// Reproduced with the dealer's own catalogue (2026-08): a Large Square Settee
// whose cojines were dressed in ARDA/FR — Grade I. The cushion family 11370012
// offers A,B,D,E,U,F,G,J,K,O,Q,X,R and no I, so `partPricesFor` answered null —
// the SAME null it answers for an UNBOUND family — and every consumer read it
// as "this role doesn't bill". The Cojín line left the Resumen, its component
// left the quote seed, and the sheet totalled Cuerpo 10,895 + Rulo 575 + Cojín
// de brazo 7,300 = 18,770 for a build that is 26,070: the visitor was quoted a
// settee whose cushions nobody had priced, CHEAPER than the monocolor version
// it is supposed to be dearer than.

const NOVANISH_PRODUCTS = [
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
const NOVANISH_MODELS = [{
  id: 'settee', name: 'Large Square Settee', widthCm: 200, depthCm: 160, svg: '<svg/>', active: true,
  productRoot: '11370000', collection: 'Prado',
  parts: {
    mats: { body: 'base', cush: 'cushion', roll: 'bolster', arm: 'armCushion' },
    roots: { cushion: '11370012', bolster: '11370013', armCushion: '11370014' },
  },
}];
// MODO COMPONENTES with the cojines in ARDA/FR — the case that broke, and now
// the only mode it can happen in: modo pieza charges no componente at all, so
// no componente ladder can shrink anything there. Every componente is chosen
// (the mode requires it); the cushion's grade is the one off its own ladder.
const NOVANISH_PLACED = {
  uid: 'u1', pieceId: 'settee', x: 0, y: 0, rot: 0,
  partsMode: true,
  material: { grade: 'A', fabric: 'Tona · Écru', code: 'T1', unitPrice: 10895 },
  partMaterials: {
    cushion: { grade: 'I', fabric: 'ARDA/FR · Gris', code: 'A9' },
    bolster: { grade: 'A', fabric: 'Tona · Écru', code: 'T1' },
    armCushion: { grade: 'A', fabric: 'Tona · Écru', code: 'T1' },
  },
};

test('NO-VANISH: a part picked at a grade its SKU ladder never offered keeps its line', () => {
  const { resolvedById } = resolveTogoModels(NOVANISH_MODELS, NOVANISH_PRODUCTS);
  const r = resolvePlacement(NOVANISH_PLACED, resolvedById);
  assert.deepEqual(unresolvedPartRoles(r, NOVANISH_PLACED), ['cushion'],
    'the cushion pick is off its ladder; the unpicked rulo/brazo default to grades[0] and resolve');

  const { lines, totalUsd } = placementBreakdown(NOVANISH_PLACED, resolvedById);
  assert.deepEqual(lines.map((l) => l.role), ['base', 'cushion', 'bolster', 'armCushion'],
    'every componente the piece ships with is still on the sheet — nothing dropped out');

  const cush = lines.find((l) => l.role === 'cushion');
  assert.equal(cush.unresolved, true, 'flagged, so the View can read «sin precio»');
  assert.equal(cush.unitUsd, null);
  assert.equal(cush.totalUsd, null, 'no money on a line nobody priced');
  assert.equal(cush.included, undefined, '…and never «Incluido» — that would be a promise nobody costed');
  assert.equal(cush.fabric, 'ARDA/FR · Gris', 'the customer’s own pick is named');
  assert.equal(cush.qty, 1);
  assert.equal(cush.defaultGrade, false, 'it IS a pick — it just has no price');

  // The rest of the piece still prices normally: the gap is stated, not spread.
  // The model's own SKU carries nothing — this mode does not sell it.
  assert.equal(lines.find((l) => l.role === 'base').totalUsd, null);
  assert.equal(lines.find((l) => l.role === 'bolster').totalUsd, 575);
  assert.equal(lines.find((l) => l.role === 'armCushion').totalUsd, 7300);

  // THE TRAP, stated: the priced lines DO foot to a perfectly plausible number.
  const footed = lines.reduce((s, l) => s + (l.totalUsd || 0), 0);
  assert.equal(footed, 7875, 'a plausible number for a build nobody priced');
  assert.equal(totalUsd, null, '…which is why the placement has NO total, rather than that one');
  assert.equal(placementTotalUsd(NOVANISH_PLACED, resolvedById), null);

  // …and the build can't be handed on as a finished quote.
  const vm = resolveConfigurator([NOVANISH_PLACED], resolvedById, { scale: 1 });
  assert.equal(vm.tiles[0].unresolved, true);
  assert.equal(vm.priced, false, 'a plan carrying an unpriceable pick is never "priced"');
});

test('NO-VANISH: the quote seed keeps the componente too, at 0, naming the grade', () => {
  const { resolvedById } = resolveTogoModels(NOVANISH_MODELS, NOVANISH_PRODUCTS);
  const comps = buildTogoComponents([NOVANISH_PLACED], resolvedById, ids());
  assert.equal(comps.length, 4, 'base + cushion + bolster + armCushion — the cushion used to disappear here');
  assert.equal(comps[0].unitPrice, 0, 'modo componentes: the piece SKU carries the plan, not the money');
  const cush = comps.find((c) => c.name.startsWith('Cojín J'));
  assert.equal(cush.unitPrice, 0, 'nothing to charge — but the line is IN the quote the dealer reviews');
  assert.equal(cush.qty, 1);
  assert.equal(cush.subtype, 'Grade I — ARDA/FR · Gris', 'it says exactly what has no price yet');
  assert.equal(cush.reference, '', 'no SKU resolves at that grade');

  // An UNBOUND family is the opposite case and keeps its opposite answer: no
  // SKU at all ⇒ the part is not sold separately ⇒ no phantom row.
  const unbound = [{ ...NOVANISH_MODELS[0], id: 'nb', parts: { mats: { cush: 'cushion' }, roots: {} } }];
  const rb = resolveTogoModels(unbound, NOVANISH_PRODUCTS).resolvedById;
  assert.equal(buildTogoComponents([{ uid: 'u2', pieceId: 'nb', x: 0, y: 0, rot: 0 }], rb, ids()).length, 1);
});

test('NO-VANISH: a resolvable grade prices exactly as before, and monocolor never fails', () => {
  const { resolvedById } = resolveTogoModels(NOVANISH_MODELS, NOVANISH_PRODUCTS);
  // The same build with the cojines in a grade the ladder DOES sell: 10,895 +
  // 7,300 (cushion set at C) + 575 (rulo) + 7,300 (brazo) = 26,070 — the real
  // price of the piece the visitor was quoted 18,770 for.
  const fixed = {
    ...NOVANISH_PLACED,
    partMaterials: { ...NOVANISH_PLACED.partMaterials, cushion: { grade: 'C', fabric: 'Steppe', code: 'S2' } },
  };
  const r = resolvePlacement(fixed, resolvedById);
  assert.deepEqual(unresolvedPartRoles(r, fixed), []);
  // 7,300 (cushion set at C) + 575 (rulo) + 7,300 (brazo) = 15,175.
  assert.equal(placementTotalUsd(fixed, resolvedById), 15175);
  assert.ok(placementTotalUsd(fixed, resolvedById) > 7875, 'by-parts is DEARER than the vanished total');
  const { lines, totalUsd } = placementBreakdown(fixed, resolvedById);
  assert.equal(totalUsd, 15175);
  assert.equal(lines.reduce((s, l) => s + (l.totalUsd || 0), 0), 15175, 'still foots exactly');
  assert.ok(lines.every((l) => !l.unresolved));
  assert.equal(resolveConfigurator([fixed], resolvedById, { scale: 1 }).priced, true);

  // MODO PIEZA: the very same off-ladder grade, but the piece is sold as its own
  // SKU ⇒ the componentes bill nothing, so no componente grade can move the
  // price and there is nothing to fail.
  const mono = { ...NOVANISH_PLACED, partsMode: false };
  assert.deepEqual(unresolvedPartRoles(resolvePlacement(mono, resolvedById), mono), []);
  assert.equal(placementTotalUsd(mono, resolvedById), 10895, 'one SKU, the cheaper answer');
  const monoCush = placementBreakdown(mono, resolvedById).lines.find((l) => l.role === 'cushion');
  assert.equal(monoCush.included, true, 'listed as bought-by-the-whole-piece, not as unpriced');
  assert.equal(monoCush.unresolved, undefined);
});

// ── WHOLE-PIECE GRADE HONESTY: the same rule, on the piece's own cloth ───────
// The part fix above closed the componente ladders and left the model's OWN
// open. Measured on the dealer's live catalogue (2026-08): the Prado Large
// Square Settee's family 11370700 is priced in C, D, L, M, S and V — six grades
// — while the widget offered every one of the 55 telas the model is linked to,
// spanning seventeen. So 32 of them stored a grade that SKU has never been sold
// in, and NOTHING said so: `onPickMaterial` stamps the model's CHEAPEST grade
// whenever `productForGrade` comes back empty, so a Grade E TONA settee quoted
// at the Grade C price and read as a perfectly normal quote. Owner's rule:
// «solo deberían salir para un modelo las telas que sí le corresponden».
//
// The wall below carries ONE material per grade the real settee's wall spans,
// so the counts here are the live shape at reading size: 17 in, 6 out.
const SETTEE_LADDER = ['C', 'D', 'L', 'M', 'S', 'V'];
const WHOLEPIECE_PRODUCTS = SETTEE_LADDER.map((g, i) => ({
  reference: `11370700${g}`, name: 'Large Square Settee', priceUsd: 10895 + i * 700,
}));
// The wall the model is LINKED to (its offeredFabricKeys), grades and all.
const WHOLEPIECE_WALL = [
  { name: 'ACATE', grade: 'A' }, { name: 'SILVERTEX/FR', grade: 'B' }, { name: 'ARA', grade: 'C' },
  { name: 'CLOUD', grade: 'D' }, { name: 'TONA', grade: 'E' }, { name: 'ROMA', grade: 'F' },
  { name: 'LEO', grade: 'G' }, { name: 'PHLOX', grade: 'H' }, { name: 'ARDA/FR', grade: 'I' },
  { name: 'UNIFORM MELANGE/FR', grade: 'L' }, { name: 'GENTLE/FR', grade: 'N' },
  { name: 'BYRAM/FR', grade: 'P' }, { name: 'FLORALY', grade: 'R' },
  { name: 'ALCANTARA - A', grade: 'S' }, { name: 'INDIANA', grade: 'U' },
  { name: 'DIVA', grade: 'V' }, { name: 'KYOTO', grade: 'X' },
];
const WHOLEPIECE_MODELS = [{
  id: 'settee7', name: 'Large Square Settee', widthCm: 200, depthCm: 160, svg: '<svg/>', active: true,
  productRoot: '11370700', collection: 'Prado',
}];
// Dressed in TONA — Grade E. A real tela, offered on this model, and one its
// own SKU has never carried a price for.
const WHOLEPIECE_PLACED = {
  uid: 'w1', pieceId: 'settee7', x: 0, y: 0, rot: 0,
  // `unitPrice` is what the pick STAMPED: productForGrade(E) → nothing, so the
  // widget wrote the model's cheapest grade. This row IS the bug, frozen.
  material: { grade: 'E', fabric: 'TONA · Écru', code: 'T1', unitPrice: 10895 },
};

/** The widget's material wall, verbatim: TogoEmbed's `pickableMaterials`
 *  predicate for a WHOLE-PIECE target (a graded ladder constrains; anything
 *  else — unbound, ungraded — constrains nothing). */
const wallFor = (family, wall) => (family?.graded
  ? wall.filter((m) => {
    const prod = productForGrade(family, String(m?.grade || ''));
    return !!prod && prod.priceUsd != null;
  })
  : wall);

test('WHOLE PIECE: the wall only offers telas the targeted model’s own ladder can price', () => {
  const { resolvedById, families } = resolveTogoModels(WHOLEPIECE_MODELS, WHOLEPIECE_PRODUCTS);
  const family = families.get(resolvedById.settee7.root);
  assert.deepEqual(family.grades.slice().sort(), SETTEE_LADDER, 'the ladder under test');

  assert.equal(WHOLEPIECE_WALL.length, 17, 'every grade the model’s linked telas span');
  const offer = wallFor(family, WHOLEPIECE_WALL);
  // The offer is the ladder ∩ the wall, and it is SMALLER than both: twelve
  // tiles go (their grade isn't sold), and the ladder's own M has no linked
  // tela wearing it — exactly the live shape.
  assert.equal(offer.length, 5);
  assert.deepEqual(offer.map((m) => m.grade), ['C', 'D', 'L', 'S', 'V']);
  assert.deepEqual(offer.map((m) => m.name), ['ARA', 'CLOUD', 'UNIFORM MELANGE/FR', 'ALCANTARA - A', 'DIVA']);
  assert.ok(offer.every((m) => SETTEE_LADDER.includes(m.grade)), 'every survivor’s grade is on the ladder');
  // THE INVARIANT, not the arithmetic: what the picker OFFERS is exactly what
  // the price gate ACCEPTS. A normalization drift on either side (upper/lower
  // case, trimming, a different grade key) shows up here as a disagreement
  // rather than as builds silently reading «sin precio» in production.
  const r = resolvePlacement({ pieceId: 'settee7' }, resolvedById);
  for (const m of WHOLEPIECE_WALL) {
    const placed = { uid: 'x', pieceId: 'settee7', x: 0, y: 0, rot: 0, material: { grade: m.grade, fabric: m.name, code: 'k' } };
    assert.equal(
      offer.includes(m), !unresolvedWholePiece(r, placed),
      `${m.name} (grade ${m.grade}): the wall and the price gate must agree`,
    );
  }

  // NO-VANISH AT THE DOOR: a model with no ladder data filters NOTHING — a
  // price-as-today catalogue keeps its whole wall.
  const bare = resolveTogoModels([{ ...WHOLEPIECE_MODELS[0], id: 'bare', productRoot: null }], WHOLEPIECE_PRODUCTS);
  assert.equal(bare.resolvedById.bare.baseFamily, null);
  assert.equal(wallFor(families.get(bare.resolvedById.bare.root), WHOLEPIECE_WALL).length, 17);
  // …and a lone ungraded SKU is not a ladder either (`graded` needs two).
  const solo = resolveTogoModels(
    [{ ...WHOLEPIECE_MODELS[0], id: 'solo', productRoot: '99990000' }],
    [{ reference: '99990000A', name: 'Solo', priceUsd: 500 }],
  );
  assert.equal(wallFor(solo.families.get('99990000'), WHOLEPIECE_WALL).length, 17);
});

test('WHOLE PIECE: a stored off-ladder pick prices NOTHING — never the model’s cheapest grade', () => {
  const { resolvedById } = resolveTogoModels(WHOLEPIECE_MODELS, WHOLEPIECE_PRODUCTS);
  const r = resolvePlacement(WHOLEPIECE_PLACED, resolvedById);
  assert.equal(unresolvedWholePiece(r, WHOLEPIECE_PLACED), true);
  assert.deepEqual(unresolvedPartRoles(r, WHOLEPIECE_PLACED), [], 'the PART axis is clean — this is the piece’s own cloth');

  // THE TRAP, stated: the stamped price is a real, plausible, WRONG number.
  assert.equal(r.unitPrice, 10895, 'the model’s cheapest grade, wearing Grade E’s name');
  assert.equal(placementTotalUsd(WHOLEPIECE_PLACED, resolvedById), null, 'so the piece has NO price, rather than that one');

  const { lines, totalUsd } = placementBreakdown(WHOLEPIECE_PLACED, resolvedById);
  assert.equal(lines.length, 1);
  const base = lines[0];
  assert.equal(base.role, 'base');
  assert.equal(base.unresolved, true, 'flagged, so the View reads «sin precio»');
  assert.equal(base.unitUsd, null);
  assert.equal(base.totalUsd, null);
  assert.equal(base.complete, undefined, 'and never «Elemento completo» — nothing costed it');
  assert.equal(base.fabric, 'TONA · Écru', 'the customer’s own pick is still named');
  assert.equal(base.defaultGrade, false, 'it IS a pick — it just has no price');
  assert.equal(totalUsd, null);

  // The quote seed keeps the module too — at 0, its subtype naming the grade —
  // and the build can't be handed on as a finished quote.
  const comps = buildTogoComponents([WHOLEPIECE_PLACED], resolvedById, ids());
  assert.equal(comps.length, 1, 'the module never leaves the seed');
  assert.equal(comps[0].unitPrice, 0, 'nothing to charge — but nothing invented either');
  const vm = resolveConfigurator([WHOLEPIECE_PLACED], resolvedById, { scale: 1 });
  assert.equal(vm.tiles[0].unresolved, true);
  assert.equal(vm.priced, false, 'a plan carrying an unpriceable piece is never "priced"');
});

test('WHOLE PIECE: an on-ladder grade prices exactly as before, and no pick at all is never gated', () => {
  const { resolvedById } = resolveTogoModels(WHOLEPIECE_MODELS, WHOLEPIECE_PRODUCTS);
  // Grade D — on the ladder. 10895 + 1×700 = 11595, byte for byte what it was.
  const ok = { ...WHOLEPIECE_PLACED, material: { grade: 'D', fabric: 'CLOUD', code: 'C1', unitPrice: 11595 } };
  assert.equal(unresolvedWholePiece(resolvePlacement(ok, resolvedById), ok), false);
  assert.equal(placementTotalUsd(ok, resolvedById), 11595);
  const okLines = placementBreakdown(ok, resolvedById).lines;
  assert.equal(okLines[0].totalUsd, 11595);
  assert.equal(okLines[0].unresolved, undefined);
  assert.equal(buildTogoComponents([ok], resolvedById, ids())[0].unitPrice, 11595);
  assert.equal(resolveConfigurator([ok], resolvedById, { scale: 1 }).priced, true);

  // «TELA DE LA PIEZA» — no pick at all. The sticker price is the family's
  // cheapest grade by documented convention; it resolves by construction and
  // is not a lie about anything the visitor chose, so the gate never fires.
  const bare = { uid: 'w2', pieceId: 'settee7', x: 0, y: 0, rot: 0 };
  assert.equal(unresolvedWholePiece(resolvePlacement(bare, resolvedById), bare), false);
  assert.equal(placementTotalUsd(bare, resolvedById), 10895);

  // A model with NO ladder is untouched too: nothing to be off.
  const noFam = resolveTogoModels([{ ...WHOLEPIECE_MODELS[0], id: 'nf', productRoot: null }], WHOLEPIECE_PRODUCTS);
  const wild = { uid: 'w3', pieceId: 'nf', x: 0, y: 0, rot: 0, material: { grade: 'Z', fabric: 'X', code: 'z', unitPrice: 999 } };
  assert.equal(unresolvedWholePiece(resolvePlacement(wild, noFam.resolvedById), wild), false);
  assert.equal(placementTotalUsd(wild, noFam.resolvedById), 999, 'prices exactly as today');
});

// ── Materialization zones (Prado ottomans): ONE graded SKU, mono/bicolor ──

test('ottoman zones: bicolor re-grades the base SKU (dearest zone wins) and never bills a part line', () => {
  const products = [
    { reference: '11370200A', name: 'Prado small square ottoman', priceUsd: 3145 },
    { reference: '11370200C', name: 'Prado small square ottoman', priceUsd: 3460 },
    { reference: '11370200F', name: 'Prado small square ottoman', priceUsd: 3785 },
  ];
  const models = [{
    id: 'ott', name: 'Small Square Ottoman', widthCm: 105, depthCm: 120, svg: '<svg/>', active: true,
    productRoot: '11370200', collection: 'Prado',
    parts: { mats: { body: 'exterior', plinth: 'interior' } },
  }];
  const { resolvedById } = resolveTogoModels(models, products);
  const r = resolvedById.ott;
  assert.equal(r.unitPrice, 3145, 'sticker = cheapest grade');
  assert.equal(r.partFamilies, null, 'zones bind no SKU family of their own');
  assert.ok(r.baseFamily, 'the model’s own family rides for zone re-grading');

  // MONOCOLOR (no zone picks): the base pick prices as always.
  const mono = { uid: 'u1', pieceId: 'ott', x: 0, y: 0, rot: 0, material: { grade: 'A', fabric: 'Tona', code: 'T1', unitPrice: 3145 } };
  assert.equal(placementTotalUsd(mono, resolvedById), 3145);

  // BICOLOR: exterior stays A, interior picks the dearer F → the ONE SKU
  // re-grades to F (LR's two-tone rule: the piece prices at its most
  // expensive fabric). No extra line ever appears.
  const bi = { ...mono, partMaterials: { interior: { grade: 'F', fabric: 'Alcantara', code: 'AL1' } } };
  assert.equal(placementTotalUsd(bi, resolvedById), 3785);
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

  // The quote line: ONE component, priced + referenced at the re-graded SKU,
  // with the zone picks snapshotted in the plan for the 3D replay.
  let n = 0;
  const comps = buildTogoComponents([bi], resolvedById, () => `id${n++}`);
  assert.equal(comps.length, 1, 'zones add no components');
  assert.equal(comps[0].unitPrice, 3785);
  assert.equal(comps[0].reference, '11370200F', 'the factory-invoiced SKU is the dearest grade');
  assert.deepEqual(comps[0].plan.partMaterials.interior, { grade: 'F', fabric: 'Alcantara', code: 'AL1' });
  assert.equal(compoundSubtotal({ components: comps }), 3785);

  // A dearer BASE pick beats a cheaper zone: max, not last-write.
  const baseC = { ...bi, material: { grade: 'C', fabric: 'Tona', code: 'T1', unitPrice: 3460 }, partMaterials: { interior: { grade: 'A', fabric: 'Alc', code: 'A1' } } };
  assert.equal(placementTotalUsd(baseC, resolvedById), 3460);

  // NO-VANISH, the zone flavour: a zone bills no line, so an off-ladder zone
  // pick can't drop one — it just gets IGNORED, leaving the piece at its
  // cheaper grade. Same lie, quieter voice: the dearest-zone rule silently
  // didn't run, and nobody said so.
  const badZone = { ...mono, partMaterials: { interior: { grade: 'I', fabric: 'ARDA/FR', code: 'A9' } } };
  assert.deepEqual(unresolvedPartRoles(resolvePlacement(badZone, resolvedById), badZone), ['interior']);
  assert.equal(placementTotalUsd(badZone, resolvedById), null, 'not 3145 — that is the base pretending to be the piece');
  const badLines = placementBreakdown(badZone, resolvedById).lines;
  const inner = badLines.find((l) => l.role === 'interior');
  assert.equal(inner.unresolved, true);
  assert.equal(inner.included, undefined, 'a zone the SKU can’t re-grade is not "incluido"');
  assert.equal(inner.fabric, 'ARDA/FR', 'the pick still shows — it never leaves the sheet');
  assert.equal(badLines.find((l) => l.role === 'exterior').included, true, 'the resolvable zone is untouched');
});

// ── The embed launch card's hero ────────────────────────────────────────────
// The card that renders inside alcover.do presents a real Togo turning in a
// real fabric, so BOTH halves come out of the same public catalog the visitor
// is about to configure with. What's pinned here is that it can never present
// something that isn't there: a piece with no mesh, or a fabric that left the
// price list, degrades to the drawn silhouette instead of a broken hero.
const HERO_MODELS = [
  { id: 'ott', name: 'Togo Ottoman', widthCm: 100, depthCm: 100, collection: 'Togo', mesh: { url: 'ott.fbx' } },
  { id: 'gb', name: 'Togo Grand Canapé', widthCm: 174, depthCm: 102, collection: 'Togo', mesh: { url: 'gb.fbx' } },
  { id: 'a', name: 'Togo Corner', widthCm: 102, depthCm: 102, collection: 'Togo', mesh: { url: 'a.fbx' } },
];
const HERO_MATERIALS = [
  { name: 'Tona', grade: 'A', colors: [{ name: 'Ivoire', code: 'T1' }] },
  { name: 'Festa', grade: 'C', colors: [{ name: 'Rouge', code: 'F9' }, { name: 'Bleu Paon', code: 'F41', rgb: '#1f5c6e' }] },
];

test('the launch hero is the catalogue headline piece, in Festa Bleu Paon', () => {
  const hero = resolveLaunchHero(HERO_MODELS, HERO_MATERIALS);
  assert.ok(hero, 'a mesh-backed catalogue yields a hero');
  assert.equal(hero.model.id, 'gb', 'a full sofa is the shop window — never the ottoman that happens to sort first');
  assert.equal(hero.fabric.code, 'F41');
  assert.equal(hero.fabric.materialName, 'Festa');
  assert.equal(hero.fabric.colorName, 'Bleu Paon');
  assert.equal(hero.fabric.label, 'Festa · Bleu Paon (#F41)');

  // The scene is a one-piece resolveTogoScene result the turntable renders
  // as-is: centred, unrotated (the turntable owns the spin), wearing the code.
  assert.equal(hero.scene.count, 1);
  const [piece] = hero.scene.pieces;
  assert.equal(piece.fabricCode, 'F41');
  assert.equal(piece.rotationDeg, 0, 'a default spawn rotation would cock the hero off-axis');
  assert.deepEqual([piece.x, piece.z], [0, 0], 'centred on the turntable axis');
  assert.equal(piece.mesh.url, 'gb.fbx', 'the REAL model, not the procedural fallback');
});

test('the launch hero is not tied to one collection', () => {
  // The live catalogue's hero is Noka's «Sofa» (owner-approved) sitting beside
  // the Togo line — a plain name, no collection hint, competing with pieces
  // whose names read more "iconic". It has to keep winning.
  const mixed = [
    { id: 'togo-a', name: 'Togo Sillón', widthCm: 102, depthCm: 102, collection: 'Togo', mesh: { url: 'a.fbx' } },
    { id: 'noka', name: 'Sofa', widthCm: 240, depthCm: 98, collection: 'Noka', mesh: { url: 'noka.fbx' } },
    { id: 'togo-p', name: 'Togo Ottoman', widthCm: 100, depthCm: 100, collection: 'Togo', mesh: { url: 'p.fbx' } },
  ];
  const hero = resolveLaunchHero(mixed, HERO_MATERIALS);
  assert.equal(hero.model.id, 'noka');
  assert.equal(hero.model.collection, 'Noka');
  assert.equal(hero.scene.pieces[0].collection, 'Noka', 'the collection rides through to the 3D seam fit');
});

test('the hero fabric matches through the /FR fire-retardant suffix', () => {
  // The dealer's catalogue carries it as «Festa/FR»; fabricKey folds the
  // suffix, which is the only reason the live card is upholstered at all.
  const fr = [{ name: 'Festa/FR', grade: 'C', colors: [{ name: 'Bleu Paon', code: 'F41' }] }];
  assert.equal(resolveLaunchHero(HERO_MODELS, fr).fabric.code, 'F41');
});

test('the launch hero matches its fabric by name, not by spelling', () => {
  // The dealer owns these strings in Materiales — case, accents and separators
  // drift, and a rename must not silently blank the card.
  const shouty = [{ name: 'FESTA', grade: 'C', colors: [{ name: 'BLEU-PAON', code: 'F41' }] }];
  assert.equal(resolveLaunchHero(HERO_MODELS, shouty).fabric.code, 'F41');
});

test('the launch hero degrades rather than showing something that is not there', () => {
  // No catalog yet (the card paints before the fetch lands) → no hero at all.
  assert.equal(resolveLaunchHero([], []), null);
  assert.equal(resolveLaunchHero(null, null), null);

  // Drawn-only pieces would put a procedural blob on the dealer's home page.
  const noMesh = HERO_MODELS.map(({ mesh, ...m }) => ({ ...m, svg: '<svg/>' }));
  assert.equal(resolveLaunchHero(noMesh, HERO_MATERIALS), null);

  // Festa off the price list → the piece still turns, in the default body; the
  // caption just has nothing to name. Losing a fabric never loses the hero.
  const noFesta = resolveLaunchHero(HERO_MODELS, [HERO_MATERIALS[0]]);
  assert.ok(noFesta, 'a missing fabric is not a missing hero');
  assert.equal(noFesta.fabric, null);
  assert.equal(noFesta.scene.pieces[0].fabricCode, '');

  // A colour with no CODE can't be upholstered — the code is what resolves both
  // the swatch tone and the pCon texture — so it reads as no fabric at all.
  const codeless = [{ name: 'Festa', grade: 'C', colors: [{ name: 'Bleu Paon', code: '' }] }];
  assert.equal(resolveLaunchHero(HERO_MODELS, codeless).fabric, null);
});

// ── The collection INDEX (step one of the two-step browse) ──────────────────
// Ten collections as text chips read as debug chrome, so step one shows each
// collection as its hero PIECE. What's pinned: the dealer's catalogue order is
// the menu order, the hero is the collection's headline piece (not whichever
// row happens to come first), and the money is the cheapest real price.
test('the collection index keeps catalogue order and picks each hero', () => {
  const models = [
    // Togo, deliberately with the ottoman FIRST — the sofa must still front it.
    { id: 't-p', name: 'Togo Ottoman', widthCm: 100, depthCm: 100, collection: 'Togo', priceUsd: 1740 },
    { id: 't-gb', name: 'Togo Grand Canapé', widthCm: 174, depthCm: 102, collection: 'Togo', priceUsd: 4890 },
    { id: 'k-a', name: 'Kashima Sillón', widthCm: 102, depthCm: 102, collection: 'Kashima', priceUsd: 2980 },
    { id: 'n-s', name: 'Sofa', widthCm: 240, depthCm: 98, collection: 'Noka', priceUsd: 6900 },
  ];
  const menu = resolveCollectionMenu(models);
  assert.deepEqual(menu.map((e) => e.collection), ['Togo', 'Kashima', 'Noka'],
    'palette order — first appearance wins, never alphabetical');
  assert.equal(menu[0].hero.id, 't-gb', 'the canapé fronts Togo, not the ottoman that sorts first');
  assert.equal(menu[0].count, 2);
  assert.equal(menu[0].fromUsd, 1740, 'the CHEAPEST piece sets "desde", not the hero');
  assert.equal(menu[1].hero.id, 'k-a', 'a one-piece collection is fronted by that piece');
  assert.equal(menu[2].hero.id, 'n-s');
});

test('the collection index survives a catalogue with no prices', () => {
  // pricingMode 'hidden' strips every priceUsd to null; the menu still renders,
  // it just has no money to show (a 0 would read as free).
  const menu = resolveCollectionMenu([
    { id: 'a', name: 'Togo Sofa', widthCm: 174, depthCm: 102, collection: 'Togo', priceUsd: null },
    { id: 'b', name: 'Togo Sillón', widthCm: 102, depthCm: 102, collection: 'Togo', priceUsd: 0 },
  ]);
  assert.equal(menu.length, 1);
  assert.equal(menu[0].fromUsd, null, 'no priced piece ⇒ no "desde", never $0');
  assert.equal(menu[0].count, 2);
});

test('the collection index files legacy collection-less pieces under Togo', () => {
  // Rows predating the collection column read as Togo everywhere else in the
  // configurator; the menu must not open a blank-named collection beside it.
  const menu = resolveCollectionMenu([
    { id: 'old', name: 'Togo Sofa', widthCm: 174, depthCm: 102, collection: null, priceUsd: 4000 },
    { id: 'new', name: 'Togo Sillón', widthCm: 102, depthCm: 102, collection: 'Togo', priceUsd: 2000 },
  ]);
  assert.deepEqual(menu.map((e) => e.collection), ['Togo']);
  assert.equal(menu[0].count, 2);
  assert.equal(resolveCollectionMenu([]).length, 0);
  assert.equal(resolveCollectionMenu(null).length, 0);
});

/* ── PORTADAS — the dealer's own cover per collection ────────────────────────
 * The piece and the cloth were both derived, and derived is exactly what a shop
 * window should not be stuck with. What must survive the override is the rule
 * the automatic version already had: the index can only ever show something the
 * visitor can then go and build. So a pin is VALIDATED, per half, against the
 * live catalogue — never trusted because it was saved.
 * ──────────────────────────────────────────────────────────────────────────── */

const PIN_MODELS = [
  { id: 't-p', name: 'Togo Ottoman', widthCm: 100, depthCm: 100, collection: 'Togo', priceUsd: 1740 },
  { id: 't-gb', name: 'Togo Grand Canapé', widthCm: 174, depthCm: 102, collection: 'Togo', priceUsd: 4890 },
  { id: 'k-a', name: 'Kashima Sillón', widthCm: 102, depthCm: 102, collection: 'Kashima', priceUsd: 2980 },
];
const PIN_MATERIALS = [
  { name: 'FESTA', colors: [
    { code: '855', name: 'ANIS', rgb: '#7f9c2a' },
    { code: '4479', name: 'BLEU PAON', rgb: '#1f6f8b' },
    { code: '110', name: 'ECRU', rgb: '#e8e2d6' },
  ] },
];

test('a pinned cover wins over the ranking — per half, and only while it is real', () => {
  const pinned = resolveCollectionMenu(PIN_MODELS, PIN_MATERIALS, {
    Togo: { modelId: 't-p', code: '110' },
  });
  assert.equal(pinned[0].hero.id, 't-p', 'the dealer outranks the name ranking');
  assert.equal(pinned[0].fabric.code, '110');
  assert.equal(pinned[0].pinned, true);
  assert.equal(pinned[1].pinned, false, 'a collection nobody pinned still derives');

  // HALF a pin is a pin: the other half keeps deriving rather than blanking.
  const clothOnly = resolveCollectionMenu(PIN_MODELS, PIN_MATERIALS, { Togo: { code: '855' } });
  assert.equal(clothOnly[0].hero.id, 't-gb', 'no piece pinned ⇒ the canapé still fronts Togo');
  assert.equal(clothOnly[0].fabric.code, '855');

  // A STALE pin must never put something unbuildable on the index — the piece
  // moved to another collection, was deactivated, or the cloth left the price
  // list. Each half falls back on its own.
  const stale = resolveCollectionMenu(PIN_MODELS, PIN_MATERIALS, {
    Togo: { modelId: 'k-a', code: '9999' },   // a Kashima piece + a dead code
  });
  assert.equal(stale[0].hero.id, 't-gb', 'a piece that is not in this collection cannot front it');
  assert.ok(stale[0].fabric && stale[0].fabric.code !== '9999', 'an unrenderable code falls back to the palette');

  // The pinned bolt is CLAIMED before anything is auto-assigned, so no
  // automatic collection can take the cloth a pinned one was told to wear.
  const shared = resolveCollectionMenu(PIN_MODELS, PIN_MATERIALS, { Kashima: { code: '855' } });
  assert.equal(shared[1].fabric.code, '855');
  assert.notEqual(shared[0].fabric.code, '855', 'Togo must not be auto-given Kashima\'s pinned bolt');

  // No map at all is exactly today's behaviour.
  assert.deepEqual(
    resolveCollectionMenu(PIN_MODELS, PIN_MATERIALS, null).map((e) => e.hero.id),
    resolveCollectionMenu(PIN_MODELS, PIN_MATERIALS).map((e) => e.hero.id),
  );
});

test('buildFabricByCode: ONE descriptor, because it is part of a baked picture\'s stamp', () => {
  // The studio bakes each piece dressed in its collection's cloth and the widget
  // decides whether that photo is still valid by rebuilding its store key —
  // which includes this descriptor. So the interesting property is that the
  // descriptor is a pure function of the catalogue: same materials in, same
  // object out, on both sides of the app.
  const materials = [{
    name: 'FESTA',
    colors: [
      { code: '855', name: 'ANIS', rgb: '#7f9c2a', textureUrl: 'https://cdn/w.webp', normalUrl: 'https://cdn/n.webp', rough: 0.7, tileCm: 12 },
      { code: '4479', name: 'BLEU PAON', rgb: '#1f6f8b', rough: 0.5 },   // no scan of its own
      { code: '110', name: 'ECRU' },                                      // neither scan nor rgb
    ],
  }];
  const map = buildFabricByCode(materials);
  assert.deepEqual(map['855'], {
    textureUrl: 'https://cdn/w.webp', normalUrl: 'https://cdn/n.webp', rgb: '#7f9c2a',
    pbr: { dif: null, rough: 0.7, spec: null, tileCm: 12, tileCmY: null },
  });

  // FAMILY FALLBACK: every colour of a material shares one physical weave, so a
  // colour with no scan borrows a sibling's and is re-tinted to its own tone.
  // Its OWN .mat values win where present, and the sibling's diffuse multiplier
  // never rides along — the tint bake already carries this colour's tone, and
  // applying the sibling's on top would dye it twice.
  assert.equal(map['4479'].textureUrl, 'https://cdn/w.webp');
  assert.equal(map['4479'].tint, true);
  assert.equal(map['4479'].rgb, '#1f6f8b');
  assert.equal(map['4479'].pbr.dif, null);
  assert.equal(map['4479'].pbr.rough, 0.5, 'its own roughness wins');
  assert.equal(map['4479'].pbr.tileCm, 12, 'the family\'s tile size fills in');

  // A colour that can be neither woven nor tinted gets NO entry: the renderer's
  // own fallback beats a descriptor that describes nothing.
  assert.equal(map['110'].textureUrl, 'https://cdn/w.webp', 'it still borrows the family weave');
  assert.deepEqual(buildFabricByCode([{ name: 'X', colors: [{ code: 'z' }] }]), {});
  assert.deepEqual(buildFabricByCode(null), {});

  // Deterministic — the stamp is only stable if this is.
  assert.deepEqual(buildFabricByCode(materials), map);
});

test('planHeroPin: one encoding per state — nothing pinned is NO entry', () => {
  const one = planHeroPin(null, 'Togo', { modelId: 't-p' });
  assert.deepEqual(one, { Togo: { modelId: 't-p' } });

  // Each half sets independently and MERGES with what is already there.
  const both = planHeroPin(one, 'Togo', { code: '855' });
  assert.deepEqual(both, { Togo: { modelId: 't-p', code: '855' } });

  // null CLEARS that half back to derived…
  assert.deepEqual(planHeroPin(both, 'Togo', { code: null }), { Togo: { modelId: 't-p' } });
  // …and clearing the last one drops the collection, then the whole map: an
  // empty entry and no entry would be two ways to say the same thing.
  assert.deepEqual(planHeroPin({ Togo: { code: '855' } }, 'Togo', { code: null }), null);
  assert.deepEqual(
    planHeroPin({ Togo: { code: '855' }, Kashima: { code: '110' } }, 'Togo', { code: null }),
    { Kashima: { code: '110' } },
  );

  // Legacy collection-less pieces file under Togo everywhere else in the
  // configurator, and a pin must land on the key the INDEX will look up — so it
  // canonicalizes the same way rather than minting a blank-named collection
  // nothing would ever match.
  assert.deepEqual(planHeroPin(null, null, { modelId: 'x' }), { Togo: { modelId: 'x' } });
  assert.deepEqual(planHeroPin(null, '', { modelId: 'x' }), { Togo: { modelId: 'x' } });
});

// ── The collection index's FABRICS ──────────────────────────────────────────
// Every hero used to render in the same default body, so ten collections read
// as ten photocopies. Each now wears a different real cloth. What's pinned is
// the part that can silently rot: the pick must be DETERMINISTIC (the render
// cache is keyed by fabric code — a pick that reshuffled per mount would
// re-render the whole index every time it opened and never hit the cache) and
// it must prefer cloth that actually looks like something.
const MENU_MODELS = [
  { id: 't', name: 'Togo Sofa', widthCm: 174, depthCm: 102, collection: 'Togo', priceUsd: 4000 },
  { id: 'p', name: 'Prado Sofa', widthCm: 200, depthCm: 100, collection: 'Prado', priceUsd: 5000 },
  { id: 'k', name: 'Kashima Sofa', widthCm: 180, depthCm: 100, collection: 'Kashima', priceUsd: 4500 },
  { id: 'n', name: 'Noka Sofa', widthCm: 240, depthCm: 98, collection: 'Noka', priceUsd: 6900 },
];
const MENU_MATERIALS = [
  { name: 'Festa', colors: [
    { name: 'Bleu Paon', code: 'F41', rgb: '#1f5c6e' }, { name: 'Rouge', code: 'F09', rgb: '#8f2f2a' },
    { name: 'Ocre', code: 'F17', rgb: '#b8862f' }, { name: 'Vert', code: 'F33', rgb: '#3f5c34' } ] },
];

test('each collection wears a different fabric, and the same one every time', () => {
  const a = resolveCollectionMenu(MENU_MODELS, MENU_MATERIALS);
  const codes = a.map((e) => e.fabric?.code);
  assert.equal(codes.filter(Boolean).length, 4, 'every collection gets cloth');
  assert.equal(new Set(codes).size, 4, 'and no two adjacent collections share a bolt');

  // DETERMINISM — the render cache and the shop window both depend on it.
  const b = resolveCollectionMenu(MENU_MODELS, MENU_MATERIALS);
  assert.deepEqual(b.map((e) => e.fabric.code), codes, 'same catalogue ⇒ same picks');
  // Keyed on the NAME, not on position: reordering the catalogue must not
  // repaint a collection that didn't change.
  const moved = resolveCollectionMenu([MENU_MODELS[0], MENU_MODELS[1]], MENU_MATERIALS);
  assert.equal(moved[0].fabric.code, codes[0], 'Togo keeps its cloth when the list shrinks');
});

test('the index prefers cloth with real colour, and survives having none', () => {
  // A catalogue of near-neutrals still dresses the heroes — "prefer saturated"
  // must not mean "show nothing when everything is oatmeal".
  const dull = [{ name: 'Tona', colors: [
    { name: 'Ivoire', code: 'T01', rgb: '#efe9dd' }, { name: 'Gris', code: 'T02', rgb: '#d8d8d6' },
    { name: 'Crème', code: 'T03', rgb: '#e8e4da' }, { name: 'Sable', code: 'T04', rgb: '#ded7c8' } ] }];
  const neutral = resolveCollectionMenu(MENU_MODELS, dull);
  assert.equal(neutral.filter((e) => e.fabric).length, 4, 'neutrals are used when there is nothing else');

  // A TEXTURED colour outranks a merely-coloured one: a real scanned weave is
  // what makes the tile read as fabric rather than as a tinted blob.
  const mixed = [{ name: 'Mix', colors: [
    { name: 'Flat', code: 'X1', rgb: '#8f2f2a' },
    { name: 'Woven', code: 'X2', rgb: '#3f5c34', textureUrl: 'https://x/weave.jpg' } ] }];
  assert.equal(resolveCollectionMenu([MENU_MODELS[0]], mixed)[0].fabric.code, 'X2');

  // A colour that can't be rendered at all (no texture, no rgb) is never picked,
  // and a catalogue of only those leaves the default body rather than a blank.
  const unusable = [{ name: 'Ghost', colors: [{ name: 'Nada', code: 'Z1' }] }];
  assert.equal(resolveCollectionMenu([MENU_MODELS[0]], unusable)[0].fabric, null);
  assert.equal(resolveCollectionMenu(MENU_MODELS)[0].fabric, null, 'no materials ⇒ no cloth, no crash');
});

test('a hero is never dressed in cloth too dark to read as a shape', () => {
  // The index tile is a small render on a WHITE page: below a brightness floor
  // the piece is a silhouette, not furniture (the catalogue's near-black prune
  // did exactly this). A dark bolt loses to ANY legible one — even a duller,
  // less saturated one — because legibility outranks vividness on a tile.
  const dark = [{ name: 'Mix', colors: [
    { name: 'Nuit', code: 'D1', rgb: '#120c14' },        // near-black, very saturated
    { name: 'Sable', code: 'D2', rgb: '#ded7c8' } ] }];  // pale neutral
  assert.equal(resolveCollectionMenu([MENU_MODELS[0]], dark)[0].fabric.code, 'D2');

  // Legibility does NOT outrank the weave: a scanned texture with no rgb is
  // unreadable-as-a-hex, and it's the texture the tile shows, so it still wins.
  const woven = [{ name: 'Mix', colors: [
    { name: 'Scan', code: 'W1', textureUrl: 'https://x/w.jpg' },
    { name: 'Sable', code: 'W2', rgb: '#ded7c8' } ] }];
  assert.equal(resolveCollectionMenu([MENU_MODELS[0]], woven)[0].fabric.code, 'W1');

  // But a catalogue that sells nothing BUT dark cloth still dresses its heroes —
  // the floor picks a better bolt when there is one, it never blanks the tile.
  const allDark = [{ name: 'Nuit', colors: [
    { name: 'Encre', code: 'N1', rgb: '#0f1420' }, { name: 'Prune', code: 'N2', rgb: '#1b0f18' } ] }];
  const dressed = resolveCollectionMenu([MENU_MODELS[0], MENU_MODELS[1]], allDark);
  assert.equal(dressed.filter((e) => e.fabric).length, 2, 'dark-only catalogue still renders cloth');
  assert.notEqual(dressed[0].fabric.code, dressed[1].fabric.code, 'and still spreads them');
});

// ── palette order (planTogoReorder) ─────────────────────────────────────────
// The order the dealer arranges in the Modelos list IS what the customer sees
// in the configurator, so the planner is shared by the arrows (toIndex ± 1) and
// by drag (toIndex = the drop slot) — one meaning, one implementation.

const ORDER_ROWS = [
  { id: 'a', name: 'Sofa', collection: null, sortOrder: 0 },
  { id: 'b', name: 'Loveseat', collection: null, sortOrder: 1 },
  { id: 'c', name: 'Ottoman', collection: null, sortOrder: 2 },
  { id: 'd', name: 'Chair', collection: 'Prado', sortOrder: 3 },
  { id: 'e', name: 'Bench', collection: 'Prado', sortOrder: 4 },
];
const orderOf = (rows) => resolveTogoModelCards(rows, []).map((c) => c.id).join('');
const applyWrites = (rows, writes) => rows.map((r) => {
  const w = writes.find((x) => x.id === r.id);
  return w ? { ...r, sortOrder: w.sortOrder } : r;
});

test('planTogoReorder moves a piece within its collection, writing only what moved', () => {
  const cards = resolveTogoModelCards(ORDER_ROWS, []);
  const writes = planTogoReorder(cards, { id: 'a', toIndex: 1 });
  assert.equal(writes.length, 2, 'a neighbour swap on a tidy list is exactly two writes');
  assert.equal(orderOf(applyWrites(ORDER_ROWS, writes)), 'bacde');
});

test('planTogoReorder drops a piece at an arbitrary index (drag), not just one slot', () => {
  const cards = resolveTogoModelCards(ORDER_ROWS, []);
  assert.equal(orderOf(applyWrites(ORDER_ROWS, planTogoReorder(cards, { id: 'a', toIndex: 2 }))), 'bcade');
  assert.equal(orderOf(applyWrites(ORDER_ROWS, planTogoReorder(cards, { id: 'c', toIndex: 0 }))), 'cabde');
});

test('planTogoReorder never moves a piece out of its collection', () => {
  const cards = resolveTogoModelCards(ORDER_ROWS, []);
  // 'e' is last of Prado; dragging past the end clamps inside the group, and the
  // other collection keeps its own order.
  const after = applyWrites(ORDER_ROWS, planTogoReorder(cards, { id: 'e', toIndex: 9 }));
  assert.equal(orderOf(after), 'abcde');
  const up = applyWrites(ORDER_ROWS, planTogoReorder(cards, { id: 'e', toIndex: 0 }));
  assert.equal(orderOf(up), 'abced', 'Prado reorders; the legacy Togo group is untouched');
});

test('planTogoReorder defragments legacy ties instead of wedging on them', () => {
  // Every row shipped with sort_order 0 before the palette had an order, and a
  // collection retag interleaves the numbering — a swap has to survive both.
  const zeros = ORDER_ROWS.map((r) => ({ ...r, sortOrder: 0 }));
  const cards = resolveTogoModelCards(zeros, []);
  const first = cards.filter((c) => c.collection === 'Togo')[0];
  const writes = planTogoReorder(cards, { id: first.id, toIndex: 1 });
  const after = resolveTogoModelCards(applyWrites(zeros, writes), []);
  const togo = after.filter((c) => c.collection === 'Togo').map((c) => c.id);
  assert.equal(togo[1], first.id, 'the moved piece really lands in slot 2');
  assert.deepEqual(
    after.map((c) => c.sortOrder), [0, 1, 2, 3, 4],
    'and the whole list comes out gapless, so the NEXT move is a clean two writes',
  );
});

test('planTogoReorder is a no-op when nothing moves', () => {
  const cards = resolveTogoModelCards(ORDER_ROWS, []);
  assert.deepEqual(planTogoReorder(cards, { id: 'a', toIndex: 0 }), []);
  assert.deepEqual(planTogoReorder(cards, { id: 'nope', toIndex: 2 }), []);
  assert.deepEqual(planTogoReorder(cards, {}), []);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE LEAD'S COMPOSITION SNAPSHOT — the picture of what the customer actually
 * built, captured from the 3D scene at submit and stored as the request's
 * image (the Solicitudes card, and the quote line it becomes).
 *
 * It shipped BROKEN and looked fine from every angle: the thumbnail pipeline
 * was moved to `URL.createObjectURL` (correct — an on-screen thumbnail should
 * not be a 120 KB base64 string), and the submit path inherited it. An object
 * URL is a HANDLE into one browser tab: ~55 characters of
 * `blob:https://host/uuid` that sailed through a length gate written for
 * base64, POSTed as a perfectly valid string, and decoded server-side to
 * nothing. Every lead stored a null image. The internal dealer view kept
 * working (it re-fetches the blob in the same tab), so nothing looked wrong.
 *
 * So the pin is the WIRE, not the encoder: what the browser is willing to send
 * has to be what the Edge Function is able to read.
 * ──────────────────────────────────────────────────────────────────────────── */

// A real 1×1 PNG (the magic bytes matter — the decoder checks them).
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngDataUrl = (b64 = PNG_1PX) => `data:image/png;base64,${b64}`;
// What the browser actually hands the encoder: a canvas is just an object with
// a toDataURL. No GPU, no DOM — the seam is pure so the wire shape is testable.
const fakeCanvas = (out) => ({ toDataURL: typeof out === 'function' ? out : () => out });

test('the lead snapshot the widget encodes decodes under the SERVER\'s own decoder', () => {
  const url = canvasPngDataUrl(fakeCanvas(pngDataUrl()));
  assert.ok(url, 'the encoder produced nothing');
  const bytes = snapshotBytesFromDataUrl(snapshotFieldFor(url));
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, 'the server could not read what the browser sent');
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic — the stored image is a real picture');
});

test('a blob: object URL is refused at BOTH gates — the shape that emptied every lead', () => {
  // Exactly what `URL.createObjectURL` hands back, length and all.
  const objectUrl = 'blob:https://alcover.do/9f1c7e2a-1c4b-4d0e-9b2f-4a1f00000001';
  assert.ok(objectUrl.length < 100, 'an object URL is a handle, not an image — it costs nothing to send');
  assert.equal(canvasPngDataUrl(fakeCanvas(objectUrl)), null, 'the encoder never passes a handle off as a snapshot');
  assert.equal(snapshotFieldFor(objectUrl), null, 'the browser gate refuses it BEFORE the network');
  assert.equal(snapshotBytesFromDataUrl(objectUrl), null, 'and the server was never able to read one');
});

test('the browser gate accepts exactly the envelope the Edge Function decodes', () => {
  // [what it is, the string, does it reach the server as bytes?]
  const SHAPES = [
    ['a PNG data URL', pngDataUrl(), true],
    ['a blob: object URL', 'blob:https://alcover.do/9f1c7e2a-1c4b-4d0e', false],
    ['an https: URL', 'https://cdn.alcover.do/togosnap-abc.png', false],
    ['a JPEG data URL', `data:image/jpeg;base64,${PNG_1PX}`, false],
    ['a data URL with no media type', `data:;base64,${PNG_1PX}`, false],
    ['an empty payload', 'data:image/png;base64,', false],
    ['a payload with junk characters', 'data:image/png;base64,not base64!!', false],
    ['nothing at all', null, false],
    ['a number', 12345, false],
  ];
  for (const [label, value, ok] of SHAPES) {
    assert.equal(snapshotFieldFor(value) !== null, ok, `browser gate disagrees on ${label}`);
    assert.equal(snapshotBytesFromDataUrl(value) !== null, ok, `server decoder disagrees on ${label}`);
    assert.equal(isPngDataUrl(value), ok, `isPngDataUrl disagrees on ${label}`);
  }
  // The one place they legitimately differ: valid base64 that isn't a PNG. The
  // browser can't know (it only ever produces PNGs), the server checks the
  // magic bytes — a mislabeled payload is dropped THERE, and the lead survives.
  const notAPng = pngDataUrl('AAAAAAAA');
  assert.equal(snapshotFieldFor(notAPng), notAPng, 'the envelope is well-formed, so the browser sends it');
  assert.equal(snapshotBytesFromDataUrl(notAPng), null, 'and the server refuses it on its magic bytes');
});

test('the size gate measures the DATA URL and stays inside the server\'s byte budget', () => {
  // base64 carries 3 bytes per 4 characters, so a character budget only means
  // something if it decodes to fewer bytes than the server accepts. Raise one
  // without the other and the browser ships snapshots the server drops — which
  // is indistinguishable, from the widget, from success.
  assert.ok(
    (SNAPSHOT_MAX_URL_CHARS * 3) / 4 <= SNAPSHOT_MAX_BYTES,
    `${SNAPSHOT_MAX_URL_CHARS} chars of base64 decode past the server's ${SNAPSHOT_MAX_BYTES}-byte budget`,
  );
  const prefix = 'data:image/png;base64,';
  const atLimit = pngDataUrl('A'.repeat(SNAPSHOT_MAX_URL_CHARS - prefix.length));
  assert.equal(atLimit.length, SNAPSHOT_MAX_URL_CHARS);
  assert.equal(snapshotFieldFor(atLimit), atLimit, 'a snapshot exactly at the budget still ships');
  assert.equal(snapshotFieldFor(`${atLimit}A`), null, 'one character over and it is dropped, not sent to be refused');
});

test('the submit path asks the renderer for a DATA URL and ships only what the gate returned', () => {
  // The regression lived at the CALL SITE, not in the encoder: the default
  // encoding is object URLs (right for on-screen thumbnails) and the lead path
  // simply inherited it. Pin the call site — a pure-function test would have
  // watched this ship.
  const src = readFileSync(new URL('../src/pages/embed/TogoEmbed.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(
    src, /renderTogoSceneThumb\([^)]*encode: 'dataUrl'[^)]*\)/,
    'the lead snapshot must be rendered as a data URL — an object URL cannot leave the browser',
  );
  assert.match(src, /snapshotFieldFor\(\s*snapshot\s*\)/, 'the render result must go through the wire gate');
  assert.ok(
    !/payload\.snapshot = (snapshot|url)\b/.test(src),
    'a raw render result must never be assigned straight onto the payload',
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE CROSS-VISIT THUMBNAIL STORE — the key is the freshness contract
 *
 * Tile PNGs now survive the tab (Cache Storage), so a returning visitor paints
 * the catalogue without a single render. That is only safe while the KEY is a
 * complete description of the picture: anything the key omits is a piece the
 * dealer edited and the customer keeps seeing the old version of, on a store
 * that never expires and has no purge button.
 *
 * There is no `updatedAt` on a payload model to lean on (`togo-embed/payload.ts`
 * ships id/name/dims/mesh and no stamp), so the stamp IS the row's render-
 * relevant content. `mesh.url` alone would not do it — a mesh is only ever
 * replaced, never edited in place (`uploadTogoMesh` mints a fresh randomUUID
 * path with `upsert: false`), but a piece can be re-dimensioned, renamed or
 * moved between collections on the SAME mesh, and each of those repaints it.
 * ──────────────────────────────────────────────────────────────────────────── */

const STORE_MODEL = {
  id: 'a1b2c3', name: 'Togo Sofa', collection: 'Togo', widthCm: 174, depthCm: 102,
  mesh: { url: 'https://cdn.example/togo-models/aaaa.glb', scale: null, upAxis: 'y', rotateY: 0 },
};

test('the thumbnail store key changes with EVERYTHING that changes the picture', () => {
  const base = togoThumbStoreKey(STORE_MODEL, TILE_THUMB);
  assert.ok(base, 'a model with an id must be storable');
  assert.equal(base, togoThumbStoreKey({ ...STORE_MODEL }, TILE_THUMB), 'the same row must key the same way, or nothing ever hits');

  // [what the dealer changed, the row it produces]
  const EDITS = [
    ['a replaced mesh', { mesh: { ...STORE_MODEL.mesh, url: 'https://cdn.example/togo-models/bbbb.glb' } }],
    ['a re-scaled mesh', { mesh: { ...STORE_MODEL.mesh, scale: 0.1 } }],
    ['a re-oriented mesh', { mesh: { ...STORE_MODEL.mesh, upAxis: 'z' } }],
    ['a rotated mesh', { mesh: { ...STORE_MODEL.mesh, rotateY: 90 } }],
    ['a re-dimensioned piece', { widthCm: 198 }],
    ['a deeper piece', { depthCm: 120 }],
    ['a renamed piece', { name: 'Togo Loveseat' }],   // the procedural form is inferred from it
    ['a piece moved to another collection', { collection: 'Prado' }],
  ];
  for (const [label, patch] of EDITS) {
    assert.notEqual(
      togoThumbStoreKey({ ...STORE_MODEL, ...patch }, TILE_THUMB), base,
      `${label} must mint a new key — the stored PNG no longer shows this piece`,
    );
  }

  // The frame and the cloth are part of the picture too.
  assert.notEqual(togoThumbStoreKey(STORE_MODEL, ROW_THUMB), base, 'two frames of one piece are two images, not a hit at the wrong size');
  assert.notEqual(togoThumbStoreKey(STORE_MODEL, { ...TILE_THUMB, code: 'K1234' }), base, 'a fabricked render is not the bare body');
  assert.notEqual(
    togoThumbStoreKey(STORE_MODEL, { ...TILE_THUMB, code: 'K1234', fab: { textureUrl: 'https://cdn.example/a.jpg' } }),
    togoThumbStoreKey(STORE_MODEL, { ...TILE_THUMB, code: 'K1234', fab: { textureUrl: 'https://cdn.example/b.jpg' } }),
    're-photographed cloth must repaint — the weave is what the render shows',
  );
  assert.equal(togoThumbStoreKey({ ...STORE_MODEL, id: null }, TILE_THUMB), null, 'no id, nothing to key on, nothing stored');
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE BAKED CATALOGUE — the studio renders each piece ONCE and the widget shows
 * the file, instead of every first-time visitor downloading three + every mesh
 * to draw tiles nobody has selected yet.
 *
 * The whole thing rests on one comparison: the stamp the STUDIO writes (off a
 * `togo_models` row) must equal the stamp the WIDGET rebuilds (off the public
 * payload's model). They are different shapes of the same piece. Let them drift
 * and nothing breaks loudly — every baked picture simply reads as stale and the
 * widget renders the whole catalogue anyway, which is the exact cost the bake
 * exists to remove.
 * ──────────────────────────────────────────────────────────────────────────── */

// The same piece, as the two sides see it.
const BAKE_ROW = {           // a togo_models row (db shape, camelCased)
  id: 'a1b2c3', name: 'Togo Sofa', collection: 'Togo', widthCm: 174, depthCm: 102,
  meshUrl: 'https://cdn.example/togo-models/aaaa.glb', meshScale: null, meshUpAxis: 'y', meshRotateY: 0,
  active: true,
};
const BAKE_PAYLOAD = {       // what togo-embed ships the widget
  id: 'a1b2c3', name: 'Togo Sofa', collection: 'Togo', widthCm: 174, depthCm: 102,
  mesh: { url: 'https://cdn.example/togo-models/aaaa.glb', scale: null, upAxis: 'y', rotateY: 0 },
};

test('the bake stamp is the SAME on both sides — row shape and payload shape', () => {
  assert.equal(togoThumbStamp(BAKE_ROW), togoThumbStamp(BAKE_PAYLOAD));
  assert.equal(togoThumbStoreKey(BAKE_ROW, TILE_THUMB), togoThumbStoreKey(BAKE_PAYLOAD, TILE_THUMB));

  // The defaults the payload applies must not read as a different piece: a row
  // with no collection ships as 'Togo', a null rotation as 0, a missing axis as
  // 'y'. Each of these was a silent "always stale" if it folded differently.
  assert.equal(
    togoThumbStamp({ ...BAKE_ROW, collection: null, meshRotateY: null, meshUpAxis: null }),
    togoThumbStamp(BAKE_PAYLOAD),
  );
  // A piece with no mesh at all (procedural) still stamps, and stamps the same.
  assert.equal(
    togoThumbStamp({ ...BAKE_ROW, meshUrl: null }),
    togoThumbStamp({ ...BAKE_PAYLOAD, mesh: null }),
  );
});

test('a baked picture is used only for the piece, size and cloth it was baked for', () => {
  const stamp = togoThumbStoreKey(BAKE_PAYLOAD, TILE_THUMB);
  const baked = { ...BAKE_PAYLOAD, thumbUrl: 'https://cdn.example/thumbs/a1b2c3-x.png', thumbStamp: stamp };

  assert.equal(bakedThumbUrl(baked, TILE_THUMB), baked.thumbUrl);

  // STALE IS NOT SHOWN. Every edit that repaints the piece invalidates its own
  // photo — the widget then renders it live (slower, correct) and the studio's
  // next pass re-bakes it. Showing the previous picture is the one outcome a
  // Ligne Roset catalogue cannot have.
  for (const [label, patch] of [
    ['a renamed piece', { name: 'Togo Loveseat' }],
    ['a re-dimensioned piece', { widthCm: 198 }],
    ['a replaced mesh', { mesh: { ...BAKE_PAYLOAD.mesh, url: 'https://cdn.example/togo-models/bbbb.glb' } }],
    ['a re-oriented mesh', { mesh: { ...BAKE_PAYLOAD.mesh, upAxis: 'z' } }],
    ['a piece moved to another collection', { collection: 'Prado' }],
  ]) {
    assert.equal(bakedThumbUrl({ ...baked, ...patch }, TILE_THUMB), null, label);
  }

  // …nor at another SIZE, nor dressed in a cloth it was not baked in.
  assert.equal(bakedThumbUrl(baked, ROW_THUMB), null, 'a tile-sized bake is not a row-sized image');
  assert.equal(bakedThumbUrl(baked, { ...TILE_THUMB, code: 'K1234' }), null, 'the bare body is not the fabricked render');

  // The HERO slot is the same rule for the one DRESSED render a collection's
  // cover needs — and it answers only for its own cloth.
  const heroOpts = { ...TILE_THUMB, code: 'K1234', fab: { textureUrl: 'https://cdn.example/w.jpg' } };
  const hero = {
    ...BAKE_PAYLOAD,
    heroThumbUrl: 'https://cdn.example/thumbs/a1b2c3-hero.png',
    heroThumbStamp: togoThumbStoreKey(BAKE_PAYLOAD, heroOpts),
  };
  assert.equal(bakedThumbUrl(hero, heroOpts), hero.heroThumbUrl);
  assert.equal(bakedThumbUrl(hero, { ...heroOpts, code: 'OTHER' }), null);
  assert.equal(bakedThumbUrl(hero, TILE_THUMB), null, 'a dressed cover is not the bare catalogue tile');

  // Nothing baked, nothing claimed.
  assert.equal(bakedThumbUrl(BAKE_PAYLOAD, TILE_THUMB), null);
  assert.equal(bakedThumbUrl({ ...baked, thumbUrl: '' }, TILE_THUMB), null);
  assert.equal(bakedThumbUrl({ ...baked, id: null }, TILE_THUMB), null);
});

test('the store key is a bounded same-origin path that leaks no storage URL', () => {
  const key = togoThumbStoreKey(STORE_MODEL, TILE_THUMB);
  // Cache Storage keys on a Request, so it must resolve as a URL — and it must
  // stay OURS: nothing ever fetches this path, it is a name.
  assert.match(key, /^\/__togo-thumb\//, 'the key must be a same-origin path');
  assert.doesNotThrow(() => new URL(key, 'https://alcover.do'), 'the key must resolve as a URL');
  // The stamp is a DIGEST, not the row: a key stays a handful of characters
  // beyond the model's own id, however long the mesh's storage URL happens to be.
  assert.ok(!key.includes(STORE_MODEL.mesh.url), 'the mesh URL is fingerprinted, not carried');
  assert.ok(key.length < STORE_MODEL.id.length + 80, `the key must stay short (${key.length}) — 200 of them live in the store's index`);
  assert.match(key, /\/512x384\//, 'the frame is readable in the key — a wrong-size hit must be diagnosable');
});

test('the catalogue tiles render at their measured box, and the lead snapshot does NOT', () => {
  // The frames are Model constants so the View can name one instead of picking
  // pixels. TILE is ~1.4-2.5x the CSS box it fills (measured: 358x263 CSS on the
  // phone splash, 291x212 on desktop); ROW fills a 48px square.
  assert.deepEqual(TILE_THUMB, { width: 512, height: 384 }, 'the tile frame is 4:3, matching the aspect-[4/3] plate');
  assert.deepEqual(ROW_THUMB, { width: 256, height: 192 });
  for (const [label, frame] of [['tile', TILE_THUMB], ['row', ROW_THUMB]]) {
    assert.equal(frame.width / frame.height, 4 / 3, `the ${label} frame must keep the 4:3 the plates are drawn at`);
  }

  const src = readFileSync(new URL('../src/pages/embed/TogoEmbed.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  // The lead's composition snapshot is the one image that leaves the device and
  // becomes a quote line — it keeps its own full-size frame. Shrinking the tiles
  // must never reach it.
  assert.match(
    src, /renderTogoSceneThumb\(\s*scene3d,\s*\{\s*width:\s*960,\s*height:\s*600,\s*encode:\s*'dataUrl'\s*\}\s*\)/,
    'the lead snapshot must stay 960x600 — it is the picture the dealer quotes from',
  );
  assert.ok(
    !/renderTogoSceneThumb\([^)]*TILE_THUMB/.test(src) && !/renderTogoSceneThumb\([^)]*ROW_THUMB/.test(src),
    'a tile frame must never be handed to the composition snapshot',
  );
});

// ── THE HIGHLIGHT'S SCOPE, part 2: parts that carry their OWN pick ───────────
// The gold line is a PROMISE about what the click edits. A part wearing its own
// fabric will NOT be repainted by the whole-piece pick, so wrapping it promises
// a change that cannot happen (owner, 2026-08-01, with a screenshot: the body in
// CELADON, the cushions on their own ANIS, and the outline still around
// everything). `exclude` is the roles to drop — the parent derives WHICH, this
// filter only honours the list, and only in DRESSABLE mode: a role or group
// focus already names one part, so excluding from it would contradict the ask.
test('the dressable highlight drops the roles carrying their own fabric pick', () => {
  const got = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['cushion'] });
  assert.equal(got.length, 3, 'base + rulo + the untagged mesh — the two cojines left with the legs');
  const roles = got.map((m) => m.userData.partRole || 'base');
  assert.equal(roles.includes('cushion'), false, 'an overridden part is not promised to the whole-piece pick');
  assert.equal(roles.includes('structure'), false, 'the estructura is still out — exclude NARROWS dressable, never widens it');
  // Two overrides at once, and a role the piece does not carry is simply inert.
  assert.equal(focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['cushion', 'bolster'] }).length, 2);
  assert.equal(focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['armCushion'] }).length, 5);
});

test('no exclusions ⇒ byte-identical to the dressable set that shipped', () => {
  // The whole extension is additive: every existing caller hands no `exclude`,
  // and must keep getting exactly what it got before. Pinned against the SAME
  // call the plain-selection test makes, not against a re-typed expectation.
  const plain = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null });
  for (const scope of [
    { role: DRESSABLE_ROLE, groupKey: null },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: [] },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: null },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: undefined },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: 'cushion' },   // not an array ⇒ ignored, never a substring match
  ]) assert.deepEqual(focusMeshes(PIECE_MESHES, scope), plain, `${JSON.stringify(scope.exclude)} must not narrow anything`);
  // …and it is honoured ONLY in dressable mode: a named role or group is the
  // subject the visitor picked, so an override list can never carve into it.
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'cushion', groupKey: null, exclude: ['cushion'] }).length, 2);
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'structure', groupKey: 'legs', exclude: ['structure'] }).length, 4);
});

test('NO-VANISH survives exclusions: every dressable role overridden ⇒ the whole piece', () => {
  // A piece whose every cloth part carries its own pick would otherwise outline
  // NOTHING. Null is what the callers read as "the whole piece", so the visitor
  // still sees the selection — the same fallback an all-estructura piece takes.
  assert.equal(
    focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['base', 'cushion', 'bolster'] }), null,
    'nothing left to promise ⇒ fall back, never an empty highlight',
  );
});

// ── DRESSED POR COMPONENTES ────────────────────────────────────────────────
//
// The money rule (owner, 2026-08): «cuando se eligen componentes el precio es
// la suma de todos los componentes una vez elegidos todos».
//
// The live EXCLUSIF gd canapé is the case that broke: its tagging leaves NO
// mesh group for the body — every group is a bolster, a cojín or the estructura
// — so «tela de toda la pieza» has no geometry of its own to wear. Dressing
// all three componentes still left `p.material` null, and the widget read that
// one field to decide whether a piece was dressed: the row printed «Elegir
// tela» over a build with no undressed surface, the TOTAL ESTIMADO counted it
// as ZERO, and COTIZAR stayed dark. Nothing was ever mispriced —
// `placementTotalUsd` had the number, and the server half agrees — the widget
// simply refused to count it.
test('DRESSED is asked PER MODE — the componentes answer only for their own mode', () => {
  const products = [
    { reference: '10002966A', name: 'EXCLUSIF gd canapé', priceUsd: 20000 },
    { reference: '10002966S', name: 'EXCLUSIF gd canapé', priceUsd: 26000 },
    { reference: '10003026A', name: 'Bolster', priceUsd: 100 },
    { reference: '10003026B', name: 'Bolster', priceUsd: 140 },
    { reference: '17220320A', name: 'Cushion', priceUsd: 200 },
    { reference: '17220320B', name: 'Cushion', priceUsd: 260 },
    { reference: '17220000A', name: 'Arm cushion', priceUsd: 60 },
    { reference: '17220000B', name: 'Arm cushion', priceUsd: 80 },
  ];
  const models = [{
    id: 'exc', name: 'EXCLUSIF gd canapé accoudoir A', widthCm: 244, depthCm: 102,
    svg: '<svg/>', active: true, productRoot: '10002966', collection: 'EXCLUSIF',
    parts: {
      // The live tagging: every group carries a role, none of them `base`.
      mats: { COL0: 'bolster', COL1: 'armCushion', COL2: 'structure', COL0x5: 'cushion' },
      roots: { bolster: '10003026', cushion: '17220320', armCushion: '17220000' },
    },
  }];
  const { resolvedById } = resolveTogoModels(models, products);
  const r = resolvedById.exc;

  // The question is asked over the roles the picker actually OFFERS cloth for.
  // `base` is the piece's own tela, and an ESTRUCTURA wears a finish — neither
  // is a componente anyone can pick a fabric for, so neither may hold the
  // piece hostage.
  assert.deepEqual(dressableRoles(r), ['cushion', 'bolster', 'armCushion']);

  const bare = { uid: 'u1', pieceId: 'exc', x: 0, y: 0, rot: 0 };
  assert.equal(placementDressed(bare, resolvedById), false, 'nothing picked is not dressed');

  // MODO PIEZA asks for the piece's own cloth and nothing else — the
  // componentes are not what it is buying.
  assert.equal(
    placementDressed({ ...bare, material: { grade: 'S', fabric: 'ALCANTARA - A', code: 'C9' } }, resolvedById),
    true,
  );

  // MODO COMPONENTES asks for all of them. PARTIALLY dressed is NOT dressed —
  // «una vez elegidos TODOS» — so a build still missing one never states a
  // total as though it were finished.
  const partial = { ...bare, partsMode: true, partMaterials: {
    cushion: { grade: 'B', fabric: 'ALCANTARA - B', code: 'C1' },
    bolster: { grade: 'A', fabric: 'ACATE', code: 'C2' },
  } };
  assert.equal(placementDressed(partial, resolvedById), false, 'one componente pending ⇒ still pending');
  assert.equal(firstWithoutFabric([partial], resolvedById), 'u1');

  const full = { ...partial, partMaterials: {
    ...partial.partMaterials,
    armCushion: { grade: 'B', fabric: 'ALCANTARA - A', code: 'C3' },
  } };
  assert.equal(placementDressed(full, resolvedById), true);
  assert.equal(firstWithoutFabric([full], resolvedById), null, 'nothing left to ask for');
  // …and its price is the componentes ALONE — the 20000 base SKU is not sold.
  assert.equal(placementTotalUsd(full, resolvedById), 260 + 100 + 80);
});

test('a piece with NO componentes is never vacuously dressed', () => {
  // `.every()` over an empty list is true, which would have made every plain
  // Togo piece read as dressed the moment it was placed — no fabric asked for,
  // and the whole catalogue priced at its cheapest grade behind the visitor.
  const products = [{ reference: '99999999A', name: 'Togo settee', priceUsd: 3000 }];
  const models = [{
    id: 'plain', name: 'Togo settee', widthCm: 174, depthCm: 102, svg: '<svg/>',
    active: true, productRoot: '99999999', collection: 'Togo',
  }];
  const { resolvedById } = resolveTogoModels(models, products);
  assert.deepEqual(dressableRoles(resolvedById.plain), []);
  const p = { uid: 'u1', pieceId: 'plain', x: 0, y: 0, rot: 0 };
  assert.equal(placementDressed(p, resolvedById), false, 'a bare piece still owes a tela');
  assert.equal(firstWithoutFabric([p], resolvedById), 'u1');
  assert.equal(placementDressed({ ...p, material: { grade: 'A', fabric: 'Tona', code: 'Z' } }, resolvedById), true);
});

// An ESTRUCTURA is a FINISH, not cloth (UNPRICED_ROLES): it always carries its
// palette's default and the fabric picker never offers it one, so requiring a
// pick for it would leave every structured model permanently «sin tela».
test('the estructura is not a componente the piece waits on', () => {
  const products = [
    { reference: '44444444A', name: 'Prado platform', priceUsd: 900 },
    { reference: '55555555A', name: 'Prado cushion', priceUsd: 90 },
  ];
  const models = [{
    id: 'pf', name: 'Prado platform', widthCm: 200, depthCm: 100, svg: '<svg/>',
    active: true, productRoot: '44444444', collection: 'Prado',
    parts: { mats: { g0: 'cushion', g1: 'structure' }, roots: { cushion: '55555555' } },
  }];
  const { resolvedById } = resolveTogoModels(models, products);
  assert.deepEqual(dressableRoles(resolvedById.pf), ['cushion']);
  const dressed = {
    uid: 'u1', pieceId: 'pf', x: 0, y: 0, rot: 0,
    partMaterials: { cushion: { grade: 'A', fabric: 'Divina', code: 'D1' } },
  };
  assert.equal(placementDressed(dressed, resolvedById), true);
});

// ── LOS DOS MODOS ──────────────────────────────────────────────────────────
//
// Owner, 2026-08: «si usamos componentes no necesitamos el SKU base; si usamos
// el SKU base no necesitamos componentes. Dos modos.»
//
// The numbers below are the LIVE catalogue's, because they are the evidence:
// the EXCLUSIF gd canapé's «Base» componente is bound to root 10003026, which
// is itself an EXCLUSIF SOFA at $7,885, while the model's own root 10002966 is
// an EXCLUSIF SOFA at $9,560. Summing them billed THE SOFA TWICE — $19,250 for
// a piece whose two honest prices are $9,560 and $9,690.
const EXCLUSIF_PRODUCTS = [
  { reference: '10002966A', name: 'EXCLUSIF SOFA', priceUsd: 9560 },
  { reference: '10002966S', name: 'EXCLUSIF SOFA', priceUsd: 19075 },
  { reference: '10003026A', name: 'EXCLUSIF SOFA', priceUsd: 7885 },
  { reference: '10003026S', name: 'EXCLUSIF SOFA', priceUsd: 15015 },
  { reference: '17220320A', name: 'EXCLUSIF S/2 BACK CUSHIONS', priceUsd: 1355 },
  { reference: '17220320S', name: 'EXCLUSIF S/2 BACK CUSHIONS', priceUsd: 3035 },
  { reference: '17220000A', name: 'EXCLUSIF CUSHION', priceUsd: 450 },
  { reference: '17220000S', name: 'EXCLUSIF CUSHION', priceUsd: 1060 },
];
const EXCLUSIF_MODEL = [{
  id: 'exc', name: 'EXCLUSIF gd canapé accoudoir A', widthCm: 244, depthCm: 102,
  svg: '<svg/>', active: true, productRoot: '10002966', collection: 'EXCLUSIF',
  parts: {
    mats: { COL0: 'bolster', COL1: 'armCushion', COL2: 'structure', COL0x5: 'cushion' },
    roots: { bolster: '10003026', cushion: '17220320', armCushion: '17220000' },
  },
}];
const A = (fabric) => ({ grade: 'A', fabric, code: fabric });

test('MODO PIEZA prices the model\'s own SKU alone — the componentes are included', () => {
  const { resolvedById } = resolveTogoModels(EXCLUSIF_MODEL, EXCLUSIF_PRODUCTS);
  const p = {
    uid: 'u1', pieceId: 'exc', x: 0, y: 0, rot: 0,
    material: { grade: 'A', fabric: 'ACATE', code: 'C1' },
  };
  assert.equal(placementMode(p), 'complete', 'absent flag ⇒ the mode every stored placement already had');
  assert.equal(placementTotalUsd(p, resolvedById), 9560);
  assert.equal(placementDressed(p, resolvedById), true);
});

test('MODO COMPONENTES prices the componentes ALONE — the model\'s SKU never joins in', () => {
  const { resolvedById } = resolveTogoModels(EXCLUSIF_MODEL, EXCLUSIF_PRODUCTS);
  const r = resolvedById.exc;
  // The billed componentes. A structure wears a finish, so it is not one of
  // them and can never hold the price hostage.
  assert.deepEqual(componentRoles(r), ['cushion', 'bolster', 'armCushion']);

  const p = {
    uid: 'u1', pieceId: 'exc', x: 0, y: 0, rot: 0, partsMode: true,
    partMaterials: { cushion: A('ALCANTARA'), bolster: A('ACATE'), armCushion: A('ANDY') },
  };
  assert.equal(placementMode(p), 'parts');
  // 1355 + 7885 + 450 — and NOT the 9560 of the model's own SKU.
  assert.equal(placementTotalUsd(p, resolvedById), 1355 + 7885 + 450);
  assert.ok(placementTotalUsd(p, resolvedById) < 9560 + 1355 + 7885 + 450,
    'the sum of both is exactly the double-billed sofa this replaces');
  assert.equal(placementDressed(p, resolvedById), true);
});

test('MODO COMPONENTES has no price until EVERY componente is chosen', () => {
  // Owner: «no se puede quedar un componente vacío». A partial build has no
  // price to state — never a smaller one.
  const { resolvedById } = resolveTogoModels(EXCLUSIF_MODEL, EXCLUSIF_PRODUCTS);
  const partial = {
    uid: 'u1', pieceId: 'exc', x: 0, y: 0, rot: 0, partsMode: true,
    partMaterials: { cushion: A('ALCANTARA'), bolster: A('ACATE') },
  };
  assert.equal(placementTotalUsd(partial, resolvedById), null);
  assert.equal(placementDressed(partial, resolvedById), false);
  // …and the piece's own cloth cannot answer for it: this mode is not buying it.
  const withBase = { ...partial, material: { grade: 'S', fabric: 'X', code: 'X' } };
  assert.equal(placementTotalUsd(withBase, resolvedById), null);
  assert.equal(placementDressed(withBase, resolvedById), false);
});

test('switching INTO componentes seeds every one from the piece\'s cloth, and back is always open', () => {
  const { resolvedById } = resolveTogoModels(EXCLUSIF_MODEL, EXCLUSIF_PRODUCTS);
  const r = resolvedById.exc;
  const base = {
    uid: 'u1', pieceId: 'exc', x: 0, y: 0, rot: 0,
    material: { grade: 'A', fabric: 'ACATE', code: 'C1' },
  };
  // Seeded ⇒ the mode is never entered half-empty, the piece looks IDENTICAL
  // the instant it flips, and it has a price straight away.
  const parts = planModeSwitch(base, r, 'parts');
  assert.equal(parts.partsMode, true);
  assert.deepEqual(Object.keys(parts.partMaterials).sort(), ['armCushion', 'bolster', 'cushion']);
  for (const role of componentRoles(r)) assert.equal(parts.partMaterials[role].code, 'C1');
  assert.equal(placementDressed(parts, resolvedById), true);
  assert.equal(placementTotalUsd(parts, resolvedById), 7885 + 1355 + 450);

  // Changing ONE diverges only that one — the rest keep the base cloth.
  const diverged = { ...parts, partMaterials: { ...parts.partMaterials, cushion: { grade: 'S', fabric: 'ALCANTARA', code: 'C9' } } };
  assert.equal(diverged.partMaterials.bolster.code, 'C1');
  assert.equal(placementTotalUsd(diverged, resolvedById), 7885 + 3035 + 450);

  // …and back to the SKU base at any time, with the piece's own cloth intact
  // AND its componente picks kept, so returning to the other mode restores the
  // build rather than making the visitor dress it twice.
  const backAgain = planModeSwitch(diverged, r, 'complete');
  assert.equal(backAgain.partsMode, false);
  assert.deepEqual(backAgain.material, base.material, 'the piece never lost its own cloth');
  assert.deepEqual(backAgain.partMaterials, diverged.partMaterials, 'nor its componente picks');
  assert.equal(placementTotalUsd(planModeSwitch(backAgain, r, 'parts'), resolvedById), 7885 + 3035 + 450,
    'flipping back re-states the componentes price exactly');
  // …and modo pieza is the model's own SKU, whatever the componentes are still
  // carrying: they came back with the build, they are «Incluido», and not one
  // of them is charged.
  assert.equal(placementTotalUsd(backAgain, resolvedById), 9560);
});

test('MODO PIEZA is the model\'s SKU alone — the base-PLUS-componentes path is gone', () => {
  // ⚠️ THIS IS THE RULE THAT CHANGED (owner, 2026-08). A componente in its own
  // cloth used to bill ON TOP of the piece, and this fixture pinned it at 1200.
  // That middle path is what double-billed the body wherever a componente's SKU
  // IS the body (EXCLUSIF 10002966/10003026, Noka, all four Ottomans), so it is
  // gone: dressing a componente differently is now the OTHER MODE, not a dearer
  // version of this one.
  const products = [
    { reference: '11111111A', name: 'Prado settee', priceUsd: 1000 },
    { reference: '11111111B', name: 'Prado settee', priceUsd: 1200 },
    { reference: '22222222A', name: 'Prado back cushion', priceUsd: 100 },
    { reference: '22222222B', name: 'Prado back cushion', priceUsd: 150 },
    { reference: '33333333A', name: 'Prado bolster', priceUsd: 50 },
  ];
  const models = [{
    id: 'm1', name: 'Settee', widthCm: 160, depthCm: 179, svg: '<svg/>', active: true,
    productRoot: '11111111', collection: 'Prado',
    parts: {
      mats: { matA: 'base', matB: 'cushion', matC: 'cushion', matD: 'bolster' },
      roots: { cushion: '22222222', bolster: '33333333' },
    },
  }];
  const { resolvedById } = resolveTogoModels(models, products);
  const p = { uid: 'u1', pieceId: 'm1', x: 0, y: 0, rot: 0 };
  assert.equal(placementTotalUsd(p, resolvedById), 1000, 'nothing picked ⇒ the elemento completo');
  const picked = { ...p, partMaterials: { cushion: { grade: 'B', fabric: 'Divina', code: 'X1' } } };
  assert.equal(placementTotalUsd(picked, resolvedById), 1000, 'a divergent pick is «Incluido», not a surcharge');
  // …and the same build in the OTHER mode is the componentes alone.
  assert.equal(placementTotalUsd({ ...picked, partsMode: true }, resolvedById), null,
    'still missing the bolster ⇒ no price at all');
  const all = { ...picked, partsMode: true, partMaterials: { cushion: { grade: 'B', fabric: 'Divina', code: 'X1' }, bolster: { grade: 'A', fabric: 'Tona', code: 'X2' } } };
  assert.equal(placementTotalUsd(all, resolvedById), 150 + 50);
});

// ══ COHERENCIA: una acción, TODAS las superficies ═══════════════════════════
//
// Owner, 2026-08: «quiero que cuando hagas cualquier acción cada componente
// relacionado reaccione de la manera adecuada».
//
// The professional name for what this pins is SINGLE SOURCE OF TRUTH with
// DERIVED state: one fact has one owner, and every surface RE-DERIVES from it
// instead of keeping a copy that has to be kept in step. The surfaces are React
// and can't be asserted here — but they all read the SAME resolvers, so pinning
// the resolvers after each action pins the surfaces that render them:
//
//   money            placementTotalUsd        (row price, estimate, CTA gate)
//   «vestida»        placementDressed         (row label, «N sin tela», Resumen)
//   componentes rail pieceSwatchEntries       ← its own file (a View helper)
//   itemization      placementBreakdown       (Resumen rows)
//   the quote        buildTogoComponents      (what the dealer receives)
//
// Every case below is one gesture, then EVERY one of those read back together.
const COH_PRODUCTS = [
  { reference: '50000000A', name: 'Sofa', priceUsd: 4000 },
  { reference: '50000000C', name: 'Sofa', priceUsd: 5200 },
  { reference: '51000000A', name: 'Cojines', priceUsd: 900 },
  { reference: '51000000C', name: 'Cojines', priceUsd: 1150 },
  { reference: '52000000A', name: 'Rulo', priceUsd: 300 },
  { reference: '52000000C', name: 'Rulo', priceUsd: 380 },
];
const COH_MODELS = [{
  id: 'sofa', name: 'Loveseat', widthCm: 180, depthCm: 100, svg: '<svg/>', active: true,
  productRoot: '50000000', collection: 'Prado',
  parts: {
    mats: { body: 'base', cush: 'cushion', roll: 'bolster', legs: 'structure' },
    roots: { cushion: '51000000', bolster: '52000000' },
  },
}];
const CLOTH = (g, code) => ({ grade: g, fabric: `Tela ${code}`, code });

/** Everything the surfaces read, for one placement, in one object. */
function surfaces(p, resolvedById) {
  const bd = placementBreakdown(p, resolvedById);
  const comps = buildTogoComponents([p], resolvedById, ids());
  return {
    mode: placementMode(p),
    dressed: placementDressed(p, resolvedById),
    total: placementTotalUsd(p, resolvedById),
    pending: firstWithoutFabric([p], resolvedById),
    breakdownTotal: bd.totalUsd,
    baseLine: bd.lines.find((l) => l.role === 'base'),
    partLines: bd.lines.filter((l) => l.role !== 'base'),
    seedTotal: comps.reduce((s, c) => s + c.unitPrice * (c.qty || 1), 0),
    seedBaseUsd: comps[0].unitPrice,
    seedCount: comps.length,
  };
}

test('COHERENCIA · vestir la pieza entera: money, «vestida», resumen y semilla se mueven juntos', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const bare = { uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0 };

  // NADA elegido — ninguna superficie inventa un precio.
  const a = surfaces(bare, resolvedById);
  assert.equal(a.mode, 'complete');
  assert.equal(a.dressed, false);
  assert.equal(a.pending, 'u1', 'la advertencia «sin tela» apunta a esta pieza');

  // La tela de la pieza, en grado C.
  const dressed = { ...bare, material: CLOTH('C', 'X1') };
  const b = surfaces(dressed, resolvedById);
  assert.equal(b.dressed, true);
  assert.equal(b.pending, null, '…y la advertencia se apaga en el mismo gesto');
  assert.equal(b.total, 5200, 'el SKU de la pieza a su grado');
  assert.equal(b.breakdownTotal, b.total, 'el resumen cuadra con la fila');
  assert.equal(b.seedTotal, b.total, 'y la cotización con las dos');
  assert.equal(b.seedCount, 1, 'una sola tela ⇒ un solo componente en la línea');
  assert.equal(b.baseLine.complete, true);
  assert.ok(b.partLines.every((l) => l.included), 'los componentes van «Incluido», nunca cobrados');
});

test('COHERENCIA · vestir UN componente entra al modo y arrastra a todas las superficies', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  // El gesto real de la UI: la pieza vestida, y el visitante cambia un cojín.
  // `planModeSwitch` es lo que corre antes del pick (onPickPartMaterial).
  const start = { uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('A', 'X1') };
  const seeded = planModeSwitch(start, r, 'parts');
  const after = { ...seeded, partMaterials: { ...seeded.partMaterials, cushion: CLOTH('C', 'X9') } };

  const s = surfaces(after, resolvedById);
  assert.equal(s.mode, 'parts');
  assert.equal(s.dressed, true, 'sembrado ⇒ ningún componente queda vacío');
  // 1150 (cojines a C, el que cambió) + 300 (rulo, sembrado de la pieza a A).
  assert.equal(s.total, 1150 + 300, 'los componentes SOLOS — el SKU de la pieza no se vende aquí');
  assert.equal(s.breakdownTotal, s.total);
  assert.equal(s.seedTotal, s.total);
  assert.equal(s.baseLine.byParts, true, 'el resumen marca que la pieza no se cobra…');
  assert.equal(s.baseLine.totalUsd, null);
  assert.equal(s.seedBaseUsd, 0, '…y la línea de cotización la lleva a cero, cargando el plan');
  // Solo el que tocó diverge; el resto lleva la tela de la pieza.
  assert.equal(after.partMaterials.bolster.code, 'X1');
});

test('COHERENCIA · vaciar un componente apaga el precio en TODAS partes, nunca lo encoge', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  const full = planModeSwitch({ uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('A', 'X1') }, r, 'parts');
  assert.equal(surfaces(full, resolvedById).total, 900 + 300);

  // «Volver a la tela de la pieza» sobre un componente (clearPartMaterial).
  const { cushion, ...rest } = full.partMaterials;   // eslint-disable-line no-unused-vars
  const gapped = { ...full, partMaterials: rest };
  const s = surfaces(gapped, resolvedById);
  assert.equal(s.dressed, false, 'un componente vacío ⇒ la pieza vuelve a estar pendiente');
  assert.equal(s.pending, 'u1', 'y la advertencia la nombra otra vez');
  assert.equal(s.total, null, 'SIN precio — jamás uno más pequeño');
  assert.equal(s.breakdownTotal, null, 'el resumen dice lo mismo…');
  assert.equal(s.partLines.find((l) => l.role === 'cushion').pending, true,
    '…señalando el hueco, nunca «Incluido»');
});

test('COHERENCIA · volver a pieza entera devuelve TODAS las superficies, sin perder las elecciones', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  const parts = planModeSwitch({ uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('C', 'X1') }, r, 'parts');
  const back = planModeSwitch(parts, r, 'complete');
  const s = surfaces(back, resolvedById);
  assert.equal(s.mode, 'complete');
  assert.equal(s.total, 5200, 'el SKU de la pieza, otra vez');
  assert.equal(s.seedCount, 1);
  assert.deepEqual(back.partMaterials, parts.partMaterials, 'las elecciones siguen ahí para volver');
  assert.equal(placementTotalUsd(planModeSwitch(back, r, 'parts'), resolvedById), 1150 + 380,
    'y volver a componentes las recupera intactas');
});

test('COHERENCIA · «una sola tela para todas» alcanza TAMBIÉN a una pieza en modo componentes', () => {
  // EL HUECO QUE ESTO CIERRA: la acción escribía `material` y dejaba el modo
  // quieto, así que una pieza vendida por componentes seguía renderizando y
  // cotizando desde sus propias telas — la pieza a la que acababas de decir
  // «cámbiate» no cambiaba. Una sola tela en todo ES el elemento completo en
  // todo: es la misma frase.
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  const byParts = planModeSwitch({ uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('A', 'X1') }, r, 'parts');
  assert.equal(placementMode(byParts), 'parts');

  // El reductor que corre dentro de applyFabricToAll, por pieza.
  const all = { ...planModeSwitch(byParts, r, 'complete'), material: CLOTH('C', 'Z9') };
  const s = surfaces(all, resolvedById);
  assert.equal(s.mode, 'complete', 'la pieza ENTERA lleva la tela, no sus componentes');
  assert.equal(s.total, 5200);
  assert.equal(s.seedCount, 1, 'un elemento completo, una línea');
});

test('COHERENCIA · duplicar una pieza clona su MODO, no solo sus telas', () => {
  // Un duplicado que perdiera el modo cotizaría distinto que el original que
  // tiene al lado, con la misma tela y el mismo nombre.
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  const src = planModeSwitch({ uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('C', 'X1') }, r, 'parts');
  const { placed } = duplicatePlacement([src], 'u1', resolvedById, 'u2');
  const copy = placed.find((p) => p.uid === 'u2');
  assert.equal(placementMode(copy), 'parts');
  assert.equal(placementTotalUsd(copy, resolvedById), placementTotalUsd(src, resolvedById));
  assert.notEqual(copy.partMaterials, src.partMaterials, 'clonado, no compartido');
});

test('COHERENCIA · la ESTRUCTURA es invisible al dinero en los DOS modos', () => {
  // Se elige, no se cobra — en cualquiera de los dos modos, o el toggle movería
  // el precio por una razón que no es una tela.
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  const base = { uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('C', 'X1') };
  for (const p of [base, planModeSwitch(base, r, 'parts')]) {
    const withFinish = { ...p, partFinishes: { legs: 'acero-negro' } };
    assert.equal(
      placementTotalUsd(withFinish, resolvedById),
      placementTotalUsd(p, resolvedById),
      `un acabado no mueve el precio (${placementMode(p)})`,
    );
  }
});

// ── LA VISTA DE COMPONENTES: una pregunta, un dueño ─────────────────────────
// Owner, 2026-08-05, señalando la «O» del rail: «when this O mode is selected
// it should only show the base SKU and structure selections». El MODO es la
// única verdad, y toda superficie que parte base/componentes (chips del rail,
// mitades del panel, filas de PartsSection) pregunta ESTO en vez de rederivar
// modo + objetivo por su cuenta.
//
// Esto SUSTITUYE la regla anterior («un componente recién apuntado abre la
// vista», owner 2026-08): apuntar un cojín ya no re-viste el rail detrás del
// puntero. Aterrizar el pick sigue ENTRANDO en modo componentes
// (onPickPartMaterial → planModeSwitch), así que los chips aparecen cuando el
// build de verdad se vende así.
test('componentViewOf: SOLO el modo — apuntar un componente ya no abre la vista', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  const base = { uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('A', 'X1') };

  // Modo pieza ⇒ vista base (SKU base + estructura), se apunte lo que se apunte.
  assert.equal(componentViewOf(base), false);
  assert.equal(componentViewOf(base, r, 'cushion'), false, 'apuntar un cojín NO abre los componentes');
  assert.equal(componentViewOf(base, r, 'bolster'), false);
  assert.equal(componentViewOf(base, r, 'structure'), false);
  // Modo componentes ⇒ vista componentes, siempre.
  const parts = planModeSwitch(base, r, 'parts');
  assert.equal(componentViewOf(parts), true);
  assert.equal(componentViewOf(parts, r, 'structure'), true);
});

// ── CUERPO VACÍO: derecho a componentes ─────────────────────────────────────
// Owner, 2026-08-05: «if it's an empty body we can go straight into
// components». Un modelo sin SKU propio no cotiza en modo pieza, así que nacer
// ahí es nacer «sin precio» con el interruptor como único camino.
test('sellsByComponentsOnly: sin SKU propio pero con componentes que facturan', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;

  // El modelo normal TIENE cuerpo: se vende de una pieza, no se fuerza el modo.
  assert.equal(sellsByComponentsOnly(r), false);
  // Sin familia base ni elemento completo, pero con componentes ⇒ componentes.
  assert.equal(sellsByComponentsOnly({ ...r, baseFamily: null, completeFamily: null }), true);
  // …y con un elemento completo atado sigue habiendo cuerpo que vender.
  assert.equal(sellsByComponentsOnly({ ...r, baseFamily: null, completeFamily: r.baseFamily }), false);
  // LOS DOS LADOS: sin componentes que facturar, modo componentes tampoco
  // cotiza — mandarla allí solo cambiaría un callejón sin salida por otro.
  assert.equal(sellsByComponentsOnly({ ...r, baseFamily: null, completeFamily: null, partFamilies: {} }), false);
  assert.equal(sellsByComponentsOnly(null), false);
});

// ── PICKS DORMIDOS: en modo pieza, callados en TODAS partes ─────────────────
// El bug del dueño: «I can't change the material on my base sku piece». Volver
// a modo pieza CONSERVA partMaterials (para restaurar al volver), pero el 3D,
// los chips y la itemización leían el mapa CRUDO, ciegos al modo — cambiabas
// la tela de la pieza y solo se repintaba el casco, porque cada componente
// seguía vistiendo su pick dormido.
test('effectivePartMaterials: dormidos en modo pieza, vivos en componentes, zonas siempre', () => {
  const pm = {
    cushion: { grade: 'C', fabric: 'Steelcut', code: 'S2' },
    exterior: { grade: 'B', fabric: 'Divina', code: 'D1' },
  };
  const parts = { uid: 'u1', partsMode: true, partMaterials: pm };
  assert.deepEqual(effectivePartMaterials(parts), pm, 'modo componentes: hablan todos');
  const pieza = { uid: 'u1', partMaterials: pm };
  assert.deepEqual(
    effectivePartMaterials(pieza),
    { exterior: pm.exterior },
    'modo pieza: el cojín calla; la ZONA sigue viva (el bicolor es parte de la pieza)',
  );
  assert.equal(effectivePartMaterials({ uid: 'u1' }), null);
  assert.equal(effectivePartMaterials({ uid: 'u1', partMaterials: { cushion: pm.cushion } }), null,
    'solo picks de componente en modo pieza ⇒ nada vivo');
});

test('COHERENCIA · tras ida y vuelta por el toggle, cambiar la tela base repinta TODO', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  // Ida: entrar a componentes (siembra), divergir el cojín. Vuelta: modo pieza.
  const parts = planModeSwitch({ uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('A', 'X1') }, r, 'parts');
  const diverged = { ...parts, partMaterials: { ...parts.partMaterials, cushion: CLOTH('C', 'Z9') } };
  const back = planModeSwitch(diverged, r, 'complete');
  assert.ok(back.partMaterials?.cushion, 'los picks siguen guardados para restaurar');

  // …y el visitante cambia la tela de la pieza.
  const redressed = { ...back, material: CLOTH('C', 'NEW') };

  // LA ESCENA: ningún componente viste el pick dormido — todos van con la pieza.
  const [scene] = scenePlacementsFromPlaced([redressed], resolvedById);
  assert.equal(scene.fabricCode, 'NEW');
  assert.equal(scene.partMaterials, null, 'nada dormido llega al render');

  // EL RESUMEN: las líneas «Incluido» no nombran la tela dormida.
  const { lines, totalUsd } = placementBreakdown(redressed, resolvedById);
  const cush = lines.find((l) => l.role === 'cushion');
  assert.equal(cush.included, true);
  assert.equal(cush.fabric, '', 'sin nombre de tela dormida');
  assert.equal(cush.defaultGrade, true, 'la vista susurra «tela base»');
  assert.equal(totalUsd, 5200, 'el SKU de la pieza al grado nuevo');

  // …y volver a componentes revive los picks tal cual quedaron.
  const again = planModeSwitch(redressed, r, 'parts');
  const [sceneParts] = scenePlacementsFromPlaced([again], resolvedById);
  assert.equal(sceneParts.partMaterials.cushion.code, 'Z9', 'la vuelta restaura la divergencia');
});

test('COHERENCIA · el plan de una cotización replay-ea con el MISMO modo', () => {
  const { resolvedById } = resolveTogoModels(COH_MODELS, COH_PRODUCTS);
  const r = resolvedById.sofa;
  const parts = planModeSwitch({ uid: 'u1', pieceId: 'sofa', x: 0, y: 0, rot: 0, material: CLOTH('A', 'X1') }, r, 'parts');
  const comps = buildTogoComponents([parts], resolvedById, ids());
  // El plan guarda crudo + modo; el replay pregunta el modo igual que el widget.
  const [scene] = scenePlacementsFromComponents(comps);
  assert.deepEqual(scene.partMaterials, parts.partMaterials, 'modo componentes: el replay viste los picks');
  // El mismo plan sin partsMode (una cotización anterior a los modos): dormidos.
  const legacy = comps.map((c) => (c.plan ? { ...c, plan: { ...c.plan, partsMode: undefined } } : c));
  const [legacyScene] = scenePlacementsFromComponents(legacy);
  assert.equal(legacyScene.partMaterials, null, 'un plan pre-modos replay-ea como modo pieza');
});
