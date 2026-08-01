/**
 * OPTIMIZE WORKER — crease → weld → quantize → stamp, off the main thread.
 *
 * The single heaviest thing the studio does. `optimizeGlbBuffer` is
 * `@veta/mesh-pipeline`'s and unchanged; all this file does is give it a thread,
 * a three namespace and a wire.
 *
 * IDEMPOTENT BY THE FILE'S OWN STAMP: a GLB already at the current mesh version
 * comes back `skipped` with no re-export and no bytes, so a re-run costs the
 * transfer and nothing else, and an interrupted batch resumes for free.
 *
 * ONE MESSAGE, ONE FILE. Concurrency is the QUEUE's job (`vm/queue`, three
 * lanes) — the client spawns a small pool rather than letting one worker
 * interleave parses, because a parse holds a whole CAD export in memory and
 * three of them is already the ceiling.
 */
import { MESH_VERSION, optimizeGlbBuffer } from '@veta/mesh-pipeline';
import type { OptimizeRequest, OptimizeResponse } from './protocol.ts';
import { transfersOf, workerScope } from './protocol.ts';
import { loadThree } from './threeDeps.ts';

const scope = workerScope();

const reply = (message: OptimizeResponse): void => {
  scope.postMessage(message, transfersOf(message));
};

scope.addEventListener('message', (event) => {
  const req = event.data as OptimizeRequest;
  if (!req || req.kind !== 'optimize') return;
  void run(req);
});

async function run(req: OptimizeRequest): Promise<void> {
  try {
    const { THREE, utils, exporter, parseGlb } = await loadThree();
    const result = await optimizeGlbBuffer(req.buffer, {
      THREE,
      utils,
      exporter: exporter(),
      parseGlb,
    });
    reply({
      kind: 'optimize-done',
      id: req.id,
      skipped: result.skipped,
      before: result.before,
      after: result.after,
      meshVersion: MESH_VERSION,
      buffer: result.buffer,
    });
  } catch (e) {
    // A file that cannot be read is THIS model's casualty, never the batch's:
    // the queue marks it failed, names it, and the other twenty-nine finish.
    reply({ kind: 'optimize-failed', id: req.id, error: (e as Error)?.message || 'Optimize failed.' });
  }
}
