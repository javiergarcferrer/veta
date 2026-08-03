/**
 * THE MESH OPTIMIZE RUN — which models a batch is even about, and what it did.
 *
 * The work itself is `@veta/mesh-pipeline`'s `optimizeGlbBuffer` (crease → weld
 * → quantize → stamp) and it happens in a Web Worker; this module owns the two
 * pure halves around it.
 *
 * ONE RULE FOR WHAT IS OPTIMIZABLE (`isOptimizableMeshUrl`): a row still serving
 * a raw .fbx/.obj — a multi-piece drop uploads the file verbatim — carries no
 * stamp to read and no round trip we can promise is lossless, so it stays as it
 * is until someone re-imports it. The button's COUNT and the RUN read the same
 * predicate, so they can never disagree about which models the batch is about.
 *
 * IDEMPOTENT BY THE FILE'S OWN STAMP: a GLB already at the current mesh version
 * comes back `skipped` for the price of its download and nothing is written — so
 * an interrupted run resumes for free and a re-run is not a rewrite.
 *
 * …and IDEMPOTENT BY THE ROW'S STAMP BEFORE THAT (`owesReExport`, vm/pipeline):
 * once the run has recorded the version a model was exported through, an
 * up-to-date catalogue costs no downloads AT ALL. Which is what made the run
 * safe to fire by itself on open.
 */
import { MESH_VERSION, isOptimizableMeshUrl } from '@veta/mesh-pipeline';
import { owesReExport } from './pipeline.ts';
import type { QueueItem, QueueState, QueueTask } from './queue.ts';
import { createQueueState } from './queue.ts';
import type { StudioModel } from './types.ts';

/** What one optimized model reports back — the worker's payload, minus bytes. */
export interface OptimizeReport {
  /** The file already carried this pipeline's stamp; nothing was written. */
  skipped: boolean;
  before: number;
  after: number;
  /** The stamp the file now carries. */
  meshVersion: number;
}

/** The models a run would touch, in the order they will be touched — the same
 *  predicate the automatic pass fires on, so a read-out can never advertise work
 *  the run would skip. */
export function optimizableModels(models: readonly StudioModel[] | null | undefined): StudioModel[] {
  return (models || []).filter((m) => owesReExport(m));
}

/** The run's task list — one per optimizable model, payload = its mesh URL. */
export function planOptimizeRun(
  models: readonly StudioModel[] | null | undefined,
  { concurrency }: { concurrency?: number } = {},
): QueueState<OptimizeReport> {
  const tasks: QueueTask[] = optimizableModels(models).map((m) => ({
    id: m.id,
    label: m.name || m.id,
    payload: { url: m.mesh!.url, name: m.name || m.id },
  }));
  return createQueueState<OptimizeReport>(tasks, { concurrency });
}

export interface OptimizeRunSummary {
  total: number;
  optimized: number;
  skipped: number;
  failed: number;
  before: number;
  after: number;
  /** Bytes saved across the models that were actually re-exported. 0, never
   *  negative: a re-export that grew a file is not a saving. */
  saved: number;
  /** 0..1 of the re-exported bytes; 0 when nothing was re-exported. */
  savedRatio: number;
  /** The casualties, by label — the review list a batch owes the dealer. */
  casualties: string[];
}

/** What a finished (or half-finished) run did. Reads only the queue's own
 *  items, so a paused run summarizes exactly like a complete one. */
export function summarizeOptimizeRun(state: QueueState<OptimizeReport>): OptimizeRunSummary {
  let optimized = 0;
  let skipped = 0;
  let before = 0;
  let after = 0;
  const casualties: string[] = [];
  for (const item of state.items as QueueItem<OptimizeReport>[]) {
    if (item.state === 'failed') { casualties.push(item.label); continue; }
    const r = item.result;
    if (!r) continue;
    before += Number(r.before) || 0;
    after += Number(r.after) || 0;
    if (r.skipped) skipped++; else optimized++;
  }
  const saved = Math.max(0, before - after);
  return {
    total: state.items.length,
    optimized,
    skipped,
    failed: casualties.length,
    before,
    after,
    saved,
    savedRatio: before > 0 ? saved / before : 0,
    casualties,
  };
}

/** Whether a stored mesh is already at the pipeline's current version — the
 *  per-model truth behind the fidelity panel's «Optimized» row, so the batch
 *  never has to guess. */
export function isMeshCurrent(meshVersion: number | null | undefined, required: number = MESH_VERSION): boolean {
  return Number.isFinite(Number(meshVersion)) && Number(meshVersion) >= required;
}

export { MESH_VERSION, isOptimizableMeshUrl };
