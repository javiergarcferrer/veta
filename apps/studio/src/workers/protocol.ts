/**
 * THE WORKER WIRE — every message that crosses the main-thread boundary.
 *
 * Pure types plus two tiny helpers, in its own module so the worker and its
 * client cannot drift: a worker is compiled into a separate bundle, so a shape
 * mismatch between the two halves is invisible to every other check.
 *
 * BYTES MOVE, THEY ARE NEVER COPIED: every `ArrayBuffer` on this wire is posted
 * as a TRANSFERABLE (`transfersOf`). A 30 MB CAD export structured-cloned back
 * and forth is the cost the worker exists to avoid — and after a transfer the
 * SENDER's buffer is detached, which is deliberate: it makes accidental reuse
 * of a handed-off buffer throw here instead of silently rendering stale bytes.
 */
import type { IngestedPiece } from '../vm/ingest.ts';
import type { MeasuredNode, PlanRef } from '../vm/types.ts';
import type { IngestFailure } from '@veta/mesh-pipeline';

/* ── optimize.worker ────────────────────────────────────────────────────────*/

export interface OptimizeRequest {
  kind: 'optimize';
  id: string;
  name?: string;
  /** The published GLB, transferred in. */
  buffer: ArrayBuffer;
}

export type OptimizeResponse =
  | {
    kind: 'optimize-done';
    id: string;
    /** The file already carried this pipeline's stamp — nothing was re-exported. */
    skipped: boolean;
    before: number;
    after: number;
    meshVersion: number;
    /** The re-exported bytes, transferred out. Null when skipped. */
    buffer: ArrayBuffer | null;
  }
  | { kind: 'optimize-failed'; id: string; error: string };

/* ── ingest.worker ──────────────────────────────────────────────────────────*/

export interface IngestRequest {
  kind: 'ingest';
  id: string;
  /** The dropped tree, verbatim. `File` is structured-cloneable, so the worker
   *  reads the bytes itself and the main thread never holds them. */
  files: File[];
  /**
   * Each file's path INSIDE the dropped tree, positionally.
   *
   * Sent separately because `webkitRelativePath` is not part of what a
   * structured clone of a `File` preserves — and the path is not decoration
   * here, it IS the taxonomy proposal (group / category / collection). Losing it
   * silently would file a whole library as untitled.
   */
  paths: string[];
}

export type IngestResponse =
  | { kind: 'ingest-progress'; id: string; done: number; total: number; current: string }
  | { kind: 'ingest-piece'; id: string; piece: IngestedPiece }
  | { kind: 'ingest-failed-file'; id: string; failure: IngestFailure }
  | { kind: 'ingest-done'; id: string }
  | { kind: 'ingest-error'; id: string; error: string };

/**
 * MEASURE — one already-published GLB re-read for its mesh nodes and its plan.
 *
 * The same worker, because it is the same three parse. It exists so «detect
 * parts» works on a STORED model without the main thread ever holding a CAD
 * file: ingest hands the nodes over for free, and this is how a model ingested
 * before parts existed catches up.
 */
export interface MeasureRequest {
  kind: 'measure';
  id: string;
  buffer: ArrayBuffer;
  upAxis: 'y' | 'z';
}

export type MeasureResponse =
  | { kind: 'measure-done'; id: string; nodes: MeasuredNode[]; plan: PlanRef | null }
  | { kind: 'measure-failed'; id: string; error: string };

export type WorkerRequest = OptimizeRequest | IngestRequest | MeasureRequest;
export type WorkerResponse = OptimizeResponse | IngestResponse | MeasureResponse;

/** Every buffer a response carries, for the `postMessage` transfer list. */
export function transfersOf(message: WorkerResponse): Transferable[] {
  if (message.kind === 'optimize-done' && message.buffer) return [message.buffer];
  if (message.kind === 'ingest-piece' && message.piece.glb) return [message.piece.glb];
  return [];
}

/**
 * The dedicated-worker global, typed to what we use.
 *
 * Deliberately a cast rather than `lib: ["WebWorker"]`: adding that lib next to
 * `DOM` collides on dozens of globals, and three.js — which these workers load —
 * is typed against DOM. The narrow surface below is the whole contract a worker
 * script needs.
 */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export const workerScope = (): WorkerScope => (globalThis as unknown as WorkerScope);
