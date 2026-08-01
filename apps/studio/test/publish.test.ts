// PUBLISH — the gate. A published model is a promise to a visitor, so the four
// blocking checks are the four ways that promise breaks: no mesh (a generic
// shape), no plan (nothing to draw in 2D), no size (placed at the wrong scale),
// no SKU (cannot price). Everything else warns and ships.
import test from 'node:test';
import assert from 'node:assert/strict';

import { blockingChecks, canPublish, resolvePublishChecks, resolvePublishSummary, setPublishState } from '../src/vm/publish.ts';
import { emptyModel } from '../src/vm/types.ts';
import type { StudioModel } from '../src/vm/types.ts';

const complete = (id = 'm'): StudioModel => ({
  ...emptyModel(id, 'Prado 2 seat', 1000),
  collection: 'Prado',
  mesh: { url: 'https://cdn/x.glb', upAxis: 'y', meshVersion: 4 },
  plan: { svg: '<svg/>', widthCm: 190, depthCm: 95 },
  productRoot: '10574010',
});

test('a complete model publishes; each missing piece is named', () => {
  assert.equal(canPublish(complete()), true);
  assert.deepEqual(blockingChecks({ ...complete(), mesh: null }).map((c) => c.key), ['mesh']);
  assert.deepEqual(blockingChecks({ ...complete(), plan: null }).map((c) => c.key), ['plan', 'dims']);
  assert.deepEqual(blockingChecks({ ...complete(), productRoot: null }).map((c) => c.key), ['sku']);
  assert.deepEqual(
    blockingChecks({ ...complete(), plan: { svg: '<svg/>', widthCm: 0, depthCm: 0 } }).map((c) => c.key),
    ['dims'],
  );
});

test('a structure role with no palette WARNS — it ships, and it is said out loud', () => {
  const model: StudioModel = { ...complete(), parts: { mats: { legs: 'structure' } } };
  const checks = resolvePublishChecks(model);
  const structure = checks.find((c) => c.key === 'structure');
  assert.ok(structure, 'the silent failure is named');
  assert.equal(structure!.level, 'warn');
  assert.equal(canPublish(model), true, 'a warning never blocks');
});

test('publishing is refused with its reasons, and the model is untouched', () => {
  const model = { ...complete(), productRoot: null };
  const out = setPublishState(model, 'published', 2000);
  assert.equal(out.changed, false);
  assert.equal(out.model, model);
  assert.deepEqual(out.blocked.map((c) => c.key), ['sku']);
});

test('publishing stamps the debut ONCE; un-publishing never erases it', () => {
  const published = setPublishState(complete(), 'published', 2000).model;
  assert.equal(published.status, 'published');
  assert.equal(published.publishedAt, 2000);

  const back = setPublishState(published, 'draft', 3000);
  assert.equal(back.model.status, 'draft');
  assert.equal(back.model.publishedAt, 2000, 'when it was first shown is history');

  const again = setPublishState(back.model, 'published', 4000);
  assert.equal(again.model.publishedAt, 2000, 'a re-publish is not a new debut');
});

test('un-publishing is never gated — refusing it would be refusing the fix', () => {
  const broken: StudioModel = { ...complete(), status: 'published', publishedAt: 1, mesh: null };
  const out = setPublishState(broken, 'draft', 5000);
  assert.equal(out.changed, true);
  assert.equal(out.model.status, 'draft');
});

test('the summary counts what is shippable, and why the rest is not', () => {
  const summary = resolvePublishSummary([
    { ...complete('a'), status: 'published' },
    complete('b'),
    { ...complete('c'), mesh: null },
    { ...complete('d'), mesh: null, productRoot: null },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.published, 1);
  assert.equal(summary.ready, 1);
  assert.deepEqual(summary.blockedByCheck, { mesh: 2, sku: 1 });
});
