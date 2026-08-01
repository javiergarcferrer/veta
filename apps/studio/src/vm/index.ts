/**
 * The studio's ViewModels — every decision the authoring workflow makes, as
 * pure functions. Nothing here imports React, three.js, a worker or a store:
 * the shell renders what a `resolve*` returned and the workers run what a
 * `plan*` planned.
 */

export type { MeasuredNode, MeshRef, ModelStatus, PartsDraft, PlanRef, StudioModel, UpAxis } from './types.ts';
export { emptyModel } from './types.ts';

// Ingest — folder drop → review list → drafts.
export type {
  FolderProposal,
  IngestDeps,
  IngestEvent,
  IngestFailure,
  IngestPlan,
  IngestPlanRow,
  IngestRunResult,
  IngestState,
  IngestedPiece,
} from './ingest.ts';
export {
  ingestDrafts,
  initialIngestState,
  planIngest,
  reduceIngest,
  runIngest,
  texturesFor,
} from './ingest.ts';

// Parts — detect, classify, propose (existing choices always win).
export type { AccessoryRef, DetectInput, DetectResult, PartGroupBox } from './parts.ts';
export {
  accessoryRefFrom,
  classifyPartGroups,
  detectParts,
  partGroupsFrom,
  partGroupsInCm,
} from './parts.ts';

// SKU binding — base root + the billed slots derived from the role taxonomy.
export type { SkuBindingView, SkuSlotPlan, SkuSlotView } from './sku.ts';
export {
  billedSlots,
  bindBaseProduct,
  planSkuSlot,
  resolveSkuBinding,
  setPartCount,
  writeSlot,
} from './sku.ts';

// Finishes — palette drafts, collection sharing, and the blast radius.
export type {
  FanoutRow,
  FinishCommitPlan,
  FinishModel,
  FinishSpecDraft,
  StructureFinishState,
  StructureFinishStatus,
} from './finishes.ts';
export {
  applyStarterStructure,
  applyStructureToDraft,
  collectionFinishesOf,
  isStructureKey,
  paletteDraftOf,
  planFinishCommit,
  planFinishFanout,
  planFinishSync,
  planStructureFanout,
  prunedParts,
  resolveStructureFinish,
  structureFinishesOf,
  structureKeysOf,
  writeFinish,
} from './finishes.ts';

// The batch queue and the optimize run that rides it.
export type { QueueEvent, QueueItem, QueueProgress, QueueState, QueueTask, TaskState } from './queue.ts';
export {
  DEFAULT_CONCURRENCY,
  createQueueState,
  failedTasks,
  messageOf,
  pendingTasks,
  queueProgress,
  queueReduce,
  retryFailed,
  runQueue,
} from './queue.ts';
export type { OptimizeReport, OptimizeRunSummary } from './optimize.ts';
export {
  MESH_VERSION,
  isMeshCurrent,
  isOptimizableMeshUrl,
  optimizableModels,
  planOptimizeRun,
  summarizeOptimizeRun,
} from './optimize.ts';

// Publish — the gate, and what is left to do.
export type { PublishCheck, PublishLevel, PublishSummary, PublishTransition } from './publish.ts';
export {
  blockingChecks,
  canPublish,
  resolvePublishChecks,
  resolvePublishSummary,
  setPublishState,
} from './publish.ts';

// Fidelity — observations off the widget's own render.
export type { BuildReport, FidelityCheck, FidelityInput, FidelityLevel } from './fidelity.ts';
export { fidelityVerdict, resolveFidelityChecks } from './fidelity.ts';
