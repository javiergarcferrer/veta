// The placement engine — the plan math (rotation + snapping), the collision
// resolver, the link nest, «Conectar piezas», duplication, keyboard cycling and
// the undo/redo stack.
//
// SANDBOX pins: the plan is an unbounded floor (no clamp, no walls — a piece goes
// wherever it's dropped) and rotation is FREE (any angle, footprints are the
// rotated AABB, exact at the cardinal angles). Never reintroduce a plan boundary
// "for safety" — the viewport normalizes around the build instead.
//
// Ported from RosetSoft tests/togoConfigurator.test.js (placement cases only —
// every pricing/scene case belongs to the catalog + scene packages) and
// tests/togo3d.test.js (the compactPlaced case).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  footprintOf, snapPlacement, snapPlacementInfo, resolveCollision, linkOverlap,
  compactPlaced, duplicatePlacement, cyclePieceUid, resolvePlacement,
  DEFAULT_LAYOUT_PARAMS,
  makeHistory, historyPush, historyUndo, historyRedo, canUndo, canRedo, HISTORY_LIMIT,
} from '../src/index.ts';
import type { LayoutParams, PieceModelMap, Placed } from '../src/index.ts';

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

test('pieces collide, never interpenetrate: an embedded drop resolves to flush contact', () => {
  // The user scenario behind "magnetizing too close": two settees (160×179), the
  // second shoved ~30 cm INTO the first and released. The old fallback committed
  // the embedded spot — the 3D meshes visibly crossed. Now it must resolve to the
  // nearest touching edge: flush contact, zero overlap.
  const a = { x: 0, y: 0, w: 160, h: 179 };
  const shoved = snapPlacementInfo({ x: 130, y: 0, w: 160, h: 179 }, [a]);
  assert.equal(shoved.x, 160, "pushed out to touch a's right edge");
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
  const freeOfBoth = [a, b].every((o) => (
    !(chained.x < o.x + o.w - 0.5 && chained.x + 160 > o.x + 0.5
      && chained.y < o.y + o.h - 0.5 && chained.y + 179 > o.y + 0.5)
  ));
  assert.ok(freeOfBoth, 'multi-neighbour push settles clear of every piece');
});

test('resolveCollision is the push-out on its own: least penetration, to flush contact', () => {
  const a = { x: 0, y: 0, w: 160, h: 179 };
  const out = resolveCollision({ x: 130, y: 0, w: 160, h: 179 }, [a]);
  assert.deepEqual({ x: out.x, y: out.y }, { x: 160, y: 0 });
  assert.equal(out.pushedX, true);
  assert.equal(out.pushedY, false);
  // Nothing overlapping → nothing to resolve, the box stays put.
  const clear = resolveCollision({ x: 400, y: 400, w: 100, h: 100 }, [a]);
  assert.deepEqual(clear, { x: 400, y: 400, pushedX: false, pushedY: false });
});

test('link overlap: same-collection pieces NEST by the collection amount; others dock flush', () => {
  // Saparella modules nest by DEFAULT_LAYOUT_PARAMS.linkOverlapCm.saparella
  // (tuned so a run totals the real composed product).
  const NEST = linkOverlap('Saparella', 'Saparella');
  assert.ok(NEST > 0, 'Saparella nests');
  assert.equal(NEST, DEFAULT_LAYOUT_PARAMS.linkOverlapCm.saparella);
  assert.equal(linkOverlap('saparella', 'SAPARELLA'), NEST, 'case-insensitive');
  assert.equal(linkOverlap('Saparella', 'Prado'), 0, 'different collections never nest');
  assert.equal(linkOverlap('Prado', 'Prado'), 0, 'non-linking collection docks flush');
  assert.equal(linkOverlap(null, null), 0);

  // A Saparella fireside dropped flush-right of a diavolo (as addPiece does,
  // top-aligned) nests NEST cm into it — the overlap is the INTENDED join, not a
  // collision, so it's never pushed apart. Docking uses the FIRM range
  // (release-dock) so a nest deeper than the gentle live magnet still engages.
  const firm = { edgeCm: 50 };
  const diavolo = { x: 0, y: 0, w: 82, h: 100, col: 'Saparella' };
  const nested = snapPlacement({ x: 82, y: 0, w: 78, h: 100, col: 'Saparella' }, [diavolo], firm);
  assert.equal(nested.x, 82 - NEST, 'fireside left edge sits NEST cm INTO the diavolo');
  assert.equal(nested.y, 0, 'stays top-aligned');
  assert.ok(nested.x < 82, 'nested, not flush');

  // `mode: 'dock'` is that same firm range, taken from the params.
  const byMode = snapPlacement({ x: 82, y: 0, w: 78, h: 100, col: 'Saparella' }, [diavolo], { mode: 'dock' });
  assert.deepEqual(byMode, nested, 'dock mode == the release-dock threshold');

  // The 90° turn: a Saparella piece below a neighbour nests on the Y axis.
  const belowNest = snapPlacement(
    { x: 0, y: 100, w: 78, h: 78, col: 'Saparella' },
    [{ x: 0, y: 0, w: 100, h: 100, col: 'Saparella' }],
    firm,
  );
  assert.equal(belowNest.y, 100 - NEST, 'top edge sits NEST cm into the piece above');

  // No collection (legacy) and cross-collection stay EXACTLY flush — no regression.
  const settee = { x: 0, y: 0, w: 174, h: 102 };
  assert.equal(snapPlacement({ x: 170, y: 3, w: 102, h: 102 }, [settee]).x, 174, 'legacy still docks flush');
  const deeper = snapPlacement(
    { x: 20, y: 0, w: 100, h: 100, col: 'Saparella' },
    [{ x: 0, y: 0, w: 100, h: 100, col: 'Saparella' }],
  );
  const overlapPast = 100 - deeper.x;   // how far the candidate's left sits inside the neighbour
  assert.ok(overlapPast <= NEST + 0.01, 'a piece shoved deeper than the nest is pushed back OUT to the nest depth');
});

test('the nest table is a PARAMETER: a foreign collection links under its own rules', () => {
  const params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS, linkOverlapCm: { odessa: 14 } };
  assert.equal(linkOverlap('Odessa', 'Odessa', params), 14);
  assert.equal(linkOverlap('Saparella', 'Saparella', params), 0, 'not in this table → flush');
  const neighbour = { x: 0, y: 0, w: 100, h: 100, col: 'Odessa' };
  const nested = snapPlacement(
    { x: 100, y: 0, w: 100, h: 100, col: 'Odessa' },
    [neighbour],
    { edgeCm: 50, params },
  );
  assert.equal(nested.x, 100 - 14);
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
  // The live edge snap must stay GENTLE — a strong magnet (the old 26 cm)
  // teleports pieces mid-drag and fights a free arrangement.
  assert.ok(DEFAULT_LAYOUT_PARAMS.edgeSnapCm <= 12, 'edge snap must stay a gentle assist');
  // …while the release dock is generous (~half a module) so a piece let go
  // "next to" the run settles flush instead of a hand's-width short.
  assert.ok(DEFAULT_LAYOUT_PARAMS.dockCm > DEFAULT_LAYOUT_PARAMS.edgeSnapCm);
  // The defaults ARE today's constants, byte for byte.
  assert.deepEqual(DEFAULT_LAYOUT_PARAMS, {
    gridCm: 2, edgeSnapCm: 12, dockCm: 50, linkOverlapCm: { saparella: 9 },
  });
  // The sandbox has no walls: no clamp may ever be exported from this package.
  const mod: Record<string, unknown> = await import('../src/index.ts');
  assert.equal(mod.clampToPlan, undefined, 'no plan clamp — the floor is unbounded');
});

// ── «Conectar piezas» ───────────────────────────────────────────────────────

test('compactPlaced removes the empty strips so a gapped sectional becomes flush', () => {
  const byId: PieceModelMap = {
    settee: { widthCm: 174, depthCm: 102 },
    corner: { widthCm: 102, depthCm: 102 },
    sofa: { widthCm: 174, depthCm: 102 },
  };
  // The reported L with a 102 cm hole (corner+sofa column parked at x=276 → 378
  // wide), as if a middle piece was deleted.
  const out = compactPlaced([
    { uid: 1, pieceId: 'settee', x: 0, y: 0, rot: 0 },
    { uid: 2, pieceId: 'corner', x: 276, y: 0, rot: 0 },
    { uid: 3, pieceId: 'sofa', x: 276, y: 102, rot: 90 },
  ], byId);
  const by = Object.fromEntries(out.map((p) => [p.pieceId, p]));
  assert.equal(by.settee.x, 0);
  assert.equal(by.corner.x, 174, 'corner pulled flush against the settee');
  assert.equal(by.sofa.x, 174, 'the column moved WITH the corner — shape preserved');
  assert.equal(by.corner.y, 0);
  assert.equal(by.sofa.y, 102);
  // Connected now: the plan collapses from 378 → 276 cm wide, no hole.
  const maxX = Math.max(...out.map((p) => {
    const fp = footprintOf(byId[p.pieceId as string], p.rot);
    return (p.x as number) + fp.w;
  }));
  assert.equal(maxX, 276);
});

test('compactPlaced is a no-op below two pieces, and never re-orders', () => {
  const byId: PieceModelMap = { a: { widthCm: 100, depthCm: 100 } };
  const one: Placed[] = [{ uid: 1, pieceId: 'a', x: 500, y: 500, rot: 0 }];
  assert.equal(compactPlaced(one, byId), one, 'a single piece is handed straight back');
  const two = compactPlaced([
    { uid: 'z', pieceId: 'a', x: 400, y: 0, rot: 0 },
    { uid: 'y', pieceId: 'a', x: 0, y: 0, rot: 0 },
  ], byId);
  assert.deepEqual(two.map((p) => p.uid), ['z', 'y'], 'list order survives the squeeze');
  assert.deepEqual(two.map((p) => p.x), [100, 0], 'the gap is gone, the arrangement is not');
});

// ── duplicate + keyboard cycle ──────────────────────────────────────────────

test('duplicatePlacement clones rotation + material and drops the copy flush to the right', () => {
  const r: PieceModelMap = { a: { id: 'a', label: 'Sillón', widthCm: 102, depthCm: 102 } };
  const one: Placed[] = [
    { uid: 'u1', pieceId: 'a', x: 0, y: 0, rot: 0, material: { grade: 'G', fabric: 'ALCANTARA', unitPrice: 1500 } },
  ];

  const dup = duplicatePlacement(one, 'u1', r, 'u9');
  assert.ok(dup);
  assert.equal(dup.uid, 'u9');
  assert.equal(dup.placed.length, 2);
  const copy = dup.placed[1];
  assert.equal(copy.uid, 'u9');
  assert.equal(copy.pieceId, 'a');
  // Flush against the source's right edge, same row.
  assert.equal(copy.x, 102);
  assert.equal(copy.y, 0);
  // The material pick is CLONED, not shared (mutating one must not touch the other).
  assert.deepEqual(copy.material, one[0].material);
  assert.notEqual(copy.material, one[0].material);
  // The original list is untouched (immutably extended).
  assert.equal(one.length, 1);

  // Unknown uid → null (the View no-ops).
  assert.equal(duplicatePlacement(one, 'nope', r, 'u9'), null);

  // The floor is unbounded: a copy past any old "plan edge" just keeps the row
  // growing — no wall pushes it back.
  const edge: Placed[] = [{ uid: 'e1', pieceId: 'a', x: 658, y: 0, rot: 0 }];
  const atEdge = duplicatePlacement(edge, 'e1', r, 'e2');
  assert.equal(atEdge?.placed[1].x, 760, 'flush right of the source, wherever that is');
});

test('seat-mounted accessories float: they neither snap nor block the floor plan', () => {
  const r: PieceModelMap = {
    sofa: { widthCm: 200, depthCm: 120, collection: 'Prado' },
    cush: { widthCm: 60, depthCm: 60, collection: 'Prado', mount: 'seat', mountHeightCm: 38 },
  };
  const placed: Placed[] = [
    { uid: 'a', pieceId: 'sofa', x: 0, y: 0, rot: 0 },
    { uid: 'b', pieceId: 'cush', x: 50, y: 30, rot: 0 },   // sits ON the sofa's tile
  ];
  // Duplicating the cushion never snaps/collides — it floats beside the original.
  const dup = duplicatePlacement(placed, 'b', r, 'b2');
  assert.equal(dup?.placed[2].x, 110, 'src.x + width, no snap');
  assert.equal(dup?.placed[2].y, 30);
  // …and a module duplicating next to it never sees the cushion as a neighbour.
  const modDup = duplicatePlacement(placed, 'a', r, 'a2');
  assert.equal(modDup?.placed[2].x, 200, 'flush right of the sofa, the cushion ignored');
});

// The keyboard Tab-cycle order over the plan: pieces are walked in spatial
// READING order (top→bottom, then left→right), NOT insertion order — so a
// SR/keyboard user steps through the layout the way the eye scans it, no matter
// how the arrangement was dragged together.
test('cyclePieceUid walks the placed pieces in reading order, wrapping both ways', () => {
  // Placed out of reading order: reading order is b(y0,x0) → a(y0,x50) → c(y100).
  const placed: Placed[] = [
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
  const one: Placed[] = [{ uid: 'x', x: 0, y: 0 }];
  assert.equal(cyclePieceUid(one, 'x'), 'x');
  assert.equal(cyclePieceUid(one, 'x', -1), 'x');
  assert.equal(cyclePieceUid(one, null), 'x');
});

test('resolvePlacement overlays the per-placement pick onto the model defaults', () => {
  const r: PieceModelMap = { a: { widthCm: 102, depthCm: 102, unitPrice: 1000, subtype: 'A' } };
  assert.equal(resolvePlacement({ pieceId: 'a' }, r).unitPrice, 1000);
  const picked = resolvePlacement({ pieceId: 'a', material: { unitPrice: 1500, subtype: 'G' } }, r);
  assert.equal(picked.unitPrice, 1500);
  assert.equal(picked.subtype, 'G');
  assert.equal(picked.widthCm, 102, 'geometry is never overridden by a pick');
  // An unknown piece resolves to an empty model rather than throwing.
  assert.deepEqual(resolvePlacement({ pieceId: 'nope' }, r), {});
});

// ── undo/redo: the configurator's history stack ─────────────────────────────

test('history push/undo/redo walks the placed snapshots; a new change clears redo', () => {
  const s0: Placed[] = [];
  const s1: Placed[] = [{ uid: 'u1' }];
  const s2: Placed[] = [{ uid: 'u1' }, { uid: 'u2' }];

  let h = makeHistory<Placed[]>();
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
  assert.equal(historyUndo(h, s0), null, 'nothing to undo on a fresh stack');
  assert.equal(historyRedo(h, s0), null, 'nothing to redo on a fresh stack');

  h = historyPush(h, s0);          // change s0 → s1
  h = historyPush(h, s1);          // change s1 → s2
  assert.equal(canUndo(h), true);

  const u1 = historyUndo(h, s2);   // back to s1
  assert.equal(u1?.present, s1);
  assert.equal(canRedo(u1?.hist), true);

  const u2 = historyUndo(u1!.hist, u1!.present);   // back to s0
  assert.equal(u2?.present, s0);
  assert.equal(canUndo(u2?.hist), false);

  const r1 = historyRedo(u2!.hist, u2!.present);   // forward to s1
  assert.equal(r1?.present, s1);
  const r2 = historyRedo(r1!.hist, r1!.present);   // forward to s2
  assert.equal(r2?.present, s2);
  assert.equal(canRedo(r2?.hist), false);

  // A NEW change after an undo abandons the redo branch.
  const back = historyUndo(h, s2);
  const branched = historyPush(back!.hist, back!.present);
  assert.equal(canRedo(branched), false);

  // The stack is bounded: oldest snapshots fall off, never grows past the limit.
  let cap = makeHistory<number[]>();
  for (let i = 0; i < 10; i++) cap = historyPush(cap, [i], 3);
  assert.equal(cap.past.length, 3);
  assert.deepEqual(cap.past, [[7], [8], [9]]);

  // …and the default limit is the configurator's 60.
  assert.equal(HISTORY_LIMIT, 60);
  let deep = makeHistory<number>();
  for (let i = 0; i < 80; i++) deep = historyPush(deep, i);
  assert.equal(deep.past.length, 60);
  assert.equal(deep.past[0], 20, 'the oldest 20 fell off');
});
