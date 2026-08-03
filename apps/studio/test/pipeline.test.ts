// THE PIPELINE RUNS ITSELF — and the row-level stamp is what makes that free.
//
// Two costs are pinned here, because both were introduced the moment the
// buttons became automatic:
//   • an up-to-date catalogue must cost ZERO requests to verify (the row stamp,
//     written back on BOTH branches — `skipped` included);
//   • tagging must WAIT for the re-export, because a pre-split mesh is one node
//     per material and tagging against it would key the parts off the old
//     grouping — the keys the dealer's own corrections hang on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MESH_VERSION } from '@veta/mesh-pipeline';

import {
  meshVersionOfRow, owesReExport, planAutoDetect, planAutoOptimize,
  resolvePipelineStatus, stampFreshUpload, stampOptimized,
} from '../src/vm/pipeline.ts';
import { optimizableModels } from '../src/vm/optimize.ts';
import { emptyModel } from '../src/vm/types.ts';
import type { StudioModel } from '../src/vm/types.ts';

const model = (id: string, url: string | null, meshVersion: number | null = null): StudioModel => ({
  ...emptyModel(id, id, 0),
  mesh: url ? { url, upAxis: 'y', meshVersion } : null,
});

test('the row stamp decides, so an up-to-date catalogue costs no downloads', () => {
  const rows = [
    model('never', 'https://cdn/a.glb', null),          // 0 = never exported
    model('stale', 'https://cdn/b.glb', MESH_VERSION - 1),
    model('current', 'https://cdn/c.glb', MESH_VERSION),
    model('ahead', 'https://cdn/d.glb', MESH_VERSION + 1),
    model('raw', 'https://cdn/e.fbx', null),            // no stamp to read, ever
    model('meshless', null),
  ];
  assert.deepEqual(optimizableModels(rows).map((m) => m.id), ['never', 'stale']);
  assert.equal(meshVersionOfRow(rows[0]!.mesh), 0, 'absent reads as never');
  assert.equal(owesReExport(rows[2]), false);
  assert.equal(owesReExport(rows[4]), false, 'a raw CAD upload is not in the run');
  assert.equal(owesReExport(null), false);
});

test('the drain fires ONCE per session, and only when there is work', () => {
  const owed = [model('a', 'https://cdn/a.glb', null)];
  assert.equal(planAutoOptimize(owed).run, true);
  assert.equal(planAutoOptimize(owed, { started: true }).reason, 'already-started');
  assert.equal(planAutoOptimize(owed, { running: true }).reason, 'in-flight');
  assert.equal(planAutoOptimize([model('a', 'https://cdn/a.glb', MESH_VERSION)]).reason, 'nothing-to-do');
  assert.equal(planAutoOptimize([]).run, false);
});

test('BOTH branches write the version back — `skipped` is the one that pays', () => {
  const row = model('a', 'https://cdn/a.glb', 0);
  // Re-exported: the row adopts the new bytes AND the stamp.
  const done = stampOptimized(row, { skipped: false, before: 900, after: 400, meshVersion: MESH_VERSION },
    { url: 'https://cdn/a-2.glb', bytes: 400 }, 111);
  assert.equal(done.mesh!.url, 'https://cdn/a-2.glb');
  assert.equal(done.mesh!.bytes, 400);
  assert.equal(done.mesh!.meshVersion, MESH_VERSION);

  // Already current INSIDE the file: nothing was written, but the DOWNLOAD was
  // already paid. Recording it is what retires the row.
  const skipped = stampOptimized(row, { skipped: true, before: 900, after: 900, meshVersion: MESH_VERSION }, null, 222);
  assert.equal(skipped.mesh!.url, 'https://cdn/a.glb', 'nothing re-uploaded');
  assert.equal(skipped.mesh!.meshVersion, MESH_VERSION);
  assert.equal(owesReExport(skipped), false, 'and it never costs another download');
});

test('a fresh upload stamps what it produced; a passthrough deliberately does not', () => {
  const mesh = { url: 'https://cdn/new.glb', upAxis: 'y' as const, bytes: 10 };
  // Straight out of exportPieceGlb: already one mesh per solid. Saying so is
  // what stops the pass re-exporting it to a byte-identical result AND what
  // lets it be tagged straight away.
  assert.equal(stampFreshUpload(mesh, { reExported: true }).meshVersion, MESH_VERSION);
  // A GLB we passed through untouched: nothing re-exported it, so the pass
  // still owes it a look.
  assert.equal(stampFreshUpload(mesh, { reExported: false }).meshVersion, null);
  assert.equal(owesReExport({ ...emptyModel('x', 'x', 0), mesh: stampFreshUpload(mesh, { reExported: true }) }), false);
  assert.equal(owesReExport({ ...emptyModel('x', 'x', 0), mesh: stampFreshUpload(mesh, { reExported: false }) }), true);
});

test('tagging WAITS for the re-export — pre-split keys would mis-key corrections', () => {
  const seen = new Set<string>();
  const stale = model('a', 'https://cdn/a.glb', 0);
  assert.deepEqual(planAutoDetect({ model: stale, draft: {}, seen }), { detect: false, reason: 'awaiting-re-export' });

  const current = model('a', 'https://cdn/a.glb', MESH_VERSION);
  assert.deepEqual(planAutoDetect({ model: current, draft: {}, seen }), { detect: true, reason: 'ready' });
  // …and never over a tagging that already exists.
  assert.equal(planAutoDetect({ model: current, draft: { mats: { COL0: 'cushion' } }, seen }).reason, 'already-tagged');
  // Busy is busy: a detect fired mid-drain would read the file about to change.
  assert.equal(planAutoDetect({ model: current, draft: {}, seen, optimizing: true }).reason, 'busy');
  assert.equal(planAutoDetect({ model: current, draft: {}, seen, detecting: true }).reason, 'busy');
  assert.equal(planAutoDetect({ model: model('a', null), draft: {}, seen }).reason, 'no-mesh');

  // ONCE PER MODEL PER SESSION: a model that legitimately yields no groups must
  // not sit there re-detecting forever.
  seen.add('a');
  assert.equal(planAutoDetect({ model: current, draft: {}, seen }).reason, 'seen-this-session');

  // A raw .fbx has no stamp to read and is never re-exported, so waiting for one
  // would strand it untagged forever — it tags on its own terms.
  const raw = model('b', 'https://cdn/b.fbx', 0);
  assert.equal(planAutoDetect({ model: raw, draft: {}, seen }).reason, 'ready');
});

test('what is left on screen is a read-out, never a button', () => {
  assert.equal(resolvePipelineStatus({ detecting: true }).busy, true);
  assert.match(resolvePipelineStatus({ optimizing: true, done: 3, total: 9 }).label, /3\/9/);
  assert.equal(resolvePipelineStatus({ owed: 4 }).busy, false);
  assert.match(resolvePipelineStatus({ owed: 0 }).label, /up to date/i);
});
