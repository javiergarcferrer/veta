/**
 * Mesh → plan, the PURE half. Takes a loaded model's world-space triangles (the
 * caller walks the three.js tree and hands over plain numbers), pulls its FLOOR
 * triangles — the lower body that actually sits on the ground, so a leaning
 * backrest roll doesn't inflate the footprint — scales them to centimetres, and
 * runs `meshPlanFromTriangles` for the top-down plan SVG + footprint.
 *
 * This REPLACES the DWG plan for any piece that has a mesh: the plan a tile
 * renders is literally its mesh seen from above. Caching, loading and disposal are
 * the caller's (they touch the network and three.js runtime objects); everything
 * here is data in, data out.
 */
import { meshPlanFromTriangles } from './meshToPlan.ts';
import type { MeshLoopsOptions } from './meshToPlan.ts';
import { autoUnitScale } from './unitScale.ts';
import type { UpAxis } from './sceneSplit.ts';

/**
 * The lower fraction of the model's height that counts as "on the floor". 0.4 is
 * measured: it keeps the seat/base mass and drops a reclined backrest, whose
 * overhang would otherwise widen the footprint past the piece's real platform.
 */
export const FLOOR_CUT_FRAC = 0.4;

/** World-space triangle vertices, 9 numbers per triangle: [ax,ay,az, bx,by,bz, cx,cy,cz]. */
export type TriangleVertices = ArrayLike<number>;

export interface VertexBounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

/** Axis-aligned bounds of a flat [x,y,z,…] vertex array; null when empty. */
export function vertexBounds(vertices: TriangleVertices | null | undefined): VertexBounds | null {
  const n = vertices ? vertices.length : 0;
  if (!vertices || n < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < n; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = vertices[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export interface FloorTrianglesOptions {
  /** Which axis is vertical ('y' default, 'z' for some CAD exports). */
  upAxis?: UpAxis;
  /** Lower fraction of the height kept; default `FLOOR_CUT_FRAC`. */
  cutFrac?: number;
  /** Precomputed bounds of the SAME vertex array (skips a pass). */
  bounds?: VertexBounds | null;
}

/**
 * Lower-body triangles projected to the ground plane, in cm — flat [ax,az, bx,bz,
 * cx,cz, …], the shape `meshPlanFromTriangles` eats, with the origin moved to the
 * footprint's min corner.
 *
 * The auto-unit guard is the SAME factor the 3D placement applies (both from the
 * piece's LARGEST extent, not its height, so a short bolster/arm cushion isn't
 * blown up a power of ten), so the plan footprint matches the rendered piece. It
 * only corrects a gross mm/cm/m export; a cm export keeps true size.
 */
export function floorTriangles(
  vertices: TriangleVertices | null | undefined,
  opts: FloorTrianglesOptions = {},
): number[] {
  const n = vertices ? vertices.length : 0;
  if (!vertices || n < 9) return [];
  const bounds = opts.bounds ?? vertexBounds(vertices);
  if (!bounds) return [];

  const upAxis: UpAxis = opts.upAxis === 'z' ? 'z' : 'y';
  const cutFrac = Number.isFinite(Number(opts.cutFrac)) ? Number(opts.cutFrac) : FLOOR_CUT_FRAC;
  const up = upAxis === 'z' ? 2 : 1;          // vertical component
  const fa = 0;                               // floor axis A (x)
  const fb = upAxis === 'z' ? 1 : 2;          // floor axis B (y if z-up, else z)
  const sUp = bounds.size[up];
  if (!(sUp > 0)) return [];
  const k = autoUnitScale(Math.max(bounds.size[0], bounds.size[1], bounds.size[2]));
  const cut = bounds.min[up] + sUp * cutFrac;
  const oa = bounds.min[fa], ob = bounds.min[fb];

  const tris: number[] = [];
  for (let i = 0; i + 8 < n; i += 9) {
    const upA = vertices[i + up], upB = vertices[i + 3 + up], upC = vertices[i + 6 + up];
    if ((upA + upB + upC) / 3 > cut) continue;
    tris.push(
      (vertices[i + fa] - oa) * k, (vertices[i + fb] - ob) * k,
      (vertices[i + 3 + fa] - oa) * k, (vertices[i + 3 + fb] - ob) * k,
      (vertices[i + 6 + fa] - oa) * k, (vertices[i + 6 + fb] - ob) * k,
    );
  }
  return tris;
}

export interface MeshPlanFromVerticesOptions extends FloorTrianglesOptions, MeshLoopsOptions {}

export interface MeshPlanSummary {
  svg: string;
  widthCm: number;
  depthCm: number;
}

/**
 * Plan (top-down SVG + cm footprint) for a model's world-space triangles.
 *
 * A degenerate lower slice (a flat-on-the-floor export) falls back to the WHOLE
 * silhouette so we still get a real footprint. Returns null when there is no plan
 * geometry at all — the caller falls back to the stored plan.
 */
export function meshPlanFromVertices(
  vertices: TriangleVertices | null | undefined,
  opts: MeshPlanFromVerticesOptions = {},
): MeshPlanSummary | null {
  const bounds = opts.bounds ?? vertexBounds(vertices);
  if (!bounds) return null;
  const cutFrac = Number.isFinite(Number(opts.cutFrac)) ? Number(opts.cutFrac) : FLOOR_CUT_FRAC;

  let plan = meshPlanFromTriangles(floorTriangles(vertices, { ...opts, bounds, cutFrac }), opts);
  if (!plan.svg && cutFrac < 1) {
    plan = meshPlanFromTriangles(floorTriangles(vertices, { ...opts, bounds, cutFrac: 1 }), opts);
  }
  if (!plan.svg) return null;
  return { svg: plan.svg, widthCm: plan.widthCm, depthCm: plan.depthCm };
}
