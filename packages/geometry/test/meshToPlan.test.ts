// Mesh → top-down plan. Pins the silhouette raster/trace/simplify chain: the
// viewBox IS the real cm footprint, a solid region is ONE closed loop, and a
// concavity survives simplification. If this drifts, every 2D tile disagrees
// with its own 3D model.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { meshPlanFromTriangles, meshLoopsFromTriangles, simplifyClosed, traceGridLoops } from '../src/index.ts';

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

/* ── The pinch ─────────────────────────────────────────────────────────────*/

/** An occupancy grid from a predicate over (gz, gx). */
const mask = (gw: number, gh: number, on: (gz: number, gx: number) => boolean) => {
  const occ = new Uint8Array(gw * gh);
  for (let gz = 0; gz < gh; gz++) for (let gx = 0; gx < gw; gx++) if (on(gz, gx)) occ[gz * gw + gx] = 1;
  return occ;
};
const bboxOf = (loop: Array<{ x: number; y: number }>) => {
  const xs = loop.map((p) => p.x), ys = loop.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

test('two islands touching at a CORNER are two loops, never one figure-eight', () => {
  // THE SCRIBBLE. The tracer walks directed edges with the fill on its left, and
  // at a diagonal pinch — two cells meeting only at a corner — four edges cross
  // one vertex, two in and two out. Taking the wrong pair welds the two islands
  // into ONE loop that visits the pinch TWICE, and every step after that goes
  // wrong: an outward bias pushes the two visits in opposite directions so the
  // stroke draws an X across the empty gap, and a band smoother is handed a
  // self-crossing curve and drags one lobe through the other. Measured before
  // the fix: two 6×6 blocks came back as ONE 48-point loop.
  // The walk takes the LEFT-most turn now, which always hugs the island it
  // arrived on.
  const GW = 20, GH = 20;
  const blocks = mask(GW, GH, (gz, gx) =>
    (gz >= 2 && gz <= 7 && gx >= 2 && gx <= 7) || (gz >= 8 && gz <= 13 && gx >= 8 && gx <= 13));
  const loops = traceGridLoops(blocks, GW, GH, 1, 1, 0);
  assert.equal(loops.length, 2, 'two solids, two loops');
  for (const loop of loops) {
    const b = bboxOf(loop);
    // Each loop stays on its OWN 6×6 block — a welded loop would span both, 12×12.
    assert.ok(b.w <= 6 && b.h <= 6, `loop hugs one block (${b.w}×${b.h}), never both`);
    // And no vertex is visited twice: a self-touching loop is what makes an
    // outward offset ambiguous in the first place.
    const seen = new Set(loop.map((p) => `${p.x},${p.y}`));
    assert.equal(seen.size, loop.length, 'the loop never passes through the same point twice');
  }

  // A CHAIN of them is the pathological case — each pinch used to weld the next
  // solid on, so the whole run came back as one loop threading every gap.
  const chain = mask(14, 14, (gz, gx) => {
    for (let i = 0; i < 4; i++) {
      const o = 1 + i * 3;
      if (gz >= o && gz < o + 3 && gx >= o && gx < o + 3) return true;
    }
    return false;
  });
  assert.equal(traceGridLoops(chain, 14, 14, 1, 1, 0).length, 4, 'four corner-touching solids are four islands');
});

test('an island whose OWN boundary pinches is still one loop', () => {
  // A C whose arms meet at a corner genuinely touches itself. The turn rule must
  // not shatter it: the fix is about telling two islands apart, not about
  // splitting one.
  const GW = 8, GH = 8;
  const c = mask(GW, GH, (gz, gx) =>
    (gz >= 1 && gz <= 5 && gx >= 1 && gx <= 2)     // the spine
    || (gz === 1 && gx <= 4)                        // top arm
    || (gz === 5 && gx <= 4));                      // bottom arm
  const loops = traceGridLoops(c, GW, GH, 1, 1, 0);
  assert.equal(loops.length, 1, 'one connected island, one outline');
});

test('a solid with a hole is its outline PLUS the hole, both closed', () => {
  const GW = 10, GH = 10;
  const ring = mask(GW, GH, (gz, gx) => {
    const inBlock = gz >= 1 && gz <= 8 && gx >= 1 && gx <= 8;
    const inHole = gz >= 4 && gz <= 5 && gx >= 4 && gx <= 5;
    return inBlock && !inHole;
  });
  const loops = traceGridLoops(ring, GW, GH, 1, 1, 0);
  assert.equal(loops.length, 2, 'the outer boundary and the hole');
  const areas = loops.map((l) => Math.abs(l.reduce((s, p, i) => {
    const q = l[(i + 1) % l.length];
    return s + (p.x * q.y - q.x * p.y);
  }, 0) / 2)).sort((a, b) => b - a);
  assert.equal(areas[0], 64);
  assert.equal(areas[1], 4);
});
