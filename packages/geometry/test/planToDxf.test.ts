// Plan → DXF export. Pins (1) the SVG plan-symbol parser (M/L/Z + circles),
// (2) the place-piece transform — scale-to-footprint, centre, 90° rotate, EXACTLY
// like the on-screen tile, so the CAD file matches the configurator, and (3) a
// well-formed R12 DXF that any DWG tool opens: balanced SECTION/ENDSEC + EOF,
// AC1009, centimetre units, the layer table, and y-up (CAD) non-negative coords.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePathData, parsePlanSvg, placePiece, planToDxf, dxfLayers, DXF_LAYERS, DEFAULT_DXF_LAYER_PREFIX,
} from '../src/index.ts';

test('parsePathData splits M/L/Z subpaths and flags closure', () => {
  const subs = parsePathData('M0 0L10 0L10 10ZM20 20L30 25');
  assert.equal(subs.length, 2);
  assert.deepEqual(subs[0].pts, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.equal(subs[0].closed, true);
  assert.deepEqual(subs[1].pts, [{ x: 20, y: 20 }, { x: 30, y: 25 }]);
  assert.equal(subs[1].closed, false);
  // Handles negatives/decimals; tolerates junk input.
  assert.deepEqual(parsePathData('M-1.5 2.25L3 4')[0].pts, [{ x: -1.5, y: 2.25 }, { x: 3, y: 4 }]);
  assert.deepEqual(parsePathData(''), []);
  assert.deepEqual(parsePathData(null), []);
});

test('parsePlanSvg reads the viewBox, every path, and circles', () => {
  const svg = '<svg viewBox="0 0 102 102" stroke="currentColor">'
    + '<path d="M0 0L102 0"/><path d="M0 0L0 102"/><circle cx="50" cy="60" r="4"/></svg>';
  const { polys, circles, vbW, vbH } = parsePlanSvg(svg);
  assert.equal(vbW, 102);
  assert.equal(vbH, 102);
  assert.equal(polys.length, 2);
  assert.deepEqual(circles, [{ cx: 50, cy: 60, r: 4 }]);
  assert.deepEqual(parsePlanSvg(null), { polys: [], circles: [], vbW: 0, vbH: 0 });
});

test('placePiece centres + translates at rot 0 (viewBox top-left → footprint top-left)', () => {
  const local = { polys: [{ pts: [{ x: 0, y: 0 }, { x: 102, y: 102 }], closed: false }], circles: [], vbW: 102, vbH: 102 };
  const { polys } = placePiece(local, { x: 10, y: 20, rot: 0, widthCm: 102, depthCm: 102 });
  // The svg's (0,0) is the box top-left → lands at the footprint top-left (x,y).
  assert.deepEqual(polys[0].pts[0], { x: 10, y: 20 });
  assert.deepEqual(polys[0].pts[1], { x: 112, y: 122 });
});

test('placePiece rotates 90° exactly like the tile (no float dust) + swaps the footprint', () => {
  // A 174×102 settee rotated 90°: footprint becomes 102×174. The svg top-left
  // (0,0) maps to the footprint's top-RIGHT corner (x + footprintWidth, y).
  const local = { polys: [{ pts: [{ x: 0, y: 0 }], closed: false }], circles: [], vbW: 174, vbH: 102 };
  const { polys } = placePiece(local, { x: 0, y: 0, rot: 90, widthCm: 174, depthCm: 102 });
  assert.deepEqual(polys[0].pts[0], { x: 102, y: 0 });
});

test('placePiece rotates FREE angles about the AABB centre (the sandbox rotation)', () => {
  // A 102×102 square at 45°: its AABB is 102·√2 per side, and the svg's centre
  // point stays exactly at the AABB centre — pieces spin in place, never walk.
  const local = { polys: [{ pts: [{ x: 51, y: 51 }, { x: 0, y: 0 }], closed: false }], circles: [], vbW: 102, vbH: 102 };
  const ext = 102 * Math.SQRT2;
  const { polys, center } = placePiece(local, { x: 0, y: 0, rot: 45, widthCm: 102, depthCm: 102 });
  assert.ok(Math.abs(center.x - ext / 2) < 1e-9, 'centre x = AABB centre');
  assert.ok(Math.abs(center.y - ext / 2) < 1e-9, 'centre y = AABB centre');
  assert.ok(Math.abs(polys[0].pts[0].x - ext / 2) < 1e-9, 'the local centre maps to the pivot');
  // The local top-left corner becomes the rotated square's TOP vertex.
  assert.ok(Math.abs(polys[0].pts[1].x - ext / 2) < 1e-9);
  assert.ok(Math.abs(polys[0].pts[1].y - 0) < 1e-9);
});

test('placePiece falls back to the footprint rectangle when there is no outline', () => {
  const { polys } = placePiece({ polys: [], circles: [], vbW: 0, vbH: 0 }, { x: 5, y: 5, rot: 0, widthCm: 100, depthCm: 60 });
  assert.equal(polys.length, 1);
  assert.equal(polys[0].closed, true);
  assert.deepEqual(polys[0].pts, [{ x: 5, y: 5 }, { x: 105, y: 5 }, { x: 105, y: 65 }, { x: 5, y: 65 }]);
});

// DXF is rigid (code, value) line pairs — parse to that shape so assertions are
// line-ending-agnostic (the file ships CRLF, which AutoCAD prefers).
function dxfPairs(dxf: string): Array<[string, string]> {
  const lines = dxf.split(/\r?\n/);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
  return pairs;
}
const countPair = (pairs: Array<[string, string]>, code: string, val: string) =>
  pairs.filter(([c, v]) => c === code && v === val).length;

test('planToDxf emits a well-formed R12 drawing any DWG tool opens', () => {
  const dxf = planToDxf([
    { pieceId: 'a', x: 0, y: 0, rot: 0, widthCm: 102, depthCm: 102, label: 'Sillón', svg: '<svg viewBox="0 0 102 102"><path d="M0 0L102 0L102 102L0 102Z"/></svg>' },
    { pieceId: 'gb', x: 102, y: 0, rot: 0, widthCm: 174, depthCm: 102, label: 'Sofá', svg: '' },
  ], { label: 'Togo' });
  const pairs = dxfPairs(dxf);
  const valueAfter = (key: string) => { const i = pairs.findIndex(([c, v]) => c === '9' && v === key); return i >= 0 ? pairs[i + 1] : null; };

  // Header essentials: R12, centimetre + metric units.
  assert.deepEqual(valueAfter('$ACADVER'), ['1', 'AC1009']);
  assert.deepEqual(valueAfter('$INSUNITS'), ['70', '5']);
  assert.deepEqual(valueAfter('$MEASUREMENT'), ['70', '1']);
  assert.ok(dxf.includes(DXF_LAYERS.furniture.name));
  assert.ok(dxf.includes(DXF_LAYERS.text.name));

  // SECTION/ENDSEC + TABLE/ENDTAB are balanced and the file terminates with EOF.
  assert.equal(countPair(pairs, '0', 'SECTION'), 3); // HEADER, TABLES, ENTITIES
  assert.equal(countPair(pairs, '0', 'SECTION'), countPair(pairs, '0', 'ENDSEC'));
  assert.equal(countPair(pairs, '0', 'TABLE'), countPair(pairs, '0', 'ENDTAB'));
  assert.deepEqual(pairs[pairs.length - 1], ['0', 'EOF']);

  // The labels rode through as TEXT (code 1).
  assert.ok(pairs.some(([c, v]) => c === '1' && v === 'Sillón'));
  assert.ok(pairs.some(([c, v]) => c === '1' && v === 'Sofá'));

  // Every emitted point coordinate is finite and the plan sits at a non-negative,
  // y-up (CAD) origin — nothing above the top edge, nothing left of 0.
  const coords = pairs.filter(([c]) => ['10', '20', '11', '21'].includes(c)).map(([, v]) => Number(v));
  assert.ok(coords.length > 0);
  assert.ok(coords.every((n) => Number.isFinite(n) && n >= 0), 'all coords non-negative & finite');
});

test('planToDxf is empty-safe', () => {
  const pairs = dxfPairs(planToDxf([]));
  assert.deepEqual(pairs[pairs.length - 1], ['0', 'EOF']);
  assert.equal(countPair(pairs, '0', 'SECTION'), 3);
  // Null/undefined placements behave like an empty layout.
  assert.deepEqual(dxfPairs(planToDxf(null)).pop(), ['0', 'EOF']);
});

test('layer names carry the prefix — VETA by default, the caller\'s otherwise', () => {
  assert.equal(DEFAULT_DXF_LAYER_PREFIX, 'VETA');
  assert.deepEqual(DXF_LAYERS, {
    furniture: { name: 'VETA-MUEBLES', color: 7 },
    text: { name: 'VETA-TEXTO', color: 3 },
    frame: { name: 'VETA-CONJUNTO', color: 5 },
  });
  assert.deepEqual(dxfLayers('ACME'), {
    furniture: { name: 'ACME-MUEBLES', color: 7 },
    text: { name: 'ACME-TEXTO', color: 3 },
    frame: { name: 'ACME-CONJUNTO', color: 5 },
  });
  // A blank prefix falls back to the default rather than emitting a bare "-MUEBLES".
  assert.equal(dxfLayers('  ').furniture.name, 'VETA-MUEBLES');

  const placements = [{ pieceId: 'a', x: 0, y: 0, rot: 0, widthCm: 100, depthCm: 60, label: 'A' }];
  const custom = planToDxf(placements, { layerPrefix: 'ACME' });
  assert.ok(custom.includes('ACME-MUEBLES') && custom.includes('ACME-TEXTO') && custom.includes('ACME-CONJUNTO'));
  assert.ok(!custom.includes('VETA-'), 'the prefix replaces the default everywhere');
  assert.ok(planToDxf(placements).includes('VETA-MUEBLES'));
});

test('the layer prefix changes ONLY the layer names — the DXF geometry is byte-identical', () => {
  const placements = [
    { pieceId: 'a', x: 0, y: 0, rot: 33.3, widthCm: 102, depthCm: 102, label: 'Sillón', svg: '<svg viewBox="0 0 102 102"><path d="M0 0L102 0L102 102L0 102Z"/><circle cx="50" cy="60" r="4"/></svg>' },
    { pieceId: 'b', x: 140, y: 20, rot: 90, widthCm: 174, depthCm: 102, label: 'Sofá' },
  ];
  const a = planToDxf(placements, { label: 'Conjunto' });
  const b = planToDxf(placements, { label: 'Conjunto', layerPrefix: 'ACME' });
  assert.equal(a.split('VETA-').join('X-'), b.split('ACME-').join('X-'));
});
