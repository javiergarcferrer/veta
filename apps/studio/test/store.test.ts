// THE STORE SEAM — the in-memory implementation is what every other test runs
// against, so it has to behave like persistence where the workflow can tell:
// reads hand out COPIES (a caller mutating what it listed must not silently
// edit the store), a save stamps the clock, and a missing mesh fails the way a
// 404 does — as one model's casualty, not as a throw nobody catches.
//
// The supabase adapter is MOCKED (see its header); what is pinned here is the
// ROW MAPPING, because that is the half the workflow's types have to agree with.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../src/store/memory.ts';
import { fromRow, toRow } from '../src/store/supabase.ts';
import { emptyModel } from '../src/vm/types.ts';
import type { StudioModel } from '../src/vm/types.ts';

const model = (id: string): StudioModel => ({
  ...emptyModel(id, 'Prado', 0),
  collection: 'Prado',
  group: 'Upholstery',
  category: 'Sofas',
  mesh: { url: 'memory://x.glb', upAxis: 'z', scale: null, rotateY: 90, meshVersion: 4, bytes: 1234, sourceUrl: null, sourceName: 'Prado.fbx' },
  plan: { svg: '<svg/>', widthCm: 190, depthCm: 95 },
  productRoot: '10574010',
  parts: { mats: { legs: 'structure' }, roots: { cushion: 'SET-2' } },
  status: 'published',
  publishedAt: 1700000000000,
});

test('a save stamps the clock and hands back the STORED row', async () => {
  const store = createMemoryStore({ now: () => 4242 });
  const saved = await store.saveModel(model('a'));
  assert.equal(saved.updatedAt, 4242);
  assert.deepEqual((await store.listModels()).map((m) => m.id), ['a']);
});

test('reads are copies — mutating what you listed cannot edit the store', async () => {
  const store = createMemoryStore({ models: [model('a')] });
  const [listed] = await store.listModels();
  (listed!.parts as any).mats.legs = 'cushion';
  const [again] = await store.listModels();
  assert.equal((again!.parts as any).mats.legs, 'structure');
});

test('a fan-out is many rows and one intent', async () => {
  const store = createMemoryStore({ now: () => 7 });
  const rows = await store.saveModels([model('a'), model('b'), model('c')]);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal((await store.listModels()).length, 3);
});

test('mesh bytes round-trip, and a missing one fails like a 404', async () => {
  const store = createMemoryStore({ uid: () => 'u1' });
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const up = await store.uploadMesh('Prado 2 seat.glb', bytes);
  assert.equal(up.bytes, 4);
  assert.equal(store.meshBytes(up.url), 4);
  assert.equal(new Uint8Array(await store.fetchMesh(up.url))[2], 3);
  await assert.rejects(() => store.fetchMesh('memory://nope'), /No mesh stored/);
});

test('the row mapping round-trips every authored field', () => {
  const original = model('a');
  const back = fromRow(toRow(original, 'org-1'));
  assert.deepEqual(back, original);
  assert.equal(toRow(original, 'org-1').org_id, 'org-1');
});

test('a row with no mesh and no plan reads as the blanks it is', () => {
  const bare = fromRow({
    id: 'x', org_id: 'o', name: 'X', collection: null, group_name: null, category: null,
    mesh_url: null, mesh_up_axis: null, mesh_scale: null, mesh_rotate_y: null, mesh_version: null,
    mesh_bytes: null, mesh_source_url: null, mesh_source_name: null,
    plan_svg: null, width_cm: null, depth_cm: null, product_root: null, parts: null,
    status: 'draft', published_at: null, updated_at: null,
  });
  assert.equal(bare.mesh, null);
  assert.equal(bare.plan, null);
  assert.equal(bare.collection, '');
  assert.equal(bare.status, 'draft');
  assert.equal(bare.updatedAt, 0);
});
