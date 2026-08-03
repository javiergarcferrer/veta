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
// The pipeline that runs itself — the automatic re-export and the tagging that
// waits for it, plus the row-level mesh stamp that makes both free.
export type { AutoDetectPlan, AutoOptimizePlan } from './pipeline.ts';
export {
  meshVersionOfRow,
  owesReExport,
  planAutoDetect,
  planAutoOptimize,
  resolvePipelineStatus,
  stampFreshUpload,
  stampOptimized,
} from './pipeline.ts';

// Saving — automatic, serialized per model, and no longer a wait.
export type { SaveHandles, SaveQueue, SaveQueueDeps } from './save.ts';
export {
  AUTOSAVE_MS,
  FANOUT_CONCURRENCY,
  armAutosave,
  createSaveQueue,
  resolveSaveStatus,
  runPool,
} from './save.ts';

// One gesture (join / separate), and the keys that arm it.
export type { KeyEventLike, PickGesture, StageHit, StudioKeyAction } from './gesture.ts';
export {
  applyPickGesture,
  resolvePickGesture,
  resolveStudioKey,
  separateMembers,
} from './gesture.ts';

// Collection identity — one spelling, one collection.
export {
  DEFAULT_COLLECTION,
  canonicalCollection,
  collectionKey,
  distinctCollections,
  matchesCollection,
  normalizeName,
} from './collections.ts';

// Auto-link — the deterministic candidate reducer, one piece and one family.
export type {
  Assignment,
  Candidate,
  CatalogProduct,
  CollectionAnswer,
  CollectionChunk,
  CollectionEntry,
  CollectionPlan,
  LrDimensions,
  MatchConfidence,
  MatchableModel,
  MatchedProduct,
  MergedSuggestions,
  ModelOffer,
  PoolRow,
  ReviewOption,
  ReviewRow,
  ShapeFacts,
} from './autoLink.ts';
export {
  COLLECTION_MAX_MODELS,
  COLLECTION_MAX_POOL,
  COLLECTION_PER_MODEL,
  collectionCandidates,
  indexCandidates,
  mergeCollectionSuggestions,
  nameTokens,
  parseLrDimensions,
  planCollectionBind,
  planCollectionChunks,
  resolveAssignmentDuplicates,
  resolveCollectionReview,
  resolveModelMatches,
  shapeFacts,
} from './autoLink.ts';

// …and learning from what the dealer already bound by hand.
export type { BindingExample, BoundModel } from './bindingExamples.ts';
export {
  EXAMPLE_LIMIT,
  exampleAgreement,
  formatBindingExamples,
  indexProductsByRoot,
  resolveBindingExamples,
} from './bindingExamples.ts';

// The inference seam — pure prompt in, validated answer out. Never a live call.
export type {
  AnswerResult,
  MatchPartInput,
  MatchModelInput,
  MatchRequest,
  ParseResult,
  SuggestCandidate,
  SuggestFn,
  Suggestion,
} from './suggest.ts';
export {
  CONFIDENCES,
  MAX_CANDIDATES,
  MAX_WHY_CHARS,
  SYSTEM_PROMPT,
  buildMatchPrompt,
  candidateFrom,
  extractJson,
  fallbackSuggestion,
  parseCandidates,
  parseMatchRequest,
  resolveCollectionAnswer,
  resolveMatchAnswer,
  runMatchSuggestion,
} from './suggest.ts';

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
