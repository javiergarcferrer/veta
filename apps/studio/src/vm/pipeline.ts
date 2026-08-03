/**
 * THE PIPELINE RUNS ITSELF — what the studio does without being asked.
 *
 * «Detect parts» and «Optimize meshes» were buttons for MAINTENANCE, not
 * decisions: nobody should have to know that a 3D file predates the current mesh
 * pipeline, or that a model was never tagged. So the re-export drains the
 * catalogue by itself when the studio opens, a model tags itself the first time
 * it is opened untagged, and what is left on screen is a passive read-out of
 * work in flight.
 *
 * Automating it exposed a cost the buttons had been hiding: the only way to know
 * whether a file was current was to DOWNLOAD it and read its GLB stamp — a whole
 * catalogue of traffic per session just to learn there was nothing to do. So the
 * ROW records the pipeline version it was exported through (`mesh_v`, migration
 * 0004, default 0 = never), the pass filters on it, and BOTH branches write it
 * back — including `skipped`, which is exactly what retires a file that was
 * already current inside. An up-to-date catalogue costs zero requests; the stamp
 * inside the file stays the authority for anything that did not come through
 * this app.
 *
 * Every decision here is pure. The React shell owns the clock, the idle
 * callback and the worker; it owns no rules.
 */
import { MESH_VERSION, isOptimizableMeshUrl } from '@veta/mesh-pipeline';
import type { OptimizeReport } from './optimize.ts';
import type { MeshRef, StudioModel } from './types.ts';

/** The version a row claims. Absent/junk reads as 0 — "never exported through
 *  the pipeline", which is true of every row that predates the stamp. */
export const meshVersionOfRow = (mesh: MeshRef | null | undefined): number =>
  Number(mesh?.meshVersion) || 0;

/**
 * Whether a model still owes the pipeline a pass. TWO clauses, and both matter:
 * a row still serving a raw .fbx/.obj carries no stamp to read and no round trip
 * we can promise is lossless, and a row already at the current version costs
 * nothing to leave alone. ONE predicate, so a read-out's count and the run
 * itself can never disagree about the size of the job.
 */
export function owesReExport(model: StudioModel | null | undefined, required: number = MESH_VERSION): boolean {
  if (!model?.mesh?.url) return false;
  return isOptimizableMeshUrl(model.mesh.url) && meshVersionOfRow(model.mesh) < required;
}

export interface AutoOptimizePlan {
  /** Whether the shell should start the drain now. */
  run: boolean;
  /** The models it would touch — the run's own filter, already applied. */
  models: StudioModel[];
  /** Why not, when `run` is false. Never silent: this is what the read-out says. */
  reason: 'ready' | 'already-started' | 'nothing-to-do' | 'in-flight';
}

/**
 * Should the automatic re-export start?
 *
 * ONCE PER SESSION (`started`), because the drain is idempotent but not free —
 * every model it picks up costs a download — and a re-entrant effect would fire
 * it again on every render that changed the count.
 */
export function planAutoOptimize(
  models: readonly StudioModel[] | null | undefined,
  { started = false, running = false, required = MESH_VERSION }:
  { started?: boolean; running?: boolean; required?: number } = {},
): AutoOptimizePlan {
  const owed = (models || []).filter((m) => owesReExport(m, required));
  if (running) return { run: false, models: owed, reason: 'in-flight' };
  if (started) return { run: false, models: owed, reason: 'already-started' };
  if (!owed.length) return { run: false, models: owed, reason: 'nothing-to-do' };
  return { run: true, models: owed, reason: 'ready' };
}

export interface AutoDetectPlan {
  detect: boolean;
  /** Never silent — the read-out and the tests both read this. */
  reason: 'ready' | 'no-mesh' | 'awaiting-re-export' | 'already-tagged' | 'seen-this-session' | 'busy';
}

/**
 * Should this model tag itself?
 *
 * DETECTION DELIBERATELY WAITS FOR THE RE-EXPORT. A pre-split mesh is one node
 * per material, so tagging against it would key the parts off the OLD grouping —
 * and those keys are what the dealer's own corrections hang on. Re-keying a
 * catalogue silently is the one failure this whole automation must not cause.
 *
 * Guarded ONCE PER MODEL PER SESSION (`seen`), because a model that legitimately
 * yields no groups must not sit there re-detecting forever.
 */
export function planAutoDetect({
  model, draft, seen, detecting = false, optimizing = false, required = MESH_VERSION,
}: {
  model: StudioModel | null | undefined;
  /** The parts draft on screen — a model with any tagging is left alone. */
  draft?: { mats?: Record<string, unknown> | null } | null;
  seen: ReadonlySet<string>;
  detecting?: boolean;
  optimizing?: boolean;
  required?: number;
}): AutoDetectPlan {
  if (!model?.id || !model.mesh?.url) return { detect: false, reason: 'no-mesh' };
  if (detecting || optimizing) return { detect: false, reason: 'busy' };
  if (owesReExport(model, required)) return { detect: false, reason: 'awaiting-re-export' };
  if (seen.has(model.id)) return { detect: false, reason: 'seen-this-session' };
  if (Object.keys(draft?.mats || {}).length) return { detect: false, reason: 'already-tagged' };
  return { detect: true, reason: 'ready' };
}

/**
 * The row a finished optimize task writes back — BOTH branches, including
 * `skipped`.
 *
 * The skipped branch is the one that is easy to drop and the one that pays for
 * itself: a file already current INSIDE has just cost a download to discover, and
 * recording that is what stops it costing another one next session. Re-exported
 * rows additionally adopt the new URL and byte count.
 */
export function stampOptimized(
  model: StudioModel,
  report: OptimizeReport,
  upload: { url: string; bytes: number } | null,
  now: number,
): StudioModel {
  const mesh = model.mesh;
  if (!mesh) return model;
  const stamped: MeshRef = { ...mesh, meshVersion: report.meshVersion };
  if (!report.skipped && upload) { stamped.url = upload.url; stamped.bytes = upload.bytes; }
  return { ...model, mesh: stamped, updatedAt: now };
}

/**
 * The mesh reference a FRESH upload should carry.
 *
 * A file that just came out of `exportPieceGlb` IS the current pipeline — it is
 * already one mesh per solid — but if the upload does not say so it goes to
 * storage stamped 0, and the automatic pass then downloads it and re-exports it
 * to produce a byte-identical result. Worse, the untagged-model rule would skip
 * it while it waited for a re-export it does not need.
 *
 * A GLB we PASSED THROUGH untouched (`reExported: false` — the servable file IS
 * the upload) deliberately does NOT get the stamp: nothing re-exported it, so
 * the pass still owes it a look.
 */
export function stampFreshUpload(
  mesh: MeshRef,
  { reExported, version = MESH_VERSION }: { reExported: boolean; version?: number },
): MeshRef {
  return reExported ? { ...mesh, meshVersion: version } : { ...mesh, meshVersion: null };
}

/** The passive read-out under the toolbar: what is in flight, in words. There is
 *  nothing to press, so this is the whole of what the dealer is told. */
export function resolvePipelineStatus({
  detecting = false, optimizing = false, done = 0, total = 0, owed = 0,
}: {
  detecting?: boolean; optimizing?: boolean; done?: number; total?: number; owed?: number;
}): { busy: boolean; label: string } {
  if (detecting) return { busy: true, label: 'Detecting parts…' };
  if (optimizing) return { busy: true, label: `Preparing meshes ${done}/${total}` };
  if (owed > 0) return { busy: false, label: `${owed} mesh(es) queued` };
  return { busy: false, label: 'Meshes up to date' };
}
