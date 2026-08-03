/**
 * @veta/scene — the three.js scene engine.
 *
 * THREE is dependency-injected everywhere (CONTRACTS.md): nothing in `src`
 * imports the runtime module, so the engine stays code-split and unit-testable.
 * Scene owns the three.js side ONLY — appearance decisions belong to
 * `@veta/materials`, mesh maths to `@veta/geometry`, placement to `@veta/layout`.
 */

// ── Render params: the per-collection data that used to be hardcoded ─────────
export type { BoundsLike, FinishProfile, RenderParams, SeamBleedParams } from './renderParams.ts';
export {
  DEFAULT_FINISH_PROFILE,
  DEFAULT_FRAME_HEIGHT_CM,
  DEFAULT_SEAM_BLEED_TABLE,
  DEFAULT_STRUCTURED_SEAM_BLEED,
  LEGACY_SEAM_BLEED_COLLECTION,
  finishProfileOf,
  frameHeight,
  meshSeamBleed,
} from './renderParams.ts';

// ── The scene builder ────────────────────────────────────────────────────────
export type { BuildSceneOptions, FabricMapsOptions, FabricMaterialOptions, PlacementOptions, RoomGroupOptions, ScanPbr } from './sceneBuilder.ts';
export {
  DEFAULT_COLOR,
  DEFAULT_ROOM_WOOD_URL,
  FABRIC_ANISOTROPY,
  FABRIC_UV_CM,
  DEFAULT_PARTS_TAXONOMY,
  buildRoomGroup,
  buildSceneGroup,
  disposeGroup,
  disposeRoomGroup,
  fabricAnisotropy,
  generateBoxUvs,
  makeFabricMaps,
  makeFabricMaterial,
  placeRealModel,
} from './sceneBuilder.ts';

// ── The studio rig ───────────────────────────────────────────────────────────
export type { ShadowMode, StageHandle, StageOptions } from './stage.ts';
export { DEFAULT_STAGE_GROUND, setupStage } from './stage.ts';

// ── The contact pool (the quality tier's grounding) ──────────────────────────
export type { PoolPass, PoolProjection, PoolRect, PoolView } from './contactPool.ts';
export {
  POOL_PASSES,
  POOL_PLATE_Y,
  POOL_PX,
  POOL_SPAN_FACTOR,
  poolLuminance,
  poolProject,
  poolShade,
  poolSpan,
} from './contactPool.ts';

// ── Picking + highlight scope (pure, over the hit list / the meshes) ─────────
export type { PickCandidate, PickHit, PickIntersection } from './picking.ts';
export {
  RING_R_MOUSE,
  RING_R_TOUCH,
  RING_SPOKES,
  preferPick,
  resolvePickHit,
  ringRadiusFor,
  ringSamples,
} from './picking.ts';
export type { FocusScope, HighlightDecision, HighlightState, HoverPart, TaggedMesh } from './highlight.ts';
export { DRESSABLE_ROLE, dressableExclusions, focusMeshes, resolveHighlightScope } from './highlight.ts';

// ── GLB / AR export ──────────────────────────────────────────────────────────
export type { ArGroup, ArGroupOptions, GlbExportDeps } from './glbExport.ts';
export { CM_TO_M, buildArGroup, exportGlbBlob, loadFabricTextures } from './glbExport.ts';

// ── Model loading ────────────────────────────────────────────────────────────
export type { LoadModelsDeps, ModelLoaderLike } from './modelLoader.ts';
export {
  ALCOVER_MESH_V,
  CREASE_ANGLE,
  LEGACY_MESH_VERSION_KEY,
  LOADER_MODULES,
  extOf,
  isLoadableFormat,
  loadModels,
  meshVersionOf,
  normalizeLoaded,
  sharedModelCache,
} from './modelLoader.ts';

// ── Silhouette utilities ─────────────────────────────────────────────────────
export type { MaskToOutlineOptions, SmoothLoopOptions } from './silhouette.ts';
export {
  loopArea,
  maskToOutline,
  offsetLoopOutward,
  resampleUniform,
  smoothLoopConstrained,
  traceGridLoops,
} from './silhouette.ts';

// ── Fallbacks (opt-in via RenderParams.fallback) ─────────────────────────────
export type { KindEntry, TogoForm, TogoPart } from './fallbacks/togo.ts';
export {
  BACK_TOP,
  TOGO_HEIGHT_CM,
  TOGO_KINDS,
  inferForm,
  inferKind,
  proceduralTogoParts,
} from './fallbacks/togo.ts';

// ── Shared types ─────────────────────────────────────────────────────────────
export type {
  FinishOption,
  FinishSpec,
  LoadedModel,
  ModelDescriptor,
  PartNode,
  PartsData,
  PartsTaxonomy,
  PlacementFootprint,
  Point2,
  RoomSpec,
  SceneSpec,
  ScenePiece,
  ThreeApi,
  ThreeMaterial,
  ThreeObject,
  ThreeTexture,
} from './types.ts';
