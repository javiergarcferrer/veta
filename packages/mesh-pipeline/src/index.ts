/**
 * @veta/mesh-pipeline — CAD scene ingest and the GLB optimization pipeline.
 *
 * Everything here is engine: three.js is INJECTED (never imported at runtime),
 * loaders/exporters are dependencies the caller passes in, and file inputs are
 * `FileLike`, so the whole pipeline runs under node in tests.
 *
 * The re-export path (`exportPieceGlb`) carries the MATERIAL-BY-REFERENCE
 * invariant: a piece's clones reuse the SOURCE material objects, because
 * GLTFExporter copies `material.name` into the GLB and the part tagger keys
 * per-part pricing off that name. Substitute a material anywhere on that path
 * and the re-imported GLB is one anonymous blob — "detect parts" can no longer
 * tell a cushion from a bolster. See the doc comment on `exportPieceGlb` before
 * touching it.
 */

// The three seam (types + the shared depth-first mesh walk).
export type {
  BufferGeometryLike,
  BufferGeometryUtilsLike,
  GltfExporterLike,
  MaterialLike,
  MeshLike,
  Object3DLike,
  TextureLike,
  ThreeLike,
} from './three.ts';
export { collectMeshes, isMeshNode } from './three.ts';

// GLB version stamping.
export {
  LEGACY_MESH_VERSION_KEY,
  MESH_VERSION,
  MESH_VERSION_KEY,
  meshVersionOf,
  readGlbMeshVersion,
  stampGlbAsset,
  stampMeshVersion,
} from './glbStamp.ts';

// Crease → weld → quantize, and the GLB re-export.
export type { BakedGeometry, ExportPieceDeps, OptimizeGlbDeps, OptimizeGlbResult } from './optimize.ts';
export {
  CREASE_ANGLE,
  MAX_ORIGIN_RATIO,
  MAX_SOLIDS_PER_MESH,
  bakeGeometry,
  exportPieceGlb,
  isOptimizableMeshUrl,
  optimizeGlbBuffer,
  pinnedMaterial,
  quantizeGeometry,
  splitGeometryBySolid,
} from './optimize.ts';

// The segmentation engine itself lives in @veta/geometry (pure triangle work);
// re-exported here because this is the pipeline that consumes it, and a caller
// wiring the export path should not have to learn which package owns the math.
export { TRIM_AREA_RATIO, WELD_RATIO, splitSolids } from '@veta/geometry';
export type { Solid, SplitSolidsInput, SplitSolidsResult } from '@veta/geometry';

// Scene splitting.
export type { SceneSplit, ScenePiece, SplitSceneOpts, UpAxis } from './splitScene.ts';
export { CLUSTER_GAP_CM, MIN_PIECE_CM, splitScene } from './splitScene.ts';

// Sidecar textures.
export type {
  BakeBundledMapsOpts,
  FileLike,
  ImageResizer,
  ObjectUrlHost,
  TextureBundle,
} from './sidecarTextures.ts';
export {
  ACCEPT_TEXTURES,
  MAX_TEXTURE_PX,
  TEXTURE_EXT_RE,
  TEXTURE_TIMEOUT_MS,
  bakeBundledMaps,
  baseNameOf,
  bundleTextures,
  dirOf,
  imageSettled,
  relPathOf,
  texturesByFolder,
  texturesOf,
} from './sidecarTextures.ts';

// Batch folder ingest.
export type {
  BatchIngestDeps,
  BatchIngestResult,
  IngestFailure,
  IngestFailureCode,
  IngestPiece,
  LoadedScene,
} from './batchIngest.ts';
export {
  MODEL_EXT_RE,
  libraryProposalFor,
  loadPiecesFromFiles,
  nameFromFile,
  summarizeFolderProposals,
} from './batchIngest.ts';

// Library layouts (adapters).
export type { LibraryLayout, LibraryPathFields } from './library/types.ts';
export { NO_LIBRARY_FIELDS, noLibraryFields } from './library/types.ts';
export type { LibraryShape } from './library/lrArchviz.ts';
export {
  LIBRARY_ROOTS,
  LR_GROUPS,
  LR_VARIANT_MARKERS,
  lrArchvizLayout,
  parseLibraryPath,
  prettifyLibraryName,
  resolveLibraryShape,
} from './library/lrArchviz.ts';
