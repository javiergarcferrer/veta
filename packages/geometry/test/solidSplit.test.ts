// SOLID SEGMENTATION — the pure math behind clicking a cushion instead of the
// scatter of shreds that happens to share its fabric.
//
// The pins here are the four things the naive version gets wrong: an exporter's
// vertex split is not a disconnection (weld first), TOUCHING is one mass, trim
// is absorbed by AREA (a 1 mm platform is real geometry whose box volume is ~0),
// and the order is deterministic — a re-detect that renumbered the parts would
// strand every part choice the dealer has already made.
import test from 'node:test';
import assert from 'node:assert/strict';

import { splitSolids } from '../src/index.ts';

/** A box built THE WAY AN EXPORTER BUILDS ONE: every face carries its own four
 *  vertices (24 in total, no index shared between faces), because a hard normal
 *  splits the corner. This is the shape that makes index-based connectivity
 *  report six solids for one box. */
function box(cx: number, cy: number, cz: number, sx: number, sy: number = sx, sz: number = sx) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const corner = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const faces = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
    [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  const positions: number[] = []; const indices: number[] = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const ci of f) {
      const [x, y, z] = corner[ci]!;
      positions.push(x! + cx, y! + cy, z! + cz);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
}

/** Concatenate several primitives into one buffer pair, as a GLB merges them. */
function merge(...parts: { positions: number[]; indices: number[] }[]) {
  const positions: number[] = []; const indices: number[] = [];
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
  assert.equal(solids[0]!.triangles.length, 12);
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
  assert.ok(solids[0]!.center[0] < solids[1]!.center[0], 'largest is the one at the origin');
});

test('touching masses fuse — that is what "one solid" means', () => {
  // Two boxes sharing a face: physically one mass, and it must read as one.
  const { solids } = splitSolids(merge(box(0, 0, 0, 2), box(2, 0, 0, 2)));
  assert.equal(solids.length, 1);
  assert.equal(solids[0]!.triangles.length, 24);
});

test('trim is absorbed into the nearest mass, not offered as a part', () => {
  // A button on a cushion: real geometry, but nothing the dealer selects.
  const geo = merge(box(0, 0, 0, 2), box(0.9, 0.9, 0.9, 0.02));
  const { solids } = splitSolids(geo);
  assert.equal(solids.length, 1, 'the speck does not become a selectable part');
  assert.equal(solids[0]!.absorbed, 1);
  assert.equal(solids[0]!.triangles.length, 24, 'its triangles stay reachable in the host');

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
  const flat: number[] = [];
  for (const i of b.indices) flat.push(b.positions[i * 3]!, b.positions[i * 3 + 1]!, b.positions[i * 3 + 2]!);
  const { solids } = splitSolids({ positions: flat });
  assert.equal(solids.length, 1);
  assert.equal(solids[0]!.triangles.length, 12);
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
