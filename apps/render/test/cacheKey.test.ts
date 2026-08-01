// The idempotence seam. If any of these go red, the LRU (and any CDN in front
// of it) is either missing hits it should get or serving an image for a job it
// was never asked for — both are worse than having no cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RENDER_ENGINE_VERSION, cacheKeyOf, cacheKeyOfRaw } from '../src/cacheKey.ts';
import { sanitizeJob } from '../src/jobs.ts';

const base = {
  build: [{ pieceId: 'sofa-a', x: 0, y: 0, rot: 0, fabricCode: 'TONA-12' }],
  models: { 'sofa-a': { widthCm: 120, depthCm: 90, collection: 'togo' } },
  materials: { 'TONA-12': { rgb: '#b68a76' } },
  angle: 'hero',
  size: { width: 640, height: 480 },
};

test('a key is a sha256 hex digest', () => {
  const key = cacheKeyOfRaw(base);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('the same job keys the same, whatever order its keys arrive in', () => {
  const shuffled = {
    size: { height: 480, width: 640 },
    angle: 'hero',
    materials: { 'TONA-12': { rgb: '#b68a76' } },
    models: { 'sofa-a': { collection: 'togo', depthCm: 90, widthCm: 120 } },
    build: [{ rot: 0, y: 0, x: 0, fabricCode: 'TONA-12', pieceId: 'sofa-a' }],
  };
  assert.equal(cacheKeyOfRaw(base), cacheKeyOfRaw(shuffled));
});

test('junk the sanitizer drops cannot split the cache', () => {
  // Two callers describing the SAME image, one of them sloppily.
  const sloppy = { ...base, nonsense: 'ignored', build: [...base.build, { x: 1 }] };
  assert.equal(cacheKeyOfRaw(base), cacheKeyOfRaw(sloppy));
});

test('anything that changes the picture changes the key', () => {
  const key = cacheKeyOfRaw(base);
  const variants: Record<string, unknown> = {
    angle: { ...base, angle: 'plan' },
    size: { ...base, size: { width: 641, height: 480 } },
    format: { ...base, format: 'jpeg' },
    fabric: { ...base, build: [{ ...base.build[0], fabricCode: 'TONA-13' }] },
    position: { ...base, build: [{ ...base.build[0], x: 1 }] },
    rotation: { ...base, build: [{ ...base.build[0], rot: 90 }] },
    colour: { ...base, materials: { 'TONA-12': { rgb: '#000000' } } },
    footprint: { ...base, models: { 'sofa-a': { widthCm: 121, depthCm: 90, collection: 'togo' } } },
    background: { ...base, background: '#ffffff' },
    transparent: { ...base, transparent: true },
    pose: { ...base, poseOverride: { azimuthDeg: 12 } },
    params: { ...base, renderParams: { seamBleed: 1.1 } },
  };
  for (const [label, variant] of Object.entries(variants)) {
    assert.notEqual(cacheKeyOfRaw(variant as Record<string, unknown>), key, `${label} did not move the key`);
  }
});

test('two placements in a different ORDER are a different image', () => {
  // Not a canonicalization bug: z-order and the recentring both read the array,
  // so collapsing the two would serve one arrangement for the other.
  const a = { ...base, build: [{ pieceId: 'a', x: 0, y: 0, rot: 0 }, { pieceId: 'b', x: 90, y: 0, rot: 0 }] };
  const b = { ...base, build: [{ pieceId: 'b', x: 90, y: 0, rot: 0 }, { pieceId: 'a', x: 0, y: 0, rot: 0 }] };
  assert.notEqual(cacheKeyOfRaw(a), cacheKeyOfRaw(b));
});

test('the engine version is part of the identity', () => {
  const { job } = sanitizeJob(base);
  assert.notEqual(cacheKeyOf(job, RENDER_ENGINE_VERSION), cacheKeyOf(job, RENDER_ENGINE_VERSION + 1));
});

test('keying is stable across calls (no clock, no counter, no Math.random)', () => {
  const { job } = sanitizeJob(base);
  const keys = new Set([cacheKeyOf(job), cacheKeyOf(job), cacheKeyOf(sanitizeJob(base).job)]);
  assert.equal(keys.size, 1);
});
