import test from 'node:test';
import assert from 'node:assert/strict';

import { splitSolids } from '../src/lib/configurator/solidSplit.js';

/** A box built THE WAY AN EXPORTER BUILDS ONE: every face carries its own four
 *  vertices (24 in total, no index shared between faces), because a hard normal
 *  splits the corner. This is the shape that makes index-based connectivity
 *  report six solids for one box. */
function box(cx, cy, cz, sx, sy = sx, sz = sx) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const corner = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const faces = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
    [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  const positions = []; const indices = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const ci of f) {
      const [x, y, z] = corner[ci];
      positions.push(x + cx, y + cy, z + cz);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
}

/** Concatenate several primitives into one buffer pair, as a GLB merges them. */
function merge(...parts) {
  const positions = []; const indices = [];
  for (const p of parts) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    for (const i of p.indices) indices.push(i + base);
  }
  return { positions, indices };
}

test('a hard-normal box is ONE solid — welding beats the exporter vertex split', () => {
  const b = box(0, 0, 0, 1);
  assert.equal(b.positions.length / 3, 24, 'fixture must reproduce the 24-vertex split');
  const { solids } = splitSolids(b);
  // Six faces sharing no index: connectivity over raw indices would say 6.
  assert.equal(solids.length, 1);
  assert.equal(solids[0].triangles.length, 12);
});

test('disjoint masses come back separately, largest first', () => {
  // A frame, a seat and a small cushion — three masses with air between them.
  const { solids } = splitSolids(merge(
    box(0, 0, 0, 2),
    box(10, 0, 0, 1.4),
    box(20, 0, 0, 0.8),
  ));
  assert.equal(solids.length, 3);
  const areas = solids.map((s) => s.area);
  assert.deepEqual([...areas].sort((a, b) => b - a), areas, 'ordered by area, descending');
  assert.ok(solids[0].center[0] < solids[1].center[0], 'largest is the one at the origin');
});

test('touching masses fuse — that is what "one solid" means', () => {
  // Two boxes sharing a face: physically one mass, and it must read as one.
  const { solids } = splitSolids(merge(box(0, 0, 0, 2), box(2, 0, 0, 2)));
  assert.equal(solids.length, 1);
  assert.equal(solids[0].triangles.length, 24);
});

test('trim is absorbed into the nearest mass, not offered as a part', () => {
  // A button on a cushion: real geometry, but nothing the dealer selects.
  const geo = merge(box(0, 0, 0, 2), box(0.9, 0.9, 0.9, 0.02));
  const { solids } = splitSolids(geo);
  assert.equal(solids.length, 1, 'the speck does not become a selectable part');
  assert.equal(solids[0].absorbed, 1);
  assert.equal(solids[0].triangles.length, 24, 'its triangles stay reachable in the host');

  // The debug/escape hatch keeps every fragment as its own mass.
  assert.equal(splitSolids({ ...geo, trimAreaRatio: 0 }).solids.length, 2);
});

test('a flat panel survives — area, not box volume, decides what is trim', () => {
  // A seat platform 2×2 and 1mm thin: its bounding VOLUME is ~0, so a
  // volume-based cut would delete it. It is a mass and must be kept.
  const { solids } = splitSolids(merge(box(0, 0, 0, 2, 0.001, 2), box(10, 0, 0, 2)));
  assert.equal(solids.length, 2);
});

test('the weld grid scales with the model — same shape in any unit', () => {
  const metres = merge(box(0, 0, 0, 2), box(10, 0, 0, 1));
  const millimetres = {
    positions: metres.positions.map((v) => v * 1000),
    indices: metres.indices,
  };
  assert.equal(splitSolids(metres).solids.length, 2);
  assert.equal(splitSolids(millimetres).solids.length, 2,
    'a fixed tolerance would blob these together at one scale or shatter them at the other');
});

test('non-indexed geometry works — triangles read three vertices at a time', () => {
  const b = box(0, 0, 0, 1);
  const flat = [];
  for (const i of b.indices) flat.push(b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]);
  const { solids } = splitSolids({ positions: flat });
  assert.equal(solids.length, 1);
  assert.equal(solids[0].triangles.length, 12);
});

test('order is deterministic — a re-detect never renumbers the parts', () => {
  // Equal-area masses: the tie-breaks must settle it, not Map iteration order.
  const geo = merge(box(0, 0, 0, 1), box(0, 5, 0, 1), box(0, 10, 0, 1));
  const once = splitSolids(geo).solids.map((s) => s.center[1]);
  const twice = splitSolids(geo).solids.map((s) => s.center[1]);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, [0, 5, 10], 'equal areas fall back to geometry, ascending');
});

test('junk in, empty out — never a throw', () => {
  assert.deepEqual(splitSolids().solids, []);
  assert.deepEqual(splitSolids({ positions: [] }).solids, []);
  assert.deepEqual(splitSolids({ positions: [0, 0, 0] }).solids, []);
  assert.deepEqual(splitSolids({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [9, 9, 9] }).solids, []);
  const nan = splitSolids({ positions: [NaN, NaN, NaN, 1, 0, 0, 0, 1, 0] });
  assert.ok(Array.isArray(nan.solids));
});

test('a degenerate all-coincident mesh is one mass, not a crash', () => {
  const { solids } = splitSolids({ positions: [0, 0, 0, 0, 0, 0, 0, 0, 0], indices: [0, 1, 2] });
  assert.equal(solids.length, 1);
});

/** An OPEN sheet — two triangles, boundary everywhere. The shape a zipper
 *  flap, a seam band or a decal arrives as. */
function sheet(cx, cy, cz, sx, sz) {
  const hx = sx / 2, hz = sz / 2;
  return {
    positions: [
      cx - hx, cy, cz - hz, cx + hx, cy, cz - hz,
      cx + hx, cy, cz + hz, cx - hx, cy, cz + hz,
    ],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

// ── The topology formula: a part is a SELF-CONTAINED BODY, never a 2D stripe.

test('REGRESSION (the screenshot): an open band on a cushion is dressing, not a part', () => {
  // 1% of the total area — comfortably past the old size-only trim cut, which
  // is exactly why it used to survive as a clickable "part". It is OPEN (all
  // rim), so no amount of area makes it a body.
  const { solids } = splitSolids(merge(box(0, 0, 0, 1), sheet(0, 0.55, 0, 1, 0.06)));
  assert.equal(solids.length, 1, 'the band folds into the cushion');
  assert.equal(solids[0].absorbed, 1);
  assert.equal(solids[0].triangles.length, 14, 'its triangles stay selectable inside the host');
});

test('a closed skinny ring around a cushion is dressing too — closedness alone is not enough', () => {
  // Four thin bars joined through mitre cubes whose end faces COINCIDE (edge-
  // connected, the way a real piping tube is one continuous strip): a closed
  // surface (zero rim), but it neither encloses volume for its size
  // (sphericity) nor fills the box it spans (a band wraps, a board fills).
  const ring = merge(
    box(0, 0, 0.51, 0.98, 0.02, 0.04), box(0, 0, -0.51, 0.98, 0.02, 0.04),
    box(0.51, 0, 0, 0.04, 0.02, 0.98), box(-0.51, 0, 0, 0.04, 0.02, 0.98),
    box(0.51, 0, 0.51, 0.04, 0.02, 0.04), box(-0.51, 0, 0.51, 0.04, 0.02, 0.04),
    box(0.51, 0, -0.51, 0.04, 0.02, 0.04), box(-0.51, 0, -0.51, 0.04, 0.02, 0.04),
  );
  assert.equal(splitSolids(ring).solids.length, 1, 'the four bars weld into one closed ring');
  const { solids } = splitSolids(merge(box(0, 0, 0, 1), ring));
  assert.equal(solids.length, 1, 'the ring folds into the cushion it wraps');
  assert.equal(solids[0].absorbed, 1);
});

test('REGRESSION (bodies broken up): a BIG open sheet is still dressing — size is not a road to part-hood', () => {
  // 40% of the mesh's area, far past the ≥15%-of-area clause that used to let
  // an open surface become a part on its own. That clause is what tore one
  // solid body into pieces: any large enough slice qualified, whether or not it
  // bounded a volume. A part is a CLOSED body or it is dressing.
  const { solids } = splitSolids(merge(box(0, 0, 0, 1), sheet(0, 2, 0, 2, 2)));
  assert.equal(solids.length, 1, 'the sheet folds into the body, however big it is');
  assert.equal(solids[0].absorbed, 1);
  assert.ok(solids[0].closed, 'what survives is the body');
});

test('the EXCLUSIF shape: every closed body is a part, and only the closed ones', () => {
  // The dealer's lounge chair as the file actually holds it — one authored mesh
  // carrying frame, seat cushion, back pillow, backrest pad and four legs, all
  // closed, plus the flat 2-triangle ground-shadow quad at the floor.
  const frame = box(0, 0.5, 0, 2, 1, 2);
  const seat = box(0, 1.2, 0, 1.6, 0.3, 1.6);
  const pillow = box(0, 1.9, 0.6, 1.6, 1.0, 0.3);
  const pad = box(0, 1.6, 0.85, 1.8, 1.4, 0.15);
  const legs = [[-0.8, -0.1, -0.8], [0.8, -0.1, -0.8], [-0.8, -0.1, 0.8], [0.8, -0.1, 0.8]]
    .map(([x, y, z]) => box(x, y, z, 0.15));
  const shadow = sheet(0, -0.02, 0, 2, 2);          // the floor decal — open, flat
  const { solids } = splitSolids(merge(frame, seat, pillow, pad, ...legs, shadow));
  assert.equal(solids.length, 8, 'frame + seat + pillow + pad + four legs');
  assert.ok(solids.every((s) => s.closed), 'every part is a closed body');
  assert.equal(solids.reduce((n, s) => n + s.absorbed, 0), 1, 'the shadow quad is absorbed, never a part');
});

test('legs survive: a small CLOSED body is a part, never trim', () => {
  const sofa = box(0, 0.6, 0, 2, 1, 1);
  const legs = [[-0.8, 0, -0.35], [0.8, 0, -0.35], [-0.8, 0, 0.35], [0.8, 0, 0.35]]
    .map(([x, y, z]) => box(x, y, z, 0.12));
  const { solids } = splitSolids(merge(sofa, ...legs));
  assert.equal(solids.length, 5, 'body + four legs, each its own part');
  assert.ok(solids.slice(1).every((s) => s.closed), 'legs classify as closed bodies');
});

test('dressing is absorbed by the body it HUGS, not the biggest one', () => {
  // Equal cubes far apart; the band hovers over the second. Nearest surface
  // owns it — a centroid or size rule would hand it to the wrong body.
  const { solids } = splitSolids(merge(box(0, 0, 0, 2), box(10, 0, 0, 2), sheet(10, 1.02, 0, 1, 0.4)));
  assert.equal(solids.length, 2);
  const host = solids.find((s) => Math.abs(s.center[0] - 10) < 0.1);
  assert.equal(host.absorbed, 1, 'the far cube absorbed it');
});

test('REGRESSION (the striped seat): T-junction tears heal — one authored surface, one part', () => {
  // The LR 3DS library tessellates one surface as pieces whose boundary
  // vertices COINCIDE but whose edges do not pair up (a T-junction: one long
  // edge meets two short ones). Edge-strict connectivity tore the gd canapé's
  // seat into two ≥15% halves — striped cushion. Vertex welding must heal it.
  const left = {
    positions: [0, 0, 0, 2, 0, 0, 0, 0, 1, 2, 0, 1, 0, 0, 2, 2, 0, 2],
    indices: [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4],
  };
  // Right half shares the border x=2 through vertices (2,0,0)·(2,0,1)·(2,0,2)
  // but spans it with ONE long edge (2,0,0)→(2,0,2): no edge pairs with the
  // left half's two short ones.
  const right = {
    positions: [2, 0, 0, 4, 0, 0, 2, 0, 2, 4, 0, 2],
    indices: [0, 1, 2, 1, 3, 2],
  };
  const { solids } = splitSolids(merge(left, right));
  assert.equal(solids.length, 1, 'the tear is a seam of the SAME surface, never a part boundary');
});

test('an all-sheet export degrades to the old size rule — never zero parts', () => {
  // Some cloth tools emit only open surfaces. With no bodies to absorb into,
  // big sheets must still come back as parts.
  const { solids } = splitSolids(merge(sheet(0, 0, 0, 1, 1), sheet(5, 0, 0, 1, 1)));
  assert.equal(solids.length, 2);
});
