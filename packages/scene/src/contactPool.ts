/**
 * THE CONTACT POOL — a product photo's ground shadow, as DATA.
 *
 * The reference stills a dealer judges this renderer against show NO directional
 * throw anywhere: one wide, feathered pool hugging the piece's footprint. Shadow
 * maps fundamentally cannot produce it for flush-floor furniture — a sofa sits ON
 * the floor, so from any caster the occluder and receiver depths coincide at the
 * contact and the shadow term vanishes there (measured upstream: VSM erased it
 * outright on the harness sofa, which is why the quality tier casts no shadow
 * maps at all and grounds itself with this instead).
 *
 * So the pool is painted, not traced: an OPAQUE floor plate whose texture is the
 * ground colour with dark blobs drawn into it, fed from piece-footprint DATA. The
 * drawing itself is three outward passes and lives in `stage.ts` on a 2D canvas —
 * but the RULE the canvas executes (which passes, how far out, how dark, and
 * where a world rect lands on the plate) is all here, pure and canvas-free, so it
 * can be pinned by a test on a machine with no GL and no DOM.
 *
 * A flush-floor piece hides everything INSIDE its own footprint under itself
 * (found the hard way upstream: an inset "core" pass was invisible by
 * construction), so every pass but the contact line reaches OUTWARD.
 */

/** A piece's footprint on the floor, in world cm — centre, size, plan yaw. */
export interface PoolRect {
  x: number;
  z: number;
  w: number;
  d: number;
  /** Plan rotation in degrees (screen-clockwise, as the plan stores it). */
  deg?: number;
}

/** One drawing pass: how blurred, how dark, and how far past the footprint. */
export interface PoolPass {
  /** Gaussian blur radius as a FRACTION of the plate's edge — resolution-free,
   *  so the pool looks the same at any plate size. In world cm it is
   *  `blur * span`, which is what makes the falloff a physical distance. */
  blur: number;
  /** Black at this alpha, composited source-over onto what the pass before left. */
  alpha: number;
  /** Shrink applied to the footprint's w/d, in cm. NEGATIVE = reaches OUTWARD
   *  (the whole point); the one positive value is the contact line, which tucks
   *  just inside the base edge. */
  insetCm: number;
}

/** The plate's texture resolution (square). */
export const POOL_PX = 512;

/** The plate's height: below the y = 0 floor and below the dot grid (-0.5), so
 *  the grid's translucent dots draw OVER the pool instead of being erased. */
export const POOL_PLATE_Y = -0.75;

/** How much bigger than the layout the plate is drawn — the feather needs room
 *  past the furthest piece or the pool would be cut off by its own texture. */
export const POOL_SPAN_FACTOR = 2.7;

/**
 * THE THREE PASSES, outermost first — the shape the reference stills show.
 *
 *   1. an ambient feather, well past the piece;
 *   2. a mid pool hugging the silhouette;
 *   3. a tight, darker line at the very base edge — the contact itself.
 *
 * Composited in this order (each over the last), which is why the numbers are a
 * TABLE and not three literals buried in a draw call: the falloff is the product
 * of the three, and reading one without the others tells you nothing.
 */
export const POOL_PASSES: readonly PoolPass[] = Object.freeze([
  Object.freeze({ blur: 0.055, alpha: 0.38, insetCm: -36 }),
  Object.freeze({ blur: 0.022, alpha: 0.42, insetCm: -8 }),
  Object.freeze({ blur: 0.008, alpha: 0.5, insetCm: 3 }),
]) as readonly PoolPass[];

/** The plate's world size in cm for a stage radius and the layout it is holding.
 *  Never below the stage's own radius: a single small piece still gets a plate
 *  wide enough for the ambient feather to fade out on. */
export function poolSpan(radius: number, layoutRadius?: number | null): number {
  const r = Number(radius) || 0;
  const lr = Number(layoutRadius);
  return Math.max(r, Number.isFinite(lr) ? lr : 0) * POOL_SPAN_FACTOR;
}

/** Where the plate is and how big — the frame every projection below is in. */
export interface PoolView {
  /** Plate centre in world cm. */
  cx: number;
  cz: number;
  /** Plate edge in world cm. */
  span: number;
  /** Texture edge in px (default `POOL_PX`). */
  px?: number;
}

/** A footprint placed on the plate's canvas: centre px, size px, rotation rad. */
export interface PoolProjection {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Canvas-space rotation in radians (see the sign note below). */
  rot: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * World cm → plate px for ONE footprint, at one pass's inset.
 *
 * THE SIGN: the plate's rows run v = 0 first (a DataTexture has no flipY — see
 * `stage.ts` for why it is a DataTexture and not a CanvasTexture), so world +z
 * maps to canvas −y, and the yaw sign flips with it. Getting this wrong mirrors
 * every rotated piece's shadow, which reads as "the shadow is wrong" rather than
 * "a sign is".
 *
 * A degenerate footprint still draws at 2 px: a pool that vanishes is worse than
 * a pool that is small, and a piece with no measured size still sits on a floor.
 */
export function poolProject(rect: PoolRect, view: PoolView, insetCm = 0): PoolProjection {
  const px = Number(view.px) || POOL_PX;
  const s = px / (Number(view.span) || 1);
  return {
    cx: px / 2 + ((Number(rect.x) || 0) - (Number(view.cx) || 0)) * s,
    cy: px / 2 - ((Number(rect.z) || 0) - (Number(view.cz) || 0)) * s,
    w: Math.max(2, ((Number(rect.w) || 0) - insetCm) * s),
    h: Math.max(2, ((Number(rect.d) || 0) - insetCm) * s),
    rot: (-(Number(rect.deg) || 0) * Math.PI) / 180,
  };
}

/**
 * How much ONE blurred edge covers a point, in [0, 1].
 *
 * `inside` is the signed distance from the point to the blob's edge along one
 * axis (positive = inside the blob). A CSS `blur(Npx)` is a gaussian of σ = N, so
 * the true coverage is that gaussian's CDF; this is its smoothstep approximation
 * over ±2σ — same shape, same half-value at the edge, and no `erf` to argue
 * about. It is the MODEL of the canvas pass, and the reason the falloff can be
 * measured in a unit test instead of screenshotted.
 */
function edgeCoverage(inside: number, sigma: number): number {
  if (!(sigma > 0)) return inside >= 0 ? 1 : 0;
  const t = clamp01(0.5 + inside / (4 * sigma));
  return t * t * (3 - 2 * t);
}

/** A point's position in a rect's own frame (cm), undoing the plan yaw. */
function localOffset(rect: PoolRect, x: number, z: number): { u: number; v: number } {
  const a = ((Number(rect.deg) || 0) * Math.PI) / 180;
  const dx = x - (Number(rect.x) || 0);
  const dz = z - (Number(rect.z) || 0);
  // The plan's screen-clockwise yaw is a NEGATIVE rotation about the up axis
  // (plan y → world z), so the piece's own x axis points at (cos a, sin a) in
  // world XZ and this is that basis, inverted. Same sign the projection carries.
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { u: dx * cos + dz * sin, v: -dx * sin + dz * cos };
}

/**
 * HOW DARK the pool is at a world point, in [0, 1] — 0 is bare ground, 1 is
 * fully black. The three passes composited source-over, exactly as the canvas
 * composites them: each pass keeps `1 − α·coverage` of what the pass before it
 * left, so the darkness is `1 − Π(1 − α_i·c_i)`.
 *
 * This is the falloff a product still is judged by, available as a number: at
 * the base edge it is deep, and it feathers smoothly to nothing roughly a
 * feather's width out. Pure, so the SHAPE is pinned by a test rather than by a
 * screenshot nobody can diff.
 */
export function poolShade(
  rects: readonly PoolRect[] | null | undefined,
  point: { x: number; z: number },
  view: PoolView,
  passes: readonly PoolPass[] = POOL_PASSES,
): number {
  const span = Number(view.span) || 1;
  const x = Number(point?.x) || 0;
  const z = Number(point?.z) || 0;
  let keep = 1;
  for (const pass of passes) {
    // The blur is a fraction of the PLATE, so in world cm it scales with the
    // layout: the pool a lone ottoman casts and the one a six-module sectional
    // casts read the same at their own scale.
    const sigma = Math.max(1e-6, pass.blur * span);
    let cover = 0;
    for (const rect of rects || []) {
      const { u, v } = localOffset(rect, x, z);
      const halfW = Math.max(1, (Number(rect.w) || 0) - pass.insetCm) / 2;
      const halfD = Math.max(1, (Number(rect.d) || 0) - pass.insetCm) / 2;
      const c = edgeCoverage(halfW - Math.abs(u), sigma) * edgeCoverage(halfD - Math.abs(v), sigma);
      // Overlapping pieces do not stack into a black hole: the union of two
      // footprints is as dark as the darker of them, never their sum.
      if (c > cover) cover = c;
    }
    keep *= 1 - pass.alpha * cover;
  }
  return 1 - keep;
}

/** The pool's luminance over a ground of `groundLuminance` (any scale — 0–255
 *  reads as the reference strip's own units). */
export function poolLuminance(
  groundLuminance: number,
  rects: readonly PoolRect[] | null | undefined,
  point: { x: number; z: number },
  view: PoolView,
  passes: readonly PoolPass[] = POOL_PASSES,
): number {
  return (Number(groundLuminance) || 0) * (1 - poolShade(rects, point, view, passes));
}
