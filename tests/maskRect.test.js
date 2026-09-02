import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { maskRectFor, MASK_MAX, MASK_CELL, MASK_PAD } from '../src/lib/configurator/maskRect.js';

const CW = 1400, CH = 900;

/** The stage's camera (ConfiguratorStage: fov 33, near 1, far 20000), posed. */
function camera(eye, target) {
  const cam = new THREE.PerspectiveCamera(33, CW / CH, 1, 20000);
  cam.position.set(...eye);
  cam.lookAt(new THREE.Vector3(...target));
  cam.updateMatrixWorld(true);          // also refreshes matrixWorldInverse, as a render does
  cam.updateProjectionMatrix();
  return cam;
}

// A sofa-sized AABB in plan cm, resting on the floor, centred on the origin.
const SOFA = new THREE.Box3(new THREE.Vector3(-100, 0, -45), new THREE.Vector3(100, 80, 45));

const right = (r) => r.rx + r.gw * r.cell;
const bottom = (r) => r.ry + r.gh * r.cell;

test('a piece wholly on screen keeps the finest lattice, hugging its projection', () => {
  const r = maskRectFor(SOFA, camera([0, 120, 600], [0, 40, 0]), CW, CH);
  assert.ok(r);
  assert.equal(r.cell, MASK_CELL);
  assert.ok(r.rx > 0 && r.ry > 0 && right(r) < CW && bottom(r) < CH, 'rect sits inside the viewport');
  assert.ok(r.gw <= MASK_MAX && r.gh <= MASK_MAX);
  assert.equal(r.rx % r.cell, 0); assert.equal(r.ry % r.cell, 0);   // lattice-snapped
});

test('a corner a hand from the eye no longer coarsens the cell: the bound clips to the viewport', () => {
  // Eye 3 cm off the front face, beside the arm — every corner still in FRONT of
  // the near plane, but the near ones project thousands of px off-screen.
  const r = maskRectFor(SOFA, camera([70, 40, 48], [70, 40, 0]), CW, CH);
  assert.ok(r);
  assert.ok(r.cell < 4, `cell ${r.cell} — stays near the viewport-bounded ~3 px, not tens`);
  // The 3-cell margin, floored to the lattice: at most 4 cells past the pad.
  assert.ok(r.rx >= -MASK_PAD - 4 * r.cell && r.ry >= -MASK_PAD - 4 * r.cell, 'starts just past the viewport');
  assert.ok(right(r) <= CW + MASK_PAD + 4 * r.cell && bottom(r) <= CH + MASK_PAD + 4 * r.cell, 'ends just past it');
  assert.ok(r.rx <= 0 && r.ry <= 0 && right(r) >= CW && bottom(r) >= CH, 'covers the whole viewport');
});

test('the camera dollied INTO the piece (corners behind the eye) masks the whole viewport', () => {
  // Eye inside the AABB looking along the seat: the corners behind it would
  // project mirrored, boxing a sliver — the bound must be the viewport.
  const r = maskRectFor(SOFA, camera([0, 40, 0], [100, 40, 0]), CW, CH);
  assert.ok(r);
  assert.ok(r.rx <= 0 && r.ry <= 0 && right(r) >= CW && bottom(r) >= CH, 'covers the whole viewport');
  assert.ok(r.cell < 4);
});

test('a piece wholly behind the camera is not in view', () => {
  assert.equal(maskRectFor(SOFA, camera([0, 40, -300], [0, 40, -1000]), CW, CH), null);
});

test('a piece wholly off to one side of the frame is not in view', () => {
  // Ahead of the camera (every corner in front of the near plane) but 20 m to
  // its left: its bound lies wholly outside the viewport, so there is no rect.
  assert.equal(maskRectFor(SOFA, camera([2000, 40, 500], [2000, 40, -1000]), CW, CH), null);
});

test('degenerate input yields null, never a rect', () => {
  const cam = camera([0, 120, 600], [0, 40, 0]);
  assert.equal(maskRectFor(new THREE.Box3(), cam, CW, CH), null);
  assert.equal(maskRectFor(SOFA, cam, 0, CH), null);
  assert.equal(maskRectFor(null, cam, CW, CH), null);
});
