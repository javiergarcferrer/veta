// Unit scaling — the two ratios every loader and every plan derivation share.
// `uniformHeightFit` (was togoMeshFit) normalises HEIGHT without distorting the
// footprint; `autoUnitScale` corrects ONLY a gross mm/cm/m export, keyed off the
// LARGEST extent. Drift here renders a 4 m phantom cushion or a rectangular
// square corner.
import test from 'node:test';
import assert from 'node:assert/strict';

import { autoUnitScale, uniformHeightFit, FURNITURE_SPAN_CM, DEFAULT_FIT_HEIGHT_CM } from '../src/index.ts';

test('uniformHeightFit normalises HEIGHT with a UNIFORM scale and never distorts the footprint', () => {
  // ONE scalar to the target height (72/144 = 0.5), applied to every axis — so a
  // SQUARE-footprint corner stays square. This is the corner-turns-rectangular
  // fix: there is no per-axis term that could squash X≠Z.
  let f = uniformHeightFit({ x: 102, y: 144, z: 102 }, 72);
  assert.ok(Math.abs(f.s - 0.5) < 1e-9);

  // A rectangular mesh keeps its TRUE footprint aspect (same scalar on x and z) —
  // we don't force it into the catalogue width×depth.
  f = uniformHeightFit({ x: 200, y: 72, z: 100 }, 72);
  assert.ok(Math.abs(f.s - 1) < 1e-9, 'height already 72 → scale 1, footprint left at its true 200×100');

  // It's a ratio → absorbs export units (metres here): 0.72 m tall → ×100.
  f = uniformHeightFit({ x: 1.02, y: 0.72, z: 1.02 }, 72);
  assert.ok(Math.abs(f.s - 100) < 1e-6);

  // Degenerate height → finite, never NaN/Infinity.
  assert.ok(Number.isFinite(uniformHeightFit({ x: 50, y: 0, z: 50 }, 72).s));
  assert.ok(Number.isFinite(uniformHeightFit(null).s));

  // The default target height is the calibrated one, and it is what an omitted
  // argument uses.
  assert.equal(DEFAULT_FIT_HEIGHT_CM, 72);
  assert.equal(uniformHeightFit({ y: 144 }).s, uniformHeightFit({ y: 144 }, DEFAULT_FIT_HEIGHT_CM).s);
});

test('autoUnitScale corrects ONLY a gross mm/cm/m export, by a power of ten', () => {
  // Centimetre exports render 1:1 — the TRUE size is kept, NOT forced to exactly 72
  // (this is the difference from uniformHeightFit): a 70 cm piece stays 70, an 85 stays 85.
  assert.equal(autoUnitScale(72), 1);
  assert.equal(autoUnitScale(70), 1);
  assert.equal(autoUnitScale(85), 1);
  assert.equal(autoUnitScale(45), 1);
  // A gross unit mismatch is snapped by the nearest power of ten to real-world cm.
  assert.equal(autoUnitScale(700), 0.1);     // millimetres → ÷10
  assert.equal(autoUnitScale(7200), 0.01);   // tenths of a mm → ÷100
  assert.equal(autoUnitScale(0.72), 100);    // metres → ×100
  assert.equal(autoUnitScale(0.7), 100);
  // Keyed off the piece's LARGEST extent, NOT its height — so a SHORT piece (a
  // bolster/arm cushion ≈10 cm tall but ≈45 cm–1 m long) is measured by that span
  // and lands at real cm, never blown up a power of ten. Span in metres → ×100.
  assert.equal(autoUnitScale(0.44), 100);    // 44 cm arm cushion exported in metres
  assert.equal(autoUnitScale(44), 1);        // …the same piece exported in cm
  assert.equal(autoUnitScale(2.5), 100);     // a 2.5 m sofa in metres still ×100 (span ref, not 72)
  // It only EVER multiplies by a power of ten — never a fractional fudge that would
  // distort the modelled size.
  for (const h of [12, 60, 73, 130, 410, 950, 1.1, 0.5]) {
    const f = autoUnitScale(h);
    const log = Math.log10(f);
    assert.ok(Math.abs(log - Math.round(log)) < 1e-9, `power of ten, got ${f} for h=${h}`);
  }
  // Degenerate height → 1 (no scaling), never NaN/Infinity.
  assert.equal(autoUnitScale(0), 1);
  assert.equal(autoUnitScale(-5), 1);
  assert.ok(Number.isFinite(autoUnitScale(NaN)));
  assert.equal(autoUnitScale(null), 1);

  // The span reference is the exported constant, and it is what an omitted
  // argument uses.
  assert.equal(FURNITURE_SPAN_CM, 100);
  assert.equal(autoUnitScale(0.72), autoUnitScale(0.72, FURNITURE_SPAN_CM));
});
