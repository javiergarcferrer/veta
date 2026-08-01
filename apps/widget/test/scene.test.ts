/**
 * Plan → scene projection. Axes, centring and framing: the three conversions
 * that, when wrong, read as "the 3D is broken" rather than "a sign is flipped".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SCENE_RADIUS, resolveSceneView, sceneFabricCodes } from '../src/vm/scene.ts';
import { resolveWidgetCatalog } from '../src/vm/catalog.ts';
import { catalogPayload } from './fixtures.ts';
import type { PlacedPiece } from '../src/vm/editor.ts';

const catalog = resolveWidgetCatalog({ payload: catalogPayload });

const piece = (uid: string, pieceId: string, x: number, y: number, extra: Partial<PlacedPiece> = {}): PlacedPiece =>
  ({ uid, pieceId, x, y, rot: 0, ...extra });

test('an empty plan yields a lit, framed, empty stage', () => {
  const view = resolveSceneView([], catalog.modelById);
  assert.deepEqual(view.pieces, []);
  assert.equal(view.radius, EMPTY_SCENE_RADIUS);
  assert.deepEqual(view.offset, { x: 0, z: 0 });
});

test('plan y becomes world z, and the piece is placed on its CENTRE', () => {
  const view = resolveSceneView([piece('a', 'm-fireside', 100, 200)], catalog.modelById);
  const p = view.pieces[0];
  // A single piece is centred, so its own centre is the origin.
  assert.equal(p.x, 0);
  assert.equal(p.z, 0);
  assert.equal(view.offset.x, 100 + 78 / 2);
  assert.equal(view.offset.z, 200 + 102 / 2);
});

test('the build is CENTRED however far from the plan origin it was dragged', () => {
  const near = resolveSceneView(
    [piece('a', 'm-fireside', 0, 0), piece('b', 'm-ottoman', 78, 0)],
    catalog.modelById,
  );
  const far = resolveSceneView(
    [piece('a', 'm-fireside', 5000, -3000), piece('b', 'm-ottoman', 5078, -3000)],
    catalog.modelById,
  );
  assert.deepEqual(near.pieces.map((p) => [p.x, p.z]), far.pieces.map((p) => [p.x, p.z]));
});

test('the framing radius grows with the build (never a constant)', () => {
  const one = resolveSceneView([piece('a', 'm-fireside', 0, 0)], catalog.modelById);
  const many = resolveSceneView(
    [0, 1, 2, 3, 4].map((i) => piece(`p${i}`, 'm-fireside', i * 78, 0)),
    catalog.modelById,
  );
  assert.ok(many.radius > one.radius, 'a long sectional must not be framed like one ottoman');
});

test('rotation rides through in degrees; the mesh carries the turn', () => {
  const view = resolveSceneView([piece('a', 'm-fireside', 0, 0, { rot: 90 })], catalog.modelById);
  assert.equal(view.pieces[0].rotationDeg, 90);
});

test('a seat-mounted accessory is marked as one; its height is the scene\'s until the wire carries it', () => {
  const view = resolveSceneView([piece('c', 'm-cushion', 0, 0)], catalog.modelById);
  assert.equal(view.pieces[0].mountHeightCm, null);
  // The mount itself IS carried — it is what keeps a cushion out of the plan's
  // collision/contact graph.
  assert.equal(catalog.modelById['m-cushion']!.mount, 'seat');
  assert.equal(catalog.ruleCatalog.modelById['m-cushion']!.mount, 'seat');
});

test('a piece whose model vanished is DROPPED, never a mystery box', () => {
  const view = resolveSceneView(
    [piece('a', 'm-fireside', 0, 0), piece('ghost', 'unpublished', 0, 0)],
    catalog.modelById,
  );
  assert.equal(view.pieces.length, 1);
  assert.equal(view.pieces[0].uid, 'a');
});

test('sceneFabricCodes collects the piece picks AND the per-part picks, deduped', () => {
  const view = resolveSceneView(
    [
      piece('a', 'm-fireside', 0, 0, { material: { code: 'B0021' } }),
      piece('b', 'm-ottoman', 78, 0, {
        material: { code: 'B0021' },
        partMaterials: { exterior: { code: 'B0032' }, interior: { code: 'B0021' } },
      }),
      piece('c', 'm-cushion', 0, 0),
    ],
    catalog.modelById,
  );
  assert.deepEqual(sceneFabricCodes(view).sort(), ['B0021', 'B0032']);
  assert.deepEqual(sceneFabricCodes(resolveSceneView([], catalog.modelById)), []);
});

test('the mesh reference and its params ride to the loader', () => {
  const view = resolveSceneView([piece('a', 'm-fireside', 0, 0)], catalog.modelById);
  assert.equal(view.pieces[0].meshUrl, 'meshes/fireside.glb');
  assert.deepEqual(view.pieces[0].meshParams, { scale: 1 });
  // A model with no mesh reports null → the scene takes its fallback shape.
  assert.equal(resolveSceneView([piece('b', 'm-ottoman', 0, 0)], catalog.modelById).pieces[0].meshUrl, null);
});
