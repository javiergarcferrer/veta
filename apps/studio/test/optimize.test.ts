// THE OPTIMIZE RUN — one rule for what the batch is about, and an accounting
// that stays honest when half of it was already done.
//
// A row still serving a raw .fbx/.obj carries no stamp to read and no round trip
// we can promise is lossless, so it is not in the run at all — and the button's
// COUNT and the RUN read the same predicate, which is what stops them
// disagreeing about the size of the job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MESH_VERSION } from '@veta/mesh-pipeline';

import { isMeshCurrent, optimizableModels, planOptimizeRun, summarizeOptimizeRun } from '../src/vm/optimize.ts';
import type { OptimizeReport } from '../src/vm/optimize.ts';
import { runQueue } from '../src/vm/queue.ts';
import { emptyModel } from '../src/vm/types.ts';
import type { StudioModel } from '../src/vm/types.ts';

const withMesh = (id: string, url: string | null): StudioModel => ({
  ...emptyModel(id, id, 0),
  mesh: url ? { url, upAxis: 'y', meshVersion: null } : null,
});

const models: StudioModel[] = [
  withMesh('a', 'https://cdn/a.glb'),
  withMesh('b', 'https://cdn/b.gltf?v=2'),
  withMesh('c', 'https://cdn/c.fbx'),   // no stamp to read — never in the run
  withMesh('d', null),
];

test('only stamped-capable GLBs are in the run, and the count is that same rule', () => {
  assert.deepEqual(optimizableModels(models).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(planOptimizeRun(models).items.map((i) => i.id), ['a', 'b']);
  assert.equal(planOptimizeRun(models).concurrency, 3);
});

test('a run accounts for skipped, re-exported and failed — and the savings are real', async () => {
  const state = planOptimizeRun([...models, withMesh('e', 'https://cdn/e.glb'), withMesh('f', 'https://cdn/f.glb')]);
  const final = await runQueue<OptimizeReport>(state, async (item) => {
    if (item.id === 'f') throw new Error('unreadable');
    if (item.id === 'b') return { skipped: true, before: 500, after: 500, meshVersion: MESH_VERSION };
    return { skipped: false, before: 1000, after: 400, meshVersion: MESH_VERSION };
  });
  const summary = summarizeOptimizeRun(final);
  assert.equal(summary.total, 4);
  assert.equal(summary.optimized, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.casualties, ['f']);
  assert.equal(summary.before, 2500);
  assert.equal(summary.after, 1300);
  assert.equal(summary.saved, 1200);
});

test('a half-finished run summarizes exactly like a complete one', () => {
  const state = planOptimizeRun(models);
  state.items[0]!.state = 'done';
  state.items[0]!.result = { skipped: false, before: 100, after: 40, meshVersion: MESH_VERSION };
  const summary = summarizeOptimizeRun(state);
  assert.equal(summary.optimized, 1);
  assert.equal(summary.saved, 60);
  assert.equal(summary.total, 2, 'the pending item is still part of the job');
});

test('a re-export that GREW the file is not a saving', () => {
  const state = planOptimizeRun([withMesh('a', 'https://cdn/a.glb')]);
  state.items[0]!.state = 'done';
  state.items[0]!.result = { skipped: false, before: 100, after: 140, meshVersion: MESH_VERSION };
  assert.equal(summarizeOptimizeRun(state).saved, 0);
});

test('"already current" is read off the stamp, per model', () => {
  assert.equal(isMeshCurrent(MESH_VERSION), true);
  assert.equal(isMeshCurrent(MESH_VERSION + 1), true);
  assert.equal(isMeshCurrent(0), false);
  assert.equal(isMeshCurrent(null), false);
});
