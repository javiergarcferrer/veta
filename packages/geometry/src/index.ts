/**
 * @veta/geometry — the pure 2D/3D geometry engine.
 *
 * Mesh silhouettes, plan derivation, scene clustering, mesh cleaning, unit
 * scaling and the DXF/SVG plan emitters. Zero runtime dependencies: no React, no
 * three.js (the THREE namespace is injected where a caller needs it), no DOM.
 */

// ── Mesh → top-down silhouette + plan SVG ────────────────────────────────
export {
  meshLoopsFromTriangles,
  meshPlanFromTriangles,
  traceGridLoops,
  simplifyClosed,
} from './meshToPlan.ts';
export type {
  PlanPoint,
  PlanLoop,
  MeshLoopsResult,
  MeshPlanResult,
  MeshLoopsOptions,
} from './meshToPlan.ts';

// ── Mesh triangles → plan (the floor slice) ──────────────────────────────
export {
  floorTriangles,
  meshPlanFromVertices,
  vertexBounds,
  FLOOR_CUT_FRAC,
} from './meshPlan.ts';
export type {
  TriangleVertices,
  VertexBounds,
  FloorTrianglesOptions,
  MeshPlanFromVerticesOptions,
  MeshPlanSummary,
} from './meshPlan.ts';

// ── Scene split (multi-piece export → individual pieces) ─────────────────
export {
  detectUpAxis,
  clusterFootprints,
  pieceName,
  clusterName,
  MACHINE_NAME,
} from './sceneSplit.ts';
export type {
  SceneSize,
  UpAxis,
  FootprintBox,
  ClusterNameOptions,
} from './sceneSplit.ts';

// ── Mesh cleaning (labels + ground shadows) ──────────────────────────────
export {
  cleanMeshNodes,
  stripLabelMeshes,
  stripShadowMeshes,
  isLabelMeshName,
  isGroundShadowBox,
  LABEL_MESH_NAME,
} from './meshClean.ts';
export type {
  ThreeLike,
  Box3Like,
  MeshNodeLike,
  StripLabelOptions,
  StripShadowOptions,
  CleanMeshNodesOptions,
  CleanMeshNodesResult,
} from './meshClean.ts';

// ── Unit scaling ─────────────────────────────────────────────────────────
export {
  autoUnitScale,
  uniformHeightFit,
  FURNITURE_SPAN_CM,
  DEFAULT_FIT_HEIGHT_CM,
} from './unitScale.ts';
export type { MeshSize, UniformFit } from './unitScale.ts';

// ── Plan → DXF ───────────────────────────────────────────────────────────
export {
  planToDxf,
  placePiece,
  parsePlanSvg,
  parsePathData,
  dxfLayers,
  DXF_LAYERS,
  DEFAULT_DXF_LAYER_PREFIX,
} from './planToDxf.ts';
export type {
  PlanSubpath,
  PlanSvgCircle,
  ParsedPlanSvg,
  PlacedCircle,
  PlacedPiece,
  DxfPlacement,
  DxfLayer,
  DxfLayerTable,
  PlanToDxfOptions,
} from './planToDxf.ts';

// ── Plan preview (screen-space composition) ──────────────────────────────
export {
  composePlanPreview,
  planPlacements,
  placedPieceGeom,
  viewBoxOf,
} from './planPreview.ts';
export type {
  PlanPreviewModel,
  PlanPreviewItem,
  PlanPreviewModels,
  PlanPreviewOptions,
  PlanPreview,
  PlacedPieceGeom,
} from './planPreview.ts';
