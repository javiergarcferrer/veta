/**
 * PLAN → SCENE SPEC. The 2D plan is the truth; the 3D view is a projection of
 * it, and this is the projection.
 *
 * Three conversions live here and nowhere else:
 *   • AXES — the plan is cm, top-left origin, y-DOWN; the scene is cm, world
 *     origin at the middle, plan-y → world-Z. Getting this wrong mirrors the
 *     whole sofa, which reads as "the 3D is wrong" rather than "a sign is".
 *   • CENTRING — the plan is an unbounded sandbox, so a build dragged far from
 *     the origin would otherwise sit off-camera. The spec is centred on the
 *     build's own bounds, and the offset is reported so the caller can keep the
 *     stage rig (whose shadow frustum follows the layout) in step.
 *   • FRAMING — the camera radius comes from the measured bounds, never a
 *     constant, so one ottoman and a six-module sectional both fill the frame.
 *
 * Pure: no three.js (the scene package injects THREE), no DOM.
 */

import type { ResolvedModel } from './catalog.ts';
import type { PlacedPiece } from './editor.ts';

export interface ScenePieceSpec {
  uid: string;
  x: number;
  z: number;
  rotationDeg: number;
  widthCm: number;
  depthCm: number;
  mountHeightCm: number | null;
  collection: string | null;
  fabricCode: string | null;
  label: string;
  parts: Record<string, unknown> | null;
  partMaterials: Record<string, { code?: string | null }> | null;
  partFinishes: Record<string, string> | null;
  /** The model's mesh, for the caller's loader (null = procedural fallback). */
  meshUrl: string | null;
  meshParams: Record<string, unknown> | null;
  pieceId: string;
}

export interface SceneView {
  pieces: ScenePieceSpec[];
  /** Plan-cm offset applied to centre the build (add it back to go plan→scene). */
  offset: { x: number; z: number };
  /** Half-diagonal of the build in cm — the stage radius and camera distance. */
  radius: number;
  bounds: { widthCm: number; depthCm: number };
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** The stage radius for an EMPTY plan: enough to light a first piece the moment
 *  it lands, so the rig never has to be rebuilt for the first add. */
export const EMPTY_SCENE_RADIUS = 120;

/**
 * Project the placed pieces into the spec `@veta/scene`'s `buildSceneGroup`
 * consumes. A piece whose model is missing from the catalog is DROPPED (never
 * rendered as a mystery box): the plan can outlive a model being unpublished.
 */
export function resolveSceneView(
  placed: readonly PlacedPiece[] | null | undefined,
  modelById: Record<string, ResolvedModel | undefined>,
): SceneView {
  const rows: Array<{ piece: PlacedPiece; model: ResolvedModel; w: number; d: number }> = [];
  for (const piece of placed ?? []) {
    const model = modelById[piece.pieceId];
    if (!model) continue;
    rows.push({ piece, model, w: num(model.widthCm), d: num(model.depthCm) });
  }
  if (!rows.length) {
    return { pieces: [], offset: { x: 0, z: 0 }, radius: EMPTY_SCENE_RADIUS, bounds: { widthCm: 0, depthCm: 0 } };
  }

  // Bounds over the piece CENTRES plus their extents, using the un-rotated
  // footprint: the mesh itself carries the rotation, so the spec must not
  // pre-rotate the box or a turned piece would be placed off its own centre.
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  for (const { piece, w, d } of rows) {
    const cx = num(piece.x) + w / 2;
    const cz = num(piece.y) + d / 2;
    const half = Math.max(w, d) / 2;
    minX = Math.min(minX, cx - half);
    maxX = Math.max(maxX, cx + half);
    minZ = Math.min(minZ, cz - half);
    maxZ = Math.max(maxZ, cz + half);
  }
  const offset = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  const widthCm = maxX - minX;
  const depthCm = maxZ - minZ;

  const pieces: ScenePieceSpec[] = rows.map(({ piece, model, w, d }) => ({
    uid: piece.uid,
    pieceId: piece.pieceId,
    x: num(piece.x) + w / 2 - offset.x,
    z: num(piece.y) + d / 2 - offset.z,
    rotationDeg: num(piece.rot),
    widthCm: w,
    depthCm: d,
    mountHeightCm: model.mountHeightCm ?? null,
    collection: model.collection ?? null,
    fabricCode: (piece.material as { code?: string } | null)?.code ?? null,
    label: String(model.name ?? ''),
    parts: (model.parts as Record<string, unknown> | null) ?? null,
    partMaterials: (piece.partMaterials as Record<string, { code?: string | null }> | null) ?? null,
    partFinishes: (piece.partFinishes as Record<string, string> | null) ?? null,
    meshUrl: model.meshUrl ?? null,
    meshParams: model.meshParams ?? null,
  }));

  return {
    pieces,
    offset,
    radius: Math.max(EMPTY_SCENE_RADIUS, Math.hypot(widthCm, depthCm) / 2 + 60),
    bounds: { widthCm: Math.round(widthCm), depthCm: Math.round(depthCm) },
  };
}

/** Every distinct fabric code on the plan — what the appearance layer loads. */
export function sceneFabricCodes(view: SceneView): string[] {
  const codes = new Set<string>();
  for (const piece of view.pieces) {
    if (piece.fabricCode) codes.add(piece.fabricCode);
    for (const pick of Object.values(piece.partMaterials ?? {})) {
      if (pick?.code) codes.add(String(pick.code));
    }
  }
  return [...codes];
}
