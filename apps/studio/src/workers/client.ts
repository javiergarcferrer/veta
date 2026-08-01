/**
 * THE MAIN-THREAD SIDE of both workers — spawn, post, resolve, terminate.
 *
 * Thin on purpose: nothing here decides anything. The queue decides how many
 * run at once (`vm/queue`), the vm decides what a piece becomes, and this file
 * only carries bytes across the boundary and back.
 *
 * A POOL, NOT A WORKER PER TASK. Three lanes means three workers, each holding
 * ONE request at a time: three.js costs ~730 KB of module evaluation per worker,
 * so spawning one per file would pay that for every model in the library, and
 * letting a single worker interleave parses would hold several whole CAD exports
 * in one heap.
 */
import OptimizeWorker from './optimize.worker.ts?worker';
import IngestWorker from './ingest.worker.ts?worker';
import { DEFAULT_CONCURRENCY } from '../vm/queue.ts';
import type { IngestFailure, IngestedPiece } from '../vm/ingest.ts';
import type { MeasuredNode, PlanRef } from '../vm/types.ts';
import type {
  IngestRequest,
  IngestResponse,
  MeasureRequest,
  MeasureResponse,
  OptimizeRequest,
  OptimizeResponse,
} from './protocol.ts';

export interface OptimizeOutcome {
  skipped: boolean;
  before: number;
  after: number;
  meshVersion: number;
  buffer: ArrayBuffer | null;
}

export interface OptimizeClient {
  optimize(id: string, buffer: ArrayBuffer, name?: string): Promise<OptimizeOutcome>;
  dispose(): void;
}

interface Lane {
  worker: Worker;
  busy: boolean;
}

/** A pool of optimize workers, one in-flight request each. */
export function createOptimizeClient(size: number = DEFAULT_CONCURRENCY): OptimizeClient {
  const lanes: Lane[] = [];
  const waiting: ((lane: Lane) => void)[] = [];
  let disposed = false;

  const acquire = (): Promise<Lane> => {
    const free = lanes.find((l) => !l.busy);
    if (free) { free.busy = true; return Promise.resolve(free); }
    if (lanes.length < Math.max(1, size)) {
      const lane: Lane = { worker: new OptimizeWorker(), busy: true };
      lanes.push(lane);
      return Promise.resolve(lane);
    }
    return new Promise((resolve) => waiting.push(resolve));
  };

  const release = (lane: Lane): void => {
    const next = waiting.shift();
    if (next) { next(lane); return; }
    lane.busy = false;
  };

  return {
    async optimize(id, buffer, name) {
      if (disposed) throw new Error('The optimize client is disposed.');
      const lane = await acquire();
      try {
        return await new Promise<OptimizeOutcome>((resolve, reject) => {
          const onMessage = (event: MessageEvent<OptimizeResponse>): void => {
            const msg = event.data;
            if (!msg || msg.id !== id) return;             // never another task's reply
            lane.worker.removeEventListener('message', onMessage);
            lane.worker.removeEventListener('error', onError);
            if (msg.kind === 'optimize-failed') { reject(new Error(msg.error)); return; }
            resolve({
              skipped: msg.skipped,
              before: msg.before,
              after: msg.after,
              meshVersion: msg.meshVersion,
              buffer: msg.buffer,
            });
          };
          const onError = (event: ErrorEvent): void => {
            lane.worker.removeEventListener('message', onMessage);
            lane.worker.removeEventListener('error', onError);
            reject(new Error(event.message || 'The optimize worker crashed.'));
          };
          lane.worker.addEventListener('message', onMessage);
          lane.worker.addEventListener('error', onError);
          const req: OptimizeRequest = { kind: 'optimize', id, name, buffer };
          // TRANSFERRED, not copied — and the sender's buffer is detached, which
          // is what makes an accidental reuse throw instead of shipping stale
          // bytes.
          lane.worker.postMessage(req, [buffer]);
        });
      } finally {
        release(lane);
      }
    },
    dispose() {
      disposed = true;
      for (const lane of lanes) lane.worker.terminate();
      lanes.length = 0;
      waiting.length = 0;
    },
  };
}

export interface IngestProgress {
  done: number;
  total: number;
  current: string;
}

export interface IngestCallbacks {
  onProgress?(p: IngestProgress): void;
  onPiece?(piece: IngestedPiece): void;
  onFailure?(failure: IngestFailure): void;
}

/**
 * Run ONE ingest in its own worker, torn down when it finishes.
 *
 * A drop is a one-shot event with a big peak heap (a whole CAD library passes
 * through it), so the worker is disposable by design: terminating it is the only
 * reliable way to hand every byte back.
 */
export function ingestInWorker(
  files: readonly File[],
  { onProgress, onPiece, onFailure }: IngestCallbacks = {},
): Promise<{ pieces: IngestedPiece[]; failed: IngestFailure[] }> {
  return new Promise((resolve, reject) => {
    const worker = new IngestWorker();
    const id = `ingest-${Date.now().toString(36)}`;
    const pieces: IngestedPiece[] = [];
    const failed: IngestFailure[] = [];
    const finish = (fn: () => void): void => { worker.terminate(); fn(); };

    worker.addEventListener('message', (event: MessageEvent<IngestResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== id) return;
      switch (msg.kind) {
        case 'ingest-progress':
          onProgress?.({ done: msg.done, total: msg.total, current: msg.current });
          break;
        case 'ingest-piece':
          pieces.push(msg.piece);
          onPiece?.(msg.piece);
          break;
        case 'ingest-failed-file':
          failed.push(msg.failure);
          onFailure?.(msg.failure);
          break;
        case 'ingest-done':
          finish(() => resolve({ pieces, failed }));
          break;
        case 'ingest-error':
          finish(() => reject(new Error(msg.error)));
          break;
        default:
          break;
      }
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      finish(() => reject(new Error(event.message || 'The ingest worker crashed.')));
    });

    // `paths` rides alongside because a structured-cloned File loses
    // `webkitRelativePath`, and the path IS the taxonomy proposal.
    const req: IngestRequest = {
      kind: 'ingest',
      id,
      files: [...files],
      paths: files.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name),
    };
    worker.postMessage(req);
  });
}

/**
 * Re-measure ONE published GLB — the nodes «detect parts» classifies and the
 * plan a tile draws — without the main thread ever parsing a mesh.
 */
export function measureInWorker(
  buffer: ArrayBuffer,
  upAxis: 'y' | 'z' = 'y',
): Promise<{ nodes: MeasuredNode[]; plan: PlanRef | null }> {
  return new Promise((resolve, reject) => {
    const worker = new IngestWorker();
    const id = `measure-${Date.now().toString(36)}`;
    const finish = (fn: () => void): void => { worker.terminate(); fn(); };
    worker.addEventListener('message', (event: MessageEvent<MeasureResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== id) return;
      if (msg.kind === 'measure-done') finish(() => resolve({ nodes: msg.nodes, plan: msg.plan }));
      else if (msg.kind === 'measure-failed') finish(() => reject(new Error(msg.error)));
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      finish(() => reject(new Error(event.message || 'The measure worker crashed.')));
    });
    const req: MeasureRequest = { kind: 'measure', id, buffer, upAxis };
    worker.postMessage(req, [buffer]);
  });
}
