// Plan preview — the screen-space (y-down) composition. Its placement transform
// MIRRORS planToDxf.placePiece, so the preview, the DXF and the on-screen
// configurator can never disagree; that mirror is what this pins, plus the
// defensive scrub of the embedded markup.
import test from 'node:test';
import assert from 'node:assert/strict';

import { composePlanPreview, planPlacements, placedPieceGeom, viewBoxOf, placePiece, parsePlanSvg } from '../src/index.ts';

const SOFA = { name: 'Sofá', widthCm: 174, depthCm: 102, svg: '<svg viewBox="0 0 174 102" stroke-width="0.5"><path d="M0 0L174 0L174 102L0 102Z"/></svg>' };

test('viewBoxOf reads the plan svg viewBox, 0/0 when absent', () => {
  assert.deepEqual(viewBoxOf(SOFA.svg), { vbW: 174, vbH: 102 });
  assert.deepEqual(viewBoxOf('<svg/>'), { vbW: 0, vbH: 0 });
  assert.deepEqual(viewBoxOf(null), { vbW: 0, vbH: 0 });
});

test('placedPieceGeom mirrors placePiece: same footprint AABB and same centre', () => {
  for (const rot of [0, 90, 45, 33.3, 270]) {
    const item = { modelId: 'a', x: 40, y: 25, rot };
    const geom = placedPieceGeom(SOFA, item);
    const placed = placePiece(parsePlanSvg(SOFA.svg), {
      x: item.x, y: item.y, rot, widthCm: SOFA.widthCm, depthCm: SOFA.depthCm,
    });
    assert.ok(Math.abs(geom.cx - placed.center.x) < 1e-9, `centre x at ${rot}°`);
    assert.ok(Math.abs(geom.cy - placed.center.y) < 1e-9, `centre y at ${rot}°`);
  }
  // Cardinal angles snap the trig, so a square layout stays crisp.
  const g = placedPieceGeom(SOFA, { modelId: 'a', x: 0, y: 0, rot: 90 });
  assert.equal(g.fpW, 102);
  assert.equal(g.fpH, 174);
});

test('planPlacements builds exactly what planToDxf consumes; a missing model keeps its position', () => {
  const rows = planPlacements({ a: SOFA }, [
    { modelId: 'a', x: 10, y: 20, rot: 90 },
    { modelId: 'ghost', x: 5, y: 5, rot: 0 },
    { modelId: null, x: 1, y: 1 },
  ]);
  assert.equal(rows.length, 2, 'an item with no modelId is dropped');
  assert.deepEqual(rows[0], { pieceId: 'a', x: 10, y: 20, rot: 90, widthCm: 174, depthCm: 102, label: 'Sofá', svg: SOFA.svg });
  assert.deepEqual(rows[1], { pieceId: 'ghost', x: 5, y: 5, rot: 0, widthCm: 0, depthCm: 0, label: '', svg: '' });
  assert.deepEqual(planPlacements(null, null), []);
});

test('composePlanPreview emits a standalone monochrome svg sized by its viewBox', () => {
  const out = composePlanPreview({ a: SOFA }, [{ modelId: 'a', x: 0, y: 0, rot: 0 }], { margin: 10 })!;
  assert.equal(out.pieceCount, 1);
  assert.equal(out.width, 194);   // 174 + 2×10
  assert.equal(out.height, 122);  // 102 + 2×10
  assert.deepEqual(out.viewBox, { x: -10, y: -10, w: 194, h: 122 });
  assert.match(out.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="-10 -10 194 122"/);
  assert.ok(out.svg.includes('<g transform="translate(87 51) rotate(0) scale(1 1) translate(-87 -51)">'));
  // ONE uniform hairline on the root; the per-shape sizing is stripped.
  assert.ok(!/<path[^>]*stroke-width/.test(out.svg), 'per-shape stroke-width scrubbed');
});

test('composePlanPreview scrubs script/handlers and falls back to the footprint box', () => {
  const nasty = { name: 'X', widthCm: 50, depthCm: 50, svg: '<svg viewBox="0 0 50 50"><script>alert(1)</script><path d="M0 0L50 0" onclick="x()"/></svg>' };
  const out = composePlanPreview({ x: nasty }, [{ modelId: 'x', x: 0, y: 0, rot: 0 }])!;
  assert.ok(!out.svg.includes('<script'));
  assert.ok(!out.svg.includes('onclick'));

  // A model with no outline still draws: its footprint rectangle, in place.
  const bare = composePlanPreview({ b: { name: 'B', widthCm: 80, depthCm: 40 } }, [{ modelId: 'b', x: 0, y: 0, rot: 0 }])!;
  assert.ok(bare.svg.includes('<rect x="-40" y="-20" width="80" height="40"/>'));

  // Nothing placeable → null, never a half-built svg.
  assert.equal(composePlanPreview({ a: SOFA }, []), null);
  assert.equal(composePlanPreview({ a: SOFA }, [{ modelId: 'missing', x: 0, y: 0 }]), null);
  assert.equal(composePlanPreview(null, null), null);
});
