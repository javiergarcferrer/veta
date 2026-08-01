/**
 * The exports. The DXF is the one an architect drops into AutoCAD at 1:1, so
 * what is pinned here is that the drawing exists, carries every placed piece,
 * and survives a model with no CAD outline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { availableExports, buildPlanDxf, exportFilename } from '../src/vm/exports.ts';
import { resolveWidgetCatalog } from '../src/vm/catalog.ts';
import { catalogPayload } from './fixtures.ts';
import type { PlacedPiece } from '../src/vm/editor.ts';

const catalog = resolveWidgetCatalog({ payload: catalogPayload });
const placed: PlacedPiece[] = [
  { uid: 'p1', pieceId: 'm-fireside', x: 0, y: 0, rot: 0 },
  { uid: 'p2', pieceId: 'm-ottoman', x: 69, y: 0, rot: 90 },
];

test('the DXF is a real drawing with the expected sections', () => {
  const dxf = buildPlanDxf(placed, catalog.modelById, { label: 'Duna' });
  assert.match(dxf, /SECTION/);
  assert.match(dxf, /ENTITIES/);
  assert.match(dxf, /EOF\s*$/);
  assert.ok(dxf.length > 500);
});

test('a model with NO plan outline still exports (its footprint squared off)', () => {
  // m-ottoman carries no plan_svg — the piece must still appear.
  const dxf = buildPlanDxf([placed[1]], catalog.modelById, {});
  assert.match(dxf, /ENTITIES/);
  assert.ok(dxf.includes('Ottoman'), 'the piece label belongs in the drawing');
});

test('a piece whose model vanished is skipped, never a zero-size box', () => {
  const dxf = buildPlanDxf(
    [...placed, { uid: 'p3', pieceId: 'gone', x: 0, y: 0, rot: 0 }],
    catalog.modelById,
    {},
  );
  assert.ok(dxf.length > 0);
  assert.equal(dxf.includes('gone'), false);
});

test('an empty plan still produces a valid (empty) document', () => {
  assert.doesNotThrow(() => buildPlanDxf([], catalog.modelById, {}));
  assert.match(buildPlanDxf([], catalog.modelById, {}), /EOF/);
});

test('the layer prefix is a parameter (one drawing namespaces cleanly)', () => {
  assert.match(buildPlanDxf(placed, catalog.modelById, { layerPrefix: 'DUNA' }), /DUNA-/);
});

test('filenames are filesystem-safe and dated', () => {
  assert.equal(exportFilename('Duna Sofá', 'dxf', new Date('2026-08-01T10:00:00Z')), 'duna-sofa-2026-08-01.dxf');
  assert.equal(exportFilename('', 'glb', new Date('2026-08-01T10:00:00Z')), 'design-2026-08-01.glb');
  assert.equal(exportFilename('///', '.obj', new Date('2026-08-01T10:00:00Z')), 'design-2026-08-01.obj');
});

test('an empty plan offers NO exports (a blank sheet reads as a broken button)', () => {
  assert.deepEqual(availableExports(0, true), []);
  assert.deepEqual(availableExports(2, true), ['dxf', 'glb', 'obj']);
  // Without a 3D pipeline only the plan can be produced.
  assert.deepEqual(availableExports(2, false), ['dxf']);
});
