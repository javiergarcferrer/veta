// Ported verbatim from RosetSoft `tests/togoSilhouette.test.js`.
//
// maskToOutline is the PURE half of the GPU-silhouette pipeline: the stage
// renders the selected piece alone into an offscreen target and hands the RGBA
// readback here; tracing that mask IS the outer envelope of the piece's
// projection. These tests build masks directly — in WebGL's row order (row 0 =
// the BOTTOM row), exactly what readRenderTargetPixels returns — so the row
// flip, loop choice, offset direction and precision are all pinned in Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskToOutline } from '../src/index.ts';
import type { Point2 } from '../src/index.ts';

// Build an RGBA buffer from a screen-space (top-down) fill callback.
function makeMask(gw: number, gh: number, filled: (screenRow: number, col: number) => boolean): Uint8Array {
  const pix = new Uint8Array(gw * gh * 4);
  for (let sr = 0; sr < gh; sr++) {
    const r = gh - 1 - sr;                        // WebGL rows are bottom-up
    for (let c = 0; c < gw; c++) {
      if (filled(sr, c)) pix[(r * gw + c) * 4] = 255;
    }
  }
  return pix;
}
const polyArea = (poly: readonly Point2[]) => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p.x * q.y - q.x * p.y; }
  return Math.abs(s) / 2;
};
const bbox = (pts: readonly Point2[]) => {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const p of pts) { if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x; if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y; }
  return { minX: mnx, minY: mny, maxX: mxx, maxY: mxy, w: mxx - mnx, h: mxy - mny };
};

// A structured-sofa morphology as a mask: a low platform band along the bottom
// plus a tall back over its right end — the L whose notch the outline MUST
// carve. Screen cells: platform rows 90..119 × cols 0..149; back rows 20..119 ×
// cols 100..149. At cell=2: L area = (150·30 + 50·70)·4 = 32 000 px²; the convex
// closure of the L adds ~14 000 px² of open air — the bridge the owner rejected.
const L_GW = 150, L_GH = 120, L_CELL = 2, L_OX = 100, L_OY = 50;
const lMask = () => makeMask(L_GW, L_GH, (sr, c) => (sr >= 90) || (sr >= 20 && c >= 100));

test('the L is traced exactly — notch carved, never bridged', () => {
  const pts = maskToOutline(lMask(), L_GW, L_GH, { x: L_OX, y: L_OY, cell: L_CELL })!;
  assert.ok(pts && pts.length >= 6, 'an outline loop is returned');
  const area = polyArea(pts);
  // L (32 000) + the outward bias (~perimeter 1000 px × 1.4) — far below the
  // ~46 000 px² a convex envelope of the same mask would produce.
  assert.ok(area > 31500 && area < 35500, `hugs the L (~33.4k px²), got ${area.toFixed(0)}`);
  // The notch's interior corner — screen (300, 230) after the origin offset —
  // must have outline passing right at it (bias + capped smoothing only).
  const corner = { x: L_OX + 200, y: L_OY + 180 };
  let dMin = Infinity;
  for (const p of pts) { const d = Math.hypot(p.x - corner.x, p.y - corner.y); if (d < dMin) dMin = d; }
  assert.ok(dMin < 12, `the outline dips to the notch corner (min distance ${dMin.toFixed(1)}px)`);
  // And the whole loop stays inside the mask rect (+bias margin) — no ballooning.
  const b = bbox(pts);
  assert.ok(b.minX > L_OX - 6 && b.maxX < L_OX + 300 + 6, 'x stays within the mask + bias');
  assert.ok(b.minY > L_OY + 40 - 6 && b.maxY < L_OY + 240 + 6, 'y stays within the mask + bias');
});

test('WebGL row order is flipped: a top-of-screen band maps to small CSS y', () => {
  // Filled ONLY in screen rows 0..1 — which live in the BOTTOM rows of the
  // WebGL buffer. Un-flipped, the outline would land at the bottom (y 40..60).
  const pts = maskToOutline(makeMask(8, 6, (sr) => sr <= 1), 8, 6, { x: 0, y: 0, cell: 10 })!;
  assert.ok(pts && pts.length >= 4);
  const b = bbox(pts);
  assert.ok(b.maxY < 26, `the band sits at the TOP (maxY ${b.maxY.toFixed(1)} < 26)`);
  assert.ok(b.w > 70, 'spans the full width');
});

test('the largest region wins — a distant speck never steals the outline', () => {
  const pts = maskToOutline(
    makeMask(20, 20, (sr, c) => (sr < 10 && c < 10) || (sr === 19 && c === 19)),
    20, 20, { x: 0, y: 0, cell: 2 },
  )!;
  const b = bbox(pts);
  assert.ok(b.maxX < 25 && b.maxY < 25, `outline is the blob, not the speck (bbox max ${b.maxX.toFixed(0)},${b.maxY.toFixed(0)})`);
});

test('allLoops outlines EVERY island — a joined part is not just its biggest solid', () => {
  // «Unir mallas» makes ONE part out of meshes that are usually disjoint in
  // space (four legs, a pair of cushions). Outlining only the largest would say
  // the rest aren't selected when they are — the default single-loop behavior
  // stays as it was for every other caller.
  const two = makeMask(24, 10, (sr, c) => (sr >= 2 && sr <= 7 && c >= 2 && c <= 7)
    || (sr >= 2 && sr <= 7 && c >= 16 && c <= 21));
  const one = maskToOutline(two, 24, 10, { x: 0, y: 0, cell: 2 })!;
  assert.ok(one && typeof one[0]?.x === 'number', 'default still returns ONE loop of points');
  const loops = maskToOutline(two, 24, 10, { x: 0, y: 0, cell: 2, allLoops: true })!;
  assert.equal(loops.length, 2, 'both islands are traced');
  const boxes = loops.map(bbox).sort((a, b) => a.minX - b.minX);
  assert.ok(boxes[0].maxX < boxes[1].minX, 'and they are SEPARATE outlines, never bridged');
  // Rasterizer speckle is not a piece: a single stray cell never gets a line.
  const speck = maskToOutline(
    makeMask(20, 20, (sr, c) => (sr < 10 && c < 10) || (sr === 19 && c === 19)),
    20, 20, { x: 0, y: 0, cell: 2, allLoops: true },
  )!;
  assert.equal(speck.length, 1, 'the blob only — the one-cell speck is dropped');
});

test('the bias offsets OUTWARD (area grows), even around the concave notch', () => {
  const a0 = polyArea(maskToOutline(lMask(), L_GW, L_GH, { x: 0, y: 0, cell: L_CELL, bias: 0 })!);
  const a1 = polyArea(maskToOutline(lMask(), L_GW, L_GH, { x: 0, y: 0, cell: L_CELL, bias: 1.4 })!);
  assert.ok(a1 > a0, `bias grows the loop (${a1.toFixed(0)} > ${a0.toFixed(0)}) — a wrong normal sign would shrink it`);
});

test('curved silhouettes smooth to a flowing curve inside the fidelity band', () => {
  // A disc is the pure curved case: the raster trace + simplification leave
  // ±cell vertex noise — sharp kinks every ~10 px, the "faceted" wobble the raw
  // outline showed on a sofa's curves. The constrained smoother (Laplacian
  // passes clamped to the quantisation band — the curve analogue of the mesh
  // facet smoothing) must melt the kinks WITHOUT drifting off the true circle.
  const GW = 64, GH = 64, CELL = 2, CX = 64, CY = 64, R = 56;
  const disc = makeMask(GW, GH, (sr, c) => {
    const px = c * CELL + 1, py = sr * CELL + 1;
    return (px - CX) ** 2 + (py - CY) ** 2 <= R * R;
  });
  const kinkOf = (pts: readonly Point2[]) => {
    let m = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], p = pts[i], b = pts[(i + 1) % pts.length];
      const d2 = Math.hypot(a.x - 2 * p.x + b.x, a.y - 2 * p.y + b.y);
      if (d2 > m) m = d2;
    }
    return m;
  };
  const smoothed = maskToOutline(disc, GW, GH, { x: 0, y: 0, cell: CELL })!;
  const raw = maskToOutline(disc, GW, GH, { x: 0, y: 0, cell: CELL, smoothPx: 0 })!;
  // Fidelity: every point stays just outside the true circle (bias) and within
  // the quantisation band — the smoother may never shrink into or balloon off it.
  // The taut string may sit up to ~(clamp − bias) inside the true rim on
  // constant convex curvature — sub-stroke-width, invisible; never outside +band.
  for (const p of smoothed) {
    const r = Math.hypot(p.x - CX, p.y - CY);
    assert.ok(r > R - 1.2 && r < R + 3.2, `radius ${r.toFixed(2)} hugs the circle (R=${R})`);
  }
  // Smoothness: the kink metric (max second difference) collapses — measured
  // 0.28 smoothed vs 3.4 for the raw stair trace; bounds with margin pin the
  // ORDER of the contrast, not the noise.
  assert.ok(kinkOf(smoothed) < 0.7, `smoothed curve flows (kink ${kinkOf(smoothed).toFixed(2)} < 0.7)`);
  assert.ok(kinkOf(raw) > 2, `raw trace is faceted (kink ${kinkOf(raw).toFixed(1)} > 2) — the contrast the smoother exists for`);
  // Roundness: the smoothed radius ripple is sub-pixel (measured 0.74 px) —
  // the undulation the owner flagged is gone, not just reduced.
  let rMin = Infinity, rMax = -Infinity;
  for (const p of smoothed) { const r = Math.hypot(p.x - CX, p.y - CY); if (r < rMin) rMin = r; if (r > rMax) rMax = r; }
  assert.ok(rMax - rMin < 1.2, `radius ripple is sub-pixel-ish (${(rMax - rMin).toFixed(2)} < 1.2)`);
});

test('a shallow-angle straight edge traces STRAIGHT — no undulation', () => {
  // The exact case that undulated on the sofa: a long, nearly-horizontal
  // silhouette edge. DP used to turn its pixel stairs into ±2 px waves at
  // 20–50 px wavelengths; with the raw trace + band smoothing the outline must
  // sit at a CONSTANT offset from the true line (span < 1.4 px — measured 0.94).
  const GW = 120, GH = 60, CELL = 2, slope = 0.18, icpt = 40;
  const mask = makeMask(GW, GH, (sr, c) => {
    const px = c * CELL + 1, py = sr * CELL + 1;
    return py >= slope * px + icpt;
  });
  const pts = maskToOutline(mask, GW, GH, { x: 0, y: 0, cell: CELL })!;
  assert.ok(pts && pts.length >= 8);
  const devs: number[] = [];
  for (const p of pts) {
    const d = (p.y - (slope * p.x + icpt)) / Math.sqrt(1 + slope * slope);
    if (p.x > 30 && p.x < 210 && Math.abs(d) < 10) devs.push(d);
  }
  assert.ok(devs.length > 40, `plenty of samples along the edge (${devs.length})`);
  const span = Math.max(...devs) - Math.min(...devs);
  assert.ok(span < 1.4, `the edge is straight — deviation span ${span.toFixed(2)}px < 1.4`);
});

test('degenerate input → null, never throws', () => {
  assert.equal(maskToOutline(null, 10, 10, {}), null);
  assert.equal(maskToOutline(makeMask(10, 10, () => false), 10, 10, {}), null, 'empty mask');
  assert.equal(maskToOutline(makeMask(10, 10, () => true), 1, 1, {}), null, 'degenerate dims');
});
