/**
 * SCENE SPLITTING — one exported plan back into individual pieces.
 *
 * pCon.planner (and every other CAD tool) exports a WHOLE plan into one file:
 * there is no per-article export, so the dealer lays every piece out with some
 * air between them, exports once (GLB/FBX/OBJ/DAE/3DS), and drops that single
 * file in. We recover the pieces by clustering mesh footprints on the floor
 * plane — boxes that touch (within a gap tolerance) are one piece of furniture,
 * disjoint groups are different pieces.
 *
 * The clustering math itself is pure and lives in `@veta/geometry`; this module
 * is the three-side orchestration that measures the boxes and names the results.
 */
import { autoUnitScale, clusterFootprints, clusterName, detectUpAxis } from '@veta/geometry';
import type { MeshLike, Object3DLike, ThreeLike } from './three.ts';
import { collectMeshes } from './three.ts';

/**
 * Pieces whose footprint tops out under this are exporter debris (labels, origin
 * markers), not furniture — dropped from the review list.
 */
export const MIN_PIECE_CM = 15;

/**
 * Two meshes further apart than this on the floor are different pieces; the
 * dealer just needs to leave MORE than this between pieces in the CAD tool.
 */
export const CLUSTER_GAP_CM = 15;

export type UpAxis = 'y' | 'z';

export interface ScenePiece {
  name: string;
  /** Footprint ESTIMATE for a review list — the stored footprint is re-derived
   *  from the uploaded GLB by the same plan pipeline as a single upload. */
  widthCm: number;
  depthCm: number;
  /** The SOURCE scene's mesh nodes, world matrices up to date. */
  meshes: MeshLike[];
}

export interface SceneSplit {
  upAxis: UpAxis;
  unitScale: number;
  pieces: ScenePiece[];
}

export interface SplitSceneOpts {
  minPieceCm?: number;
  clusterGapCm?: number;
}

/**
 * Split a loaded scene into pieces.
 *
 * The unit factor comes from the scene HEIGHT (≈ the tallest piece) through the
 * same power-of-ten auto-unit guard the single-upload pipeline applies, so the
 * clustering gap and the size filter mean real centimetres whatever the export
 * units were.
 */
export function splitScene(
  THREE: Pick<ThreeLike, 'Box3' | 'Vector3'>,
  object: Object3DLike,
  { minPieceCm = MIN_PIECE_CM, clusterGapCm = CLUSTER_GAP_CM }: SplitSceneOpts = {},
): SceneSplit {
  object.updateMatrixWorld(true);
  const meshes = collectMeshes(object);
  if (!meshes.length) return { upAxis: 'y', unitScale: 1, pieces: [] };

  const whole = new THREE.Box3().setFromObject(object);
  const size = whole.getSize(new THREE.Vector3());
  const upAxis = detectUpAxis(size) as UpAxis;
  // The two FLOOR axes: everything that isn't up. (x is never the up axis in
  // practice — furniture exports are y-up or z-up.)
  const fa: 'x' = 'x';
  const fb: 'y' | 'z' = upAxis === 'z' ? 'y' : 'z';
  const unitScale = autoUnitScale(upAxis === 'z' ? size.z : size.y) as number;

  const boxes = meshes.map((m, i) => {
    const b = new THREE.Box3().setFromObject(m);
    return { id: i, min: [b.min[fa], b.min[fb]], max: [b.max[fa], b.max[fb]] };
  });
  const clusters = clusterFootprints(boxes, clusterGapCm / unitScale) as number[][];

  // A mesh's candidate name: its child-of-root ancestor's name (a CAD export
  // groups a piece's meshes under one node), falling back to the mesh's own.
  const topName = (m: Object3DLike): string => {
    let o: Object3DLike = m;
    let last = m.name || '';
    while (o.parent && o.parent !== object) { o = o.parent; if (o.name) last = o.name; }
    return last;
  };

  const pieces = clusters.map((ids, ci): ScenePiece => {
    let minA = Infinity, minB = Infinity, maxA = -Infinity, maxB = -Infinity;
    for (const id of ids) {
      const b = boxes[id];
      minA = Math.min(minA, b.min[0]); minB = Math.min(minB, b.min[1]);
      maxA = Math.max(maxA, b.max[0]); maxB = Math.max(maxB, b.max[1]);
    }
    return {
      name: clusterName(ids.map((id) => topName(meshes[id])), ci) as string,
      widthCm: Math.round((maxA - minA) * unitScale),
      depthCm: Math.round((maxB - minB) * unitScale),
      meshes: ids.map((id) => meshes[id]),
    };
  }).filter((p) => Math.max(p.widthCm, p.depthCm) >= minPieceCm);

  return { upAxis, unitScale, pieces };
}
