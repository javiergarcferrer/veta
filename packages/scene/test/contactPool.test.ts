/**
 * THE CONTACT POOL — the product-photo grounding, pinned as DATA.
 *
 * Ported from the reference's quality tier (RosetSoft 4a02bad), where the pool
 * was verified with a luminance strip across the harness sofa's front edge: deep
 * at the contact, feathering smoothly back to the bare ground over roughly a
 * feather's width. A screenshot can't be a regression test, so the SHAPE of that
 * falloff is pinned here over the pure model the canvas passes execute — no GL,
 * no DOM, no canvas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POOL_PASSES, POOL_PX, POOL_SPAN_FACTOR, poolLuminance, poolProject, poolShade, poolSpan,
} from '../src/contactPool.ts';
import type { PoolRect } from '../src/contactPool.ts';

// The harness: one settee, 200 × 100 cm, on a 320-radius stage holding a
// 170-radius layout — the same rig the reference measured on.
const SOFA: PoolRect[] = [{ x: 0, z: 0, w: 200, d: 100, deg: 0 }];
const VIEW = { cx: 0, cz: 0, span: poolSpan(320, 170), px: POOL_PX };
const GROUND = 244;   // the reference strip's own ground level

test('three passes, and every one of them but the contact line reaches OUTWARD', () => {
  assert.equal(POOL_PASSES.length, 3);
  const [ambient, mid, contact] = POOL_PASSES;
  // A flush-floor piece hides everything INSIDE its footprint under itself, so
  // an inset "core" pass is invisible by construction — the reason the table is
  // outward-first and only the contact line tucks in.
  assert.ok(ambient.insetCm < 0 && mid.insetCm < 0, 'the feather and the pool grow past the piece');
  assert.ok(contact.insetCm > 0, 'the contact line sits just inside the base edge');
  assert.ok(ambient.insetCm < mid.insetCm && mid.insetCm < contact.insetCm, 'ordered outermost first');
  // …and it TIGHTENS and DARKENS inward: the wide feather is the faintest.
  assert.ok(ambient.blur > mid.blur && mid.blur > contact.blur, 'each pass blurs less than the last');
  assert.ok(contact.alpha > ambient.alpha, 'the contact line is the darkest');
});

test('the plate spans the LAYOUT, never less than the stage radius', () => {
  assert.equal(poolSpan(320, 170), 320 * POOL_SPAN_FACTOR, 'a small layout still gets the stage plate');
  assert.equal(poolSpan(320, 900), 900 * POOL_SPAN_FACTOR, 'a big one grows with it — room for the feather');
  assert.equal(poolSpan(320, null), 320 * POOL_SPAN_FACTOR);
});

test('world → plate: +z maps to canvas −y and the yaw sign flips with it', () => {
  const centre = poolProject({ x: 0, z: 0, w: 200, d: 100 }, VIEW);
  assert.equal(centre.cx, POOL_PX / 2);
  assert.equal(centre.cy, POOL_PX / 2);
  // A DataTexture has no flipY (rows are v=0 first), so this sign is the whole
  // difference between a shadow under the piece and a mirrored one.
  const far = poolProject({ x: 0, z: 100, w: 200, d: 100 }, VIEW);
  assert.ok(far.cy < POOL_PX / 2, 'world +z goes UP the canvas');
  const right = poolProject({ x: 100, z: 0, w: 200, d: 100 }, VIEW);
  assert.ok(right.cx > POOL_PX / 2, 'world +x goes right, unflipped');
  assert.ok(poolProject({ x: 0, z: 0, w: 200, d: 100, deg: 90 }, VIEW).rot < 0, 'a clockwise plan yaw is negative on the plate');
  // The inset is applied to the SIZE in cm before the scale — outward grows it.
  const s = POOL_PX / VIEW.span;
  assert.ok(Math.abs(poolProject(SOFA[0], VIEW, -36).w - (200 + 36) * s) < 1e-9);
  // A degenerate footprint still draws: a pool that vanishes is worse than a
  // small one, and a piece with no measured size still sits on a floor.
  assert.equal(poolProject({ x: 0, z: 0, w: 0, d: 0 }, VIEW).w, 2);
});

test('THE FALLOFF: deep at the contact, smoothly back to bare ground', () => {
  const at = (z: number) => poolLuminance(GROUND, SOFA, { x: 0, z }, VIEW);
  const edge = at(50);                       // the sofa's own front edge
  // The reference strip: dark at the contact against a 244 ground, recovering
  // over ~a feather's width. Pinned as a BAND — the exact byte is the canvas
  // rasterizer's, the shape is the rule.
  assert.ok(edge < GROUND * 0.65, `the contact reads dark (got ${edge.toFixed(0)} of ${GROUND})`);
  assert.ok(edge > GROUND * 0.25, 'and never a black stamp');
  assert.ok(at(150) > GROUND * 0.98, 'a feather out, the ground is back');
  assert.ok(Math.abs(at(400) - GROUND) < 1e-6, 'well clear of the piece there is no pool at all');
  // MONOTONE outward — a pool with a bright ring in it reads as a rendering bug.
  let prev = -Infinity;
  for (let z = 50; z <= 300; z += 5) {
    const v = at(z);
    assert.ok(v >= prev - 1e-9, `luminance must never dip going out (z=${z})`);
    prev = v;
  }
});

test('the pool follows the piece — offset, rotation, and no black hole where two overlap', () => {
  const moved: PoolRect[] = [{ x: 300, z: -200, w: 200, d: 100, deg: 0 }];
  const movedView = { ...VIEW, cx: 300, cz: -200 };
  assert.ok(
    Math.abs(poolShade(moved, { x: 300, z: -150 }, movedView) - poolShade(SOFA, { x: 0, z: 50 }, VIEW)) < 1e-9,
    'the same edge, translated, shades identically',
  );
  // A 90° yaw swaps the footprint's own axes: the pool turns with the piece.
  const turned: PoolRect[] = [{ x: 0, z: 0, w: 200, d: 100, deg: 90 }];
  assert.ok(
    Math.abs(poolShade(turned, { x: 50, z: 0 }, VIEW) - poolShade(SOFA, { x: 0, z: 50 }, VIEW)) < 1e-9,
    'a quarter turn maps the front edge onto the side',
  );
  // Two overlapping footprints are as dark as the darker one — never their sum,
  // which would burn a hole where a sectional's modules meet.
  const pair: PoolRect[] = [SOFA[0], { x: 40, z: 0, w: 200, d: 100, deg: 0 }];
  assert.ok(poolShade(pair, { x: 20, z: 0 }, VIEW) <= poolShade(SOFA, { x: 0, z: 0 }, VIEW) + 1e-9);
});

test('no pieces ⇒ no pool: the plate is exactly the ground colour', () => {
  assert.equal(poolShade([], { x: 0, z: 0 }, VIEW), 0);
  assert.equal(poolShade(null, { x: 0, z: 0 }, VIEW), 0);
  assert.equal(poolLuminance(GROUND, undefined, { x: 0, z: 0 }, VIEW), GROUND);
});
