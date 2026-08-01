// The PROCEDURAL TOGO fallback — pins the PURE geometry (no three.js): pieces
// are sized to their real footprints, sit on the floor, stay inside their
// footprint AABB, and the form/kind inference reads the label first and the
// measured footprint second.
//
// Ported from RosetSoft `tests/togo3d.test.js`. Its `autoUnitScale` /
// `togoMeshFit` cases moved with those functions to @veta/geometry, and its
// `resolveTogoScene` / `compactPlaced` cases to @veta/layout.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOGO_HEIGHT_CM, inferForm, inferKind, proceduralTogoParts,
} from '../src/index.ts';
import type { TogoPart } from '../src/index.ts';

test('inferForm reads arms from the label, then the footprint shape', () => {
  assert.equal(inferForm('Chofesa Togo').armCount, 0);        // fireside / no arms
  assert.equal(inferForm('Togo chauffeuse').armCount, 0);
  assert.equal(inferForm('Meridiana Togo').armCount, 1);      // chaise → one arm
  assert.equal(inferForm('Sofá Togo').armCount, 2);           // settee → two arms
  assert.equal(inferForm('Sillón Togo').armCount, 2);
  // A deep, narrow footprint reads as a chaise even with a neutral label.
  assert.equal(inferForm('Pieza', 100, 160).armCount, 1);
  assert.equal(inferForm('Pieza', 174, 102).armCount, 2);
});

// AABB half-extents per part shape (box: w/h/d; ridge capsule: length along its
// axis + radius caps, radius on the other two axes).
function aabb(p: TogoPart) {
  if (p.shape === 'ridge') {
    const ex = p.axis === 'x' ? p.length / 2 + p.radius : p.radius;
    const ez = p.axis === 'z' ? p.length / 2 + p.radius : p.radius;
    return { x0: p.x - ex, x1: p.x + ex, y0: p.y - p.radius, y1: p.y + p.radius, z0: p.z - ez, z1: p.z + ez };
  }
  return { x0: p.x - p.w / 2, x1: p.x + p.w / 2, y0: p.y - p.h / 2, y1: p.y + p.h / 2, z0: p.z - p.d / 2, z1: p.z + p.d / 2 };
}

test('proceduralTogoParts builds a floor-standing, channeled piece within its footprint', () => {
  const W = 174, D = 102;
  const parts = proceduralTogoParts(W, D, { armCount: 2 });
  const cores = parts.filter((p) => p.shape === 'box');
  assert.equal(cores.filter((p) => p.role === 'seat').length, 1);
  assert.equal(cores.filter((p) => p.role === 'arm').length, 2);
  assert.ok(parts.some((p) => p.shape === 'ridge'), 'has the channel ridges');

  let maxY = 0;
  for (const p of parts) {
    const b = aabb(p);
    maxY = Math.max(maxY, b.y1);
    assert.ok(b.y0 >= -0.5, `${p.role} dips below the floor`);
  }
  assert.ok(Math.abs(maxY - TOGO_HEIGHT_CM) <= 8, 'reaches ~the Togo height');

  // The CORE mass stays inside the footprint tile (ridges may plush-overhang).
  const inFootprint = (list: TogoPart[], w: number, d: number) => list.filter((p) => p.shape === 'box').forEach((p) => {
    const b = aabb(p);
    assert.ok(b.x0 >= -w / 2 - 0.5 && b.x1 <= w / 2 + 0.5, `${p.role} core exceeds width`);
    assert.ok(b.z0 >= -d / 2 - 0.5 && b.z1 <= d / 2 + 0.5, `${p.role} core exceeds depth`);
  });
  inFootprint(parts, W, D);

  // Armless (chauffeuse) drops the arms; chaise keeps one and still fits (the
  // single-arm backrest tuck-behind once overflowed the armed side).
  assert.equal(proceduralTogoParts(87, 102, { armCount: 0 }).filter((p) => p.role === 'arm' && p.shape === 'box').length, 0);
  const chaise = proceduralTogoParts(131, 162, { armCount: 1 });
  assert.equal(chaise.filter((p) => p.role === 'arm' && p.shape === 'box').length, 1);
  inFootprint(chaise, 131, 162);
});

test('inferKind maps to a canonical piece (label, then footprint), for model lookup', () => {
  assert.equal(inferKind('Chofesa Togo'), 'chauf');
  assert.equal(inferKind('Sofá grande Togo'), 'mc');
  assert.equal(inferKind('Meridiana Togo'), 'lounge');
  // No keyword → nearest measured footprint (174×102 == the settee gb).
  assert.equal(inferKind('Pieza', 174, 102), 'gb');
  assert.equal(inferKind('', 0, 0), null);
});

test('inferKind takes its table as a PARAMETER — the collection is no longer baked in', () => {
  const kinds = [
    { id: 'small', widthCm: 80, depthCm: 80, match: ['pequeno'] },
    { id: 'big', widthCm: 300, depthCm: 120, match: ['grande'] },
  ];
  assert.equal(inferKind('Modulo grande', 0, 0, kinds), 'big');
  assert.equal(inferKind('Sin palabra clave', 90, 85, kinds), 'small');
  // And the default table is untouched by the override.
  assert.equal(inferKind('Chofesa Togo'), 'chauf');
});
