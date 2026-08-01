// Mesh → top-down plan. Pins the silhouette raster/trace/simplify chain: the
// viewBox IS the real cm footprint, a solid region is ONE closed loop, and a
// concavity survives simplification. If this drifts, every 2D tile disagrees
// with its own 3D model.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { meshPlanFromTriangles, meshLoopsFromTriangles, simplifyClosed } from '../src/index.ts';

// Two triangles covering an axis-aligned rectangle [x0,x0+w] × [z0,z0+d].
const rect = (x0: number, z0: number, w: number, d: number) => [
  x0, z0, x0 + w, z0, x0 + w, z0 + d,
  x0, z0, x0 + w, z0 + d, x0, z0 + d,
];
const loopsOf = (d: string) => (d.match(/M/g) || []).length;
const vertsOf = (d: string) => (d.match(/[ML]/g) || []).length;

test('rectangle → viewBox is the footprint, one 4-point loop', () => {
  // Offset origin to prove the bbox is normalised to 0,0.
  const res = meshPlanFromTriangles(rect(10, 20, 100, 60));
  assert.equal(res.widthCm, 100);
  assert.equal(res.depthCm, 60);
  assert.match(res.svg, /viewBox="0 0 100 60"/);
  assert.match(res.svg, /stroke="currentColor"/);
  assert.equal(loopsOf(res.svg), 1, 'a solid rectangle is a single loop');
  assert.ok(res.svg.trim().endsWith('Z"/></svg>'), 'loop is closed');
  const v = vertsOf(res.svg);
  assert.ok(v >= 4 && v <= 6, `rectangle simplifies to ~4 corners, got ${v}`);
});

test('non-square corner footprint maps straight to the viewBox', () => {
  const res = meshPlanFromTriangles(rect(0, 0, 105, 130));
  assert.equal(res.widthCm, 105);
  assert.equal(res.depthCm, 130);
  assert.match(res.svg, /viewBox="0 0 105 130"/);
});

test('L-shape → one closed loop with the concavity (more than 4 corners)', () => {
  // Bottom band [0,100]×[50,100] ∪ top-left square [0,50]×[0,50] = an L.
  const tris = [...rect(0, 50, 100, 50), ...rect(0, 0, 50, 50)];
  const res = meshPlanFromTriangles(tris);
  assert.equal(res.widthCm, 100);
  assert.equal(res.depthCm, 100);
  assert.equal(loopsOf(res.svg), 1, 'the L is one connected region');
  const v = vertsOf(res.svg);
  assert.ok(v >= 5 && v <= 9, `an L has ~6 corners, got ${v}`);
  // The removed quadrant (75,25) must NOT be filled: the max-x vertices only
  // reach the lower band, so some boundary vertex sits at x≈50 mid-height.
  assert.ok(/L?50(\.\d+)? /.test(res.svg) || res.svg.includes('50 '), 'has the inner corner near x=50');
});

test('degenerate input → empty plan, never throws', () => {
  assert.equal(meshPlanFromTriangles([]).svg, '');
  assert.equal(meshPlanFromTriangles([0, 0, 1, 1, 2, 2]).svg, ''); // zero-area triangle
  assert.equal(meshPlanFromTriangles(null).svg, '');
  assert.equal(meshPlanFromTriangles(undefined).svg, '');
});

test('meshLoopsFromTriangles hands back the polygons the SVG draws', () => {
  const { loops, widthCm, depthCm, triCount } = meshLoopsFromTriangles(rect(0, 0, 100, 60));
  assert.equal(widthCm, 100);
  assert.equal(depthCm, 60);
  assert.equal(triCount, 2);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].length >= 4 && loops[0].length <= 6);
  // Every vertex sits inside the footprint — the loops are already in cm space.
  assert.ok(loops[0].every((p) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 60));
});

test('simplifyClosed drops collinear filler but keeps the corners', () => {
  // A square walked at 1-unit steps → still a square after simplification.
  const loop = [] as Array<{ x: number; y: number }>;
  for (let x = 0; x < 10; x++) loop.push({ x, y: 0 });
  for (let y = 0; y < 10; y++) loop.push({ x: 10, y });
  for (let x = 10; x > 0; x--) loop.push({ x, y: 10 });
  for (let y = 10; y > 0; y--) loop.push({ x: 0, y });
  const out = simplifyClosed(loop, 0.9);
  assert.equal(out.length, 4);
  // A degenerate (<4 point) loop is returned untouched.
  const tiny = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  assert.equal(simplifyClosed(tiny, 0.9), tiny);
});
