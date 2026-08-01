/**
 * SILHOUETTE — the PURE half of the GPU-silhouette pipeline. The stage renders
 * the GL half (the selected piece alone, white and unlit, into an offscreen
 * target); everything here is arithmetic over the readback, so it unit-tests in
 * Node with no renderer at all.
 *
 * No three.js: these are grids and polygons.
 */
import { traceGridLoops } from '@veta/geometry';
import type { Point2 } from './types.ts';

/**
 * The boundary tracer, RE-EXPORTED from `@veta/geometry` (CONTRACTS.md lists it
 * under this package's silhouette utilities, and geometry owns the
 * implementation). ONE tracer, two rasters: the top-down plan feeds it occupancy
 * from floor triangles, and the on-screen silhouette below feeds it occupancy
 * from a camera-projected render.
 */
export { traceGridLoops };

/** Twice-signed area / 2 of a polygon — sign carries the winding. */
export function loopArea(poly: readonly Point2[]): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; s += p.x * q.y - q.x * p.y; }
  return s / 2;
}

// Offset a closed loop from `traceGridLoops` a hair OUTWARD along its own edge
// normals. The tracer walks outer loops with the filled region on the LEFT (in
// y-down screen coords), so "outward" is the RIGHT of travel: n̂ = (−t̂y, t̂x)
// with t̂ = next − prev (check against the tracer's top edge: travel (−1,0),
// filled below, outward (0,−1) ✓). Normal-based (not centroid-radial) so a
// CONCAVE notch offsets away from the piece too — a radial push points the wrong
// way inside a notch.
export function offsetLoopOutward(poly: readonly Point2[], dist: number): Point2[] {
  const n = poly.length;
  if (n < 3 || !(dist > 0)) return poly.slice();
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
    const tx = b.x - a.x, ty = b.y - a.y;
    const L = Math.hypot(tx, ty) || 1;
    return { x: p.x - (ty / L) * dist, y: p.y + (tx / L) * dist };
  });
}

// Uniform arc-length resample of a CLOSED loop to ~`spacing` px between points.
// The smoother below assumes an even parameterisation (its Laplacian weights are
// uniform), and even spacing means no boundary feature is under- or over-weighted.
export function resampleUniform(pts: readonly Point2[], spacing = 2): Point2[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const seg = new Array<number>(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    seg[i] = Math.hypot(b.x - a.x, b.y - a.y);
    total += seg[i];
  }
  if (!(total > 0)) return pts.slice();
  const count = Math.max(12, Math.round(total / spacing));
  const step = total / count;
  const out: Point2[] = [];
  let i = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const t = k * step;
    while (i < n - 1 && acc + seg[i] < t) { acc += seg[i]; i++; }
    const a = pts[i], b = pts[(i + 1) % n];
    const f = seg[i] > 1e-9 ? (t - acc) / seg[i] : 0;
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return out;
}

/** Tuning for the taut-string smoother. */
export interface SmoothLoopOptions {
  iters?: number;
  lambda?: number;
  /** The fidelity band's half-width, in the loop's own units (px). */
  clampPx?: number;
}

// The TAUT STRING through the error tube — smoothing inside a FIDELITY BAND.
// The traced boundary only knows the silhouette to ±half a cell, so every curve
// within `clampPx` of it is an equally valid trace; this picks the one a string
// pulled tight through that tube would take. Mechanism: plain Laplacian
// relaxation (each point moves toward its neighbours' midpoint), iterated to
// CONVERGENCE, with every point clamped back into the tube after each pass.
// Run to equilibrium — not a small fixed budget — because stair noise is NOT
// always high-frequency: a nearly axis-aligned edge steps sideways only every
// cell/slope px (slope 0.05 → one jog per ~60 px), and a band-limited smoother
// (the previous few-iteration Taubin) preserves exactly those long waves — the
// residual "jagged" read. The taut string is straight wherever the tube allows
// AT ANY WAVELENGTH; real corners survive because the clamp arrests the pull at
// ~clampPx — corner rounding is capped at the band, never proportional. Typed-
// array ping-pong keeps 300 passes over ~1k points around a millisecond.
export function smoothLoopConstrained(
  pts: readonly Point2[],
  { iters = 300, lambda = 0.5, clampPx = 2.2 }: SmoothLoopOptions = {},
): Point2[] {
  const n = pts.length;
  if (n < 8) return pts.slice();
  const ax = new Float64Array(n), ay = new Float64Array(n);   // the tube's anchors
  let px = new Float64Array(n), py = new Float64Array(n);
  let qx = new Float64Array(n), qy = new Float64Array(n);
  for (let i = 0; i < n; i++) { ax[i] = pts[i].x; ay[i] = pts[i].y; px[i] = pts[i].x; py[i] = pts[i].y; }
  const c2 = clampPx * clampPx;
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < n; i++) {
      const l = i ? i - 1 : n - 1, r = i + 1 < n ? i + 1 : 0;
      let x = px[i] + lambda * ((px[l] + px[r]) / 2 - px[i]);
      let y = py[i] + lambda * ((py[l] + py[r]) / 2 - py[i]);
      const dx = x - ax[i], dy = y - ay[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > c2) { const s = clampPx / Math.sqrt(d2); x = ax[i] + dx * s; y = ay[i] + dy * s; }
      qx[i] = x; qy[i] = y;
    }
    let t = px; px = qx; qx = t;
    t = py; py = qy; qy = t;
  }
  const out = new Array<Point2>(n);
  for (let i = 0; i < n; i++) out[i] = { x: px[i], y: py[i] };
  return out;
}

/** Options for `maskToOutline`. */
export interface MaskToOutlineOptions {
  /** CSS px of the mask's top-left corner. */
  x?: number;
  y?: number;
  /** CSS px per mask cell. */
  cell?: number;
  /** How far outward to push the traced boundary, px. */
  bias?: number;
  /** Smoothing band floor, px. 0 disables smoothing entirely. */
  smoothPx?: number;
  /** Outline EVERY island rather than only the largest. */
  allLoops?: boolean;
}

/**
 * Trace a rendered coverage MASK into the selection outline, in CSS pixels — the
 * PURE half of the GPU-silhouette pipeline (the stage renders the GL half).
 *
 * The outline the user asks for is the OUTER ENVELOPE of the piece's projection:
 * ∂(P(S)) — the boundary of the set of screen points the 3D surface covers. The
 * one authority on that set is the rasterizer itself, so the stage renders the
 * SELECTED PIECE ALONE (white, unlit, double-sided) through the LIVE camera into
 * an offscreen target and hands the readback here. Tracing that mask IS the
 * outermost projection of the figure — every concavity included, exact at cell
 * resolution, with zero geometric assumptions (any triangle soup, open meshes,
 * self-intersecting parts all rasterise correctly).
 *
 * `pixels` is the RGBA readback (WebGL row order: row 0 = the BOTTOM row — the
 * rows are flipped here), `gw`×`gh` cells of `cell` CSS px each, the mask's
 * top-left corner at CSS (`x`,`y`). Filled = red channel > 127 (the mask renders
 * white on black). The traced boundary keeps only its LARGEST loop (a speck of
 * geometry — a floating tassel — must not steal the outline), is smoothed within
 * the quantisation band (`smoothLoopConstrained` — the curve analogue of the
 * mesh facet smoothing), and offsets `bias` px outward along its normals.
 * Returns `[{x,y}, …]` CSS px, or null when the mask is empty/degenerate.
 */
export function maskToOutline(
  pixels: Uint8Array | Uint8ClampedArray | number[] | null | undefined,
  gw: number,
  gh: number,
  options: MaskToOutlineOptions & { allLoops: true },
): Point2[][] | null;
export function maskToOutline(
  pixels: Uint8Array | Uint8ClampedArray | number[] | null | undefined,
  gw: number,
  gh: number,
  options?: MaskToOutlineOptions,
): Point2[] | null;
export function maskToOutline(
  pixels: Uint8Array | Uint8ClampedArray | number[] | null | undefined,
  gw: number,
  gh: number,
  { x = 0, y = 0, cell = 1, bias = 1.4, smoothPx = 2.2, allLoops = false }: MaskToOutlineOptions = {},
): Point2[] | Point2[][] | null {
  if (!pixels || !(gw > 1) || !(gh > 1) || !(cell > 0)) return null;
  const occ = new Uint8Array(gw * gh);
  let any = false;
  for (let r = 0; r < gh; r++) {
    const src = r * gw * 4, dst = (gh - 1 - r) * gw;   // flip WebGL's bottom-up rows
    for (let c = 0; c < gw; c++) {
      if (pixels[src + c * 4] > 127) { occ[dst + c] = 1; any = true; }
    }
  }
  if (!any) return null;
  // eps 0 = RAW pixel-true boundary. The default DP compaction trades the
  // stairs' high-frequency ±half-cell error for ±eps endpoint error at 20–50 px
  // segment wavelengths — a gentle UNDULATION the band-limited smoother below
  // preserves (low frequencies pass by design), which read as a wavy outline
  // on straight sofa edges. The raw stairs carry only high-frequency error,
  // which the smoother removes completely — truer AND smoother.
  const loops = traceGridLoops(occ, gw, gh, cell, cell, 0);
  if (!loops.length) return null;
  let best = loops[0], bestA = Math.abs(loopArea(best));
  for (let i = 1; i < loops.length; i++) {
    const a = Math.abs(loopArea(loops[i]));
    if (a > bestA) { bestA = a; best = loops[i]; }
  }
  if (best.length < 3) return null;
  // One traced loop → its final screen polygon. The smoothing band is sized
  // from the loop's OWN extent, which is why this runs per loop rather than
  // once for the set: a small leg must not be smoothed with a seat's band.
  const finish = (loop: Point2[]): Point2[] => {
    const abs = loop.map((p) => ({ x: p.x + x, y: p.y + y }));
    // With the raw trace the only noise is the ±half-cell stair — the tube can
    // sit just past it (1.25·cell), so the taut string is pixel-true. Capped by
    // the loop's own extent: a TINY loop (a small piece, far zoom) would
    // otherwise fit entirely inside the tube and the string would eat it.
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of abs) { if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x; if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y; }
    const band = Math.min(Math.max(smoothPx, cell * 1.25), Math.max(1, Math.min(mxx - mnx, mxy - mny) / 6));
    const smoothed = smoothPx > 0
      ? smoothLoopConstrained(resampleUniform(abs, Math.max(1, cell)), { clampPx: band })
      : abs;
    return offsetLoopOutward(smoothed, bias);
  };
  if (!allLoops) return finish(best);
  // EVERY island, not just the biggest — a selection can be several disjoint
  // solids (four legs, a pair of cushions), and outlining only the largest
  // says the others aren't selected when they are. Loops winding against the
  // largest are HOLES (offsetting one outward would push it the wrong way),
  // and sub-cell loops are rasterizer speckle; both are dropped.
  const sign = Math.sign(loopArea(best)) || 1;
  const minArea = cell * cell * 4;
  const out: Point2[][] = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const a = loopArea(loop);
    if (Math.sign(a) !== sign || Math.abs(a) < minArea) continue;
    const poly = finish(loop);
    if (poly && poly.length >= 3) out.push(poly);
  }
  return out.length ? out : [finish(best)];
}
