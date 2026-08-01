// Mesh triangles → plan. Pins the FLOOR slice: only the lower body (default 40%
// of the model's height) feeds the footprint, so a leaning backrest roll can't
// widen the tile past the piece's real platform — and the whole-silhouette
// fallback that saves a flat-on-the-floor export.
import test from 'node:test';
import assert from 'node:assert/strict';

import { floorTriangles, meshPlanFromVertices, vertexBounds, FLOOR_CUT_FRAC } from '../src/index.ts';

/** Two world-space triangles covering the horizontal quad [x0,x0+w] × [z0,z0+d] at height y. */
const slab = (y: number, x0: number, z0: number, w: number, d: number) => [
  x0, y, z0, x0 + w, y, z0, x0 + w, y, z0 + d,
  x0, y, z0, x0 + w, y, z0 + d, x0, y, z0 + d,
];

test('vertexBounds measures the model; empty input is null, never a throw', () => {
  const b = vertexBounds(slab(5, 10, 20, 100, 60))!;
  assert.deepEqual(b.min, [10, 5, 20]);
  assert.deepEqual(b.max, [110, 5, 80]);
  assert.deepEqual(b.size, [100, 0, 60]);
  assert.equal(vertexBounds([]), null);
  assert.equal(vertexBounds(null), null);
});

test('floorTriangles keeps the lower body and drops the overhanging backrest', () => {
  // A 100×60 platform at the floor, plus a roll at the top that overhangs to z=80.
  const verts = [...slab(0, 0, 0, 100, 60), ...slab(10, 0, 0, 100, 60), ...slab(60, 0, 0, 100, 80)];
  assert.equal(FLOOR_CUT_FRAC, 0.4);
  const tris = floorTriangles(verts);
  assert.equal(tris.length, 4 * 6, 'the two floor slabs only (4 triangles × 6 numbers)');

  const plan = meshPlanFromVertices(verts)!;
  assert.equal(plan.widthCm, 100);
  assert.equal(plan.depthCm, 60, 'the overhang never inflates the footprint');
  assert.match(plan.svg, /viewBox="0 0 100 60"/);

  // The whole silhouette DOES see the overhang — the slice is what protects it.
  const whole = meshPlanFromVertices(verts, { cutFrac: 1 })!;
  assert.equal(whole.depthCm, 80);
});

test('the origin moves to the footprint corner and units are auto-corrected', () => {
  // The same 100×60 platform, offset in world space and exported in METRES.
  const metres = [...slab(0, 3, 7, 1, 0.6), ...slab(0.1, 3, 7, 1, 0.6)];
  const plan = meshPlanFromVertices(metres)!;
  assert.equal(plan.widthCm, 100, 'a metre export lands at real cm');
  assert.equal(plan.depthCm, 60);
  assert.match(plan.svg, /viewBox="0 0 100 60"/);
});

test('z-up exports use the XY floor plane', () => {
  // Same platform authored z-up: [x, y(depth), z(height)].
  const verts = [
    0, 0, 0, 100, 0, 0, 100, 60, 0,
    0, 0, 0, 100, 60, 0, 0, 60, 0,
    0, 0, 40, 100, 0, 40, 100, 60, 40,
  ];
  const plan = meshPlanFromVertices(verts, { upAxis: 'z' })!;
  assert.equal(plan.widthCm, 100);
  assert.equal(plan.depthCm, 60);
});

test('a degenerate lower slice falls back to the WHOLE silhouette', () => {
  // The bottom 40% is a zero-depth wall (no footprint at all); the real platform
  // sits above the cut. Without the fallback this piece would have no plan.
  const wall = [
    0, 0, 0, 100, 0, 0, 100, 20, 0,
    0, 0, 0, 100, 20, 0, 0, 20, 0,
  ];
  const plan = meshPlanFromVertices([...wall, ...slab(50, 0, 0, 100, 60)])!;
  assert.equal(plan.widthCm, 100);
  assert.equal(plan.depthCm, 60);
});

test('no usable geometry → null, never a throw', () => {
  assert.equal(meshPlanFromVertices(null), null);
  assert.equal(meshPlanFromVertices([]), null);
  assert.equal(meshPlanFromVertices(slab(0, 0, 0, 100, 60)), null, 'zero height → no vertical slice');
  assert.deepEqual(floorTriangles(null), []);
  assert.deepEqual(floorTriangles([1, 2, 3]), []);
});
