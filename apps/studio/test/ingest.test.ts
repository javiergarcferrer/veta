// INGEST — a dropped folder becomes a review list.
//
// Run against REAL three (the split clusters real boxes) with only the two
// effectful steps injected, because the rules worth pinning are the ones a
// folder drop breaks in production:
//
//   • A SIDECAR BITMAP IS NOT A MODEL. It is never parsed, never counted as
//     work and can never surface as a casualty ("couldn't read: DCMAP1.JPG"
//     names the dealer's own textures as broken files).
//   • ONE DROP, ONE SHAPE. The taxonomy levels are read positionally against a
//     plan measured over the WHOLE drop, so sibling files file identically.
//   • A CASUALTY IS PER FILE. One bad export never costs the other twenty-nine.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import type { FileLike } from '@veta/mesh-pipeline';
import { ingestDrafts, initialIngestState, planIngest, reduceIngest, runIngest, texturesFor } from '../src/vm/ingest.ts';
import type { IngestedPiece } from '../src/vm/ingest.ts';

const file = (relPath: string): FileLike => ({
  name: relPath.split('/').pop()!,
  relPath,
  arrayBuffer: async () => new ArrayBuffer(8),
});

const SOFA = 'Upholstery/Sofas/Prado/Prado_2-seat.fbx';
const OTTOMAN = 'Upholstery/Sofas/Prado/Prado_Ottoman.fbx';
const TEXTURE = 'Upholstery/Sofas/Prado/DCMAP1.JPG';
const JUNK = 'Upholstery/Sofas/Prado/datasheet.pdf';

/** A scene with `count` boxes far enough apart to cluster as separate pieces. */
function scene(count: number): THREE.Object3D {
  const root = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(60, 60, 60),
      new THREE.MeshStandardMaterial({ name: `mat-${i}` }),
    );
    mesh.position.set(i * 200, 30, 0);
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  return root;
}

test('a drop is read before a byte is parsed: models, sidecars, junk, and one shape', () => {
  const plan = planIngest([file(SOFA), file(OTTOMAN), file(TEXTURE), file(JUNK)]);
  assert.deepEqual(plan.models.map((f) => f.name), ['Prado_2-seat.fbx', 'Prado_Ottoman.fbx']);
  assert.deepEqual(plan.textures.map((f) => f.name), ['DCMAP1.JPG']);
  assert.deepEqual(plan.rejected.map((f) => f.name), ['datasheet.pdf']);

  // Positional taxonomy: the group is a known LR division, the category is
  // whatever sits at its index, the collection is the model folder.
  assert.deepEqual(plan.rows[0]!.proposal, { group: 'Upholstery', category: 'Sofas', collection: 'Prado' });
  assert.equal(plan.rows[0]!.name, 'Prado 2 seat', 'the filename is the piece name');
  assert.deepEqual(plan.summary, { groups: 1, categories: 1, collections: 1 });
});

test('a sidecar pairs with the models of ITS OWN folder, nobody else’s', () => {
  const files = [file(SOFA), file(TEXTURE), file('Occasional/Tables/Oka/DCMAP1.JPG')];
  const paired = texturesFor(files, file(SOFA));
  assert.deepEqual(paired.map((f) => f.relPath), [TEXTURE]);
});

test('one file, one piece: the filename names it, and the piece carries its proposal', async () => {
  const out = await runIngest([file(SOFA), file(TEXTURE)], {
    loadScene: async () => ({ THREE: THREE as any, object: scene(1) as any }),
    finishPiece: async (piece, _three, index) => ({
      id: `p${index}`,
      name: piece.name,
      sourceName: piece.sourceName,
      upAxis: piece.upAxis,
      widthCm: piece.widthCm,
      depthCm: piece.depthCm,
      nodes: [],
      plan: null,
      glb: null,
      bytes: 0,
    }),
  });
  assert.equal(out.failed.length, 0, 'the bitmap is not a casualty');
  assert.equal(out.pieces.length, 1);
  assert.equal(out.pieces[0]!.name, 'Prado 2 seat');
  assert.deepEqual(out.pieces[0]!.proposal, { group: 'Upholstery', category: 'Sofas', collection: 'Prado' });
});

test('a multi-piece export splits, and every piece inherits its file’s proposal', async () => {
  const out = await runIngest([file(SOFA)], {
    loadScene: async () => ({ THREE: THREE as any, object: scene(3) as any }),
    finishPiece: async (piece, _three, index) => ({
      id: `p${index}`,
      name: piece.name,
      sourceName: piece.sourceName,
      upAxis: piece.upAxis,
      widthCm: piece.widthCm,
      depthCm: piece.depthCm,
      nodes: [],
      plan: null,
      glb: null,
      bytes: 0,
    }),
  });
  assert.equal(out.pieces.length, 3);
  for (const p of out.pieces) assert.equal(p.proposal.collection, 'Prado');
  assert.ok(out.pieces.every((p) => p.widthCm > 0 && p.depthCm > 0), 'each piece is measured');
});

test('a file that will not parse is a casualty; the rest of the drop still lands', async () => {
  const out = await runIngest([file(SOFA), file(OTTOMAN), file(JUNK)], {
    loadScene: async (f) => {
      if (f.name.startsWith('Prado_Ottoman')) throw new Error('converted badly');
      return { THREE: THREE as any, object: scene(1) as any };
    },
    finishPiece: async (piece, _three, index) => ({
      id: `p${index}`,
      name: piece.name,
      sourceName: piece.sourceName,
      upAxis: piece.upAxis,
      widthCm: piece.widthCm,
      depthCm: piece.depthCm,
      nodes: [],
      plan: null,
      glb: null,
      bytes: 0,
    }),
  });
  assert.equal(out.pieces.length, 1);
  assert.deepEqual(
    out.failed.map((f) => [f.name, f.code]),
    [['Prado_Ottoman.fbx', 'unreadable'], ['datasheet.pdf', 'unsupported']],
  );
});

test('a piece that cannot be EXPORTED is its own casualty, not a thrown batch', async () => {
  const out = await runIngest([file(SOFA)], {
    loadScene: async () => ({ THREE: THREE as any, object: scene(2) as any }),
    finishPiece: async (piece, _three, index) => {
      if (index === 0) throw new Error('the export failed');
      return {
        id: `p${index}`,
        name: piece.name,
        sourceName: piece.sourceName,
        upAxis: piece.upAxis,
        widthCm: piece.widthCm,
        depthCm: piece.depthCm,
        nodes: [],
        plan: null,
        glb: null,
        bytes: 0,
      };
    },
  });
  assert.equal(out.pieces.length, 1);
  assert.deepEqual(out.failed.map((f) => f.error), ['the export failed']);
});

test('worker events fold into the review list, and progress never rewinds', () => {
  const piece = (id: string): IngestedPiece => ({
    id,
    name: id,
    sourceName: `${id}.fbx`,
    upAxis: 'y',
    widthCm: 190,
    depthCm: 95,
    proposal: { group: null, category: null, collection: 'Prado' },
    nodes: [],
    plan: null,
    glb: null,
    bytes: 0,
  });
  let state = reduceIngest(initialIngestState(), { type: 'start', total: 3 });
  state = reduceIngest(state, { type: 'progress', done: 2, total: 3, current: 'b.fbx' });
  state = reduceIngest(state, { type: 'progress', done: 1, total: 3, current: 'a.fbx' });
  assert.equal(state.done, 2, 'a late message from a superseded run cannot rewind');
  state = reduceIngest(state, { type: 'piece', piece: piece('p1') });
  state = reduceIngest(state, { type: 'failed', failure: { name: 'c.fbx', code: 'no-pieces', error: 'empty' } });
  state = reduceIngest(state, { type: 'done' });
  assert.equal(state.running, false);
  assert.equal(state.done, 3);
  assert.equal(state.pieces.length, 1);
  assert.equal(state.failed.length, 1);

  // Drafts carry the taxonomy and the plan — but NEVER a mesh: the bytes are
  // still being uploaded, and a row pointing at a URL that does not exist yet is
  // the one shape every later check reads as valid.
  const drafts = ingestDrafts(state.pieces, 5000);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.collection, 'Prado');
  assert.equal(drafts[0]!.mesh, null);
  assert.equal(drafts[0]!.status, 'draft');
});
