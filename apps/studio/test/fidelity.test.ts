// THE FIDELITY CHECK — every row is an OBSERVATION, never a restatement of the
// row. That is the whole feature: a model can claim a mesh, a fabric and a
// finish and still render as a grey shell, and this panel is the only place that
// difference is visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MESH_VERSION } from '@veta/mesh-pipeline';

import { fidelityVerdict, resolveFidelityChecks } from '../src/vm/fidelity.ts';
import type { BuildReport } from '../src/vm/fidelity.ts';
import { emptyModel } from '../src/vm/types.ts';
import type { StudioModel } from '../src/vm/types.ts';

const model = (over: Partial<StudioModel> = {}): StudioModel => ({
  ...emptyModel('m', 'Prado', 1),
  collection: 'Prado',
  mesh: { url: 'https://cdn/x.glb', upAxis: 'y', meshVersion: MESH_VERSION },
  plan: { svg: '<svg/>', widthCm: 190, depthCm: 95 },
  productRoot: '10574010',
  ...over,
});

const report = (over: Partial<BuildReport> = {}): BuildReport => ({
  meshLoaded: true,
  meshCount: 12,
  factoryMeshes: 0,
  fabricWithScan: false,
  fabricPixels: false,
  finishMaterials: 0,
  ...over,
});

const at = (checks: ReturnType<typeof resolveFidelityChecks>, key: string) => checks.find((c) => c.key === key)!;

test('a claimed mesh that did not load reads BAD, not ok', () => {
  const checks = resolveFidelityChecks({ model: model(), report: report({ meshLoaded: false }) });
  assert.equal(at(checks, 'mesh').level, 'bad');
  assert.match(at(checks, 'mesh').detail, /generic shape/);
  assert.equal(fidelityVerdict(checks), 'bad');
});

test('while a build is in flight the render rows are IDLE, never the last model’s findings', () => {
  const checks = resolveFidelityChecks({ model: model(), report: report({ meshLoaded: true, factoryMeshes: 9 }), building: true });
  assert.equal(at(checks, 'mesh').level, 'idle');
  assert.equal(at(checks, 'factory').level, 'idle');
  assert.equal(at(checks, 'sku').level, 'ok', 'the row-derived answer still stands');
});

test('the optimize row reads the FILE stamp, per model', () => {
  assert.equal(at(resolveFidelityChecks({ model: model(), report: report() }), 'optimized').level, 'ok');
  const stale = model({ mesh: { url: 'https://cdn/x.glb', upAxis: 'y', meshVersion: 0 } });
  assert.equal(at(resolveFidelityChecks({ model: stale, report: report() }), 'optimized').level, 'warn');
  const unread = model({ mesh: { url: 'https://cdn/x.glb', upAxis: 'y', meshVersion: null } });
  assert.equal(at(resolveFidelityChecks({ model: unread, report: report() }), 'optimized').level, 'idle');
  const raw = model({ mesh: { url: 'https://cdn/x.fbx', upAxis: 'y', meshVersion: null } });
  assert.equal(at(resolveFidelityChecks({ model: raw, report: report() }), 'optimized').level, 'warn');
});

test('a linked texture that arrived EMPTY is the silent failure this panel exists to name', () => {
  const linked = resolveFidelityChecks({
    model: model(), report: report({ fabricWithScan: true, fabricPixels: false }), fabricCode: 'A1234',
  });
  assert.equal(at(linked, 'fabric').level, 'bad');

  const real = resolveFidelityChecks({
    model: model(), report: report({ fabricWithScan: true, fabricPixels: true }), fabricCode: 'A1234',
  });
  assert.equal(at(real, 'fabric').level, 'ok');

  const unknown = resolveFidelityChecks({ model: model(), report: report(), fabricCode: 'A1234' });
  assert.equal(at(unknown, 'fabric').level, 'warn');

  const didntLoad = resolveFidelityChecks({ model: model(), report: report(), fabricCode: 'A1234', fabricLinked: true });
  assert.equal(at(didntLoad, 'fabric').level, 'bad');
});

test('structure: marked but unpainted warns; unmarked is simply silent', () => {
  const marked = model({ parts: { mats: { legs: 'structure' } } });
  assert.equal(at(resolveFidelityChecks({ model: marked, report: report() }), 'finish').level, 'warn');
  assert.equal(at(resolveFidelityChecks({ model: marked, report: report({ finishMaterials: 2 }) }), 'finish').level, 'ok');
  assert.equal(at(resolveFidelityChecks({ model: model(), report: report() }), 'finish').level, 'idle');
});

test('an unbound piece cannot be quoted, and part SKUs alone are not a base', () => {
  const none = model({ productRoot: null });
  assert.equal(at(resolveFidelityChecks({ model: none, report: report() }), 'sku').level, 'bad');
  const partsOnly = model({ productRoot: null, parts: { roots: { cushion: 'SET-2' } } });
  assert.equal(at(resolveFidelityChecks({ model: partsOnly, report: report() }), 'sku').level, 'warn');
});

test('the verdict is the worst row', () => {
  assert.equal(fidelityVerdict([{ key: 'a', label: 'A', level: 'ok', detail: '' }, { key: 'b', label: 'B', level: 'warn', detail: '' }]), 'warn');
  assert.equal(fidelityVerdict([{ key: 'a', label: 'A', level: 'ok', detail: '' }]), 'ok');
});
