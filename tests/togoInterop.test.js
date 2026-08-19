/**
 * Tests for lib/togo/interopMesh — the INTEROP contract of every 3D file that
 * leaves the app (the «3D» download: Twinmotion / Blender / SketchUp / OS
 * viewers).
 *
 * Why this is pinned: the catalog's streaming GLBs are quantized
 * (KHR_mesh_quantization — a *required* glTF extension), and re-exporting them
 * verbatim produced files a strict importer is FORBIDDEN from loading.
 * Twinmotion ran its whole import flow and showed an empty scene (measured
 * 2026-08, dealer report). Two invariants keep that from recurring:
 *   1. the decode back to plain float32 is exact (glTF/GL snorm/unorm rules);
 *   2. the exporter refuses to ship any GLB whose own header still carries a
 *      required extension — pinned here as a source scan of togoGlbExport.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dequantizedFloats, glbRequiredExtensions } from '../src/lib/togo/interopMesh.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── dequantizedFloats — the one decode ──────────────────────────────────────

test('dequantizedFloats — snorm int16/int8 decode (glTF rule: max(q/M, -1))', () => {
  const i16 = dequantizedFloats(new Int16Array([32767, -32767, -32768, 0, 16384]), true);
  assert.ok(i16 instanceof Float32Array);
  assert.equal(i16[0], 1);
  assert.equal(i16[1], -1);
  assert.equal(i16[2], -1); // -32768 clamps — -M and -M-1 both mean -1
  assert.equal(i16[3], 0);
  assert.ok(Math.abs(i16[4] - 16384 / 32767) < 1e-6);

  const i8 = dequantizedFloats(new Int8Array([127, -127, -128, 64]), true);
  assert.equal(i8[0], 1);
  assert.equal(i8[1], -1);
  assert.equal(i8[2], -1);
  assert.ok(Math.abs(i8[3] - 64 / 127) < 1e-6);
});

test('dequantizedFloats — unorm uint8/uint16 decode', () => {
  const u8 = dequantizedFloats(new Uint8Array([255, 0, 128]), true);
  assert.equal(u8[0], 1);
  assert.equal(u8[1], 0);
  assert.ok(Math.abs(u8[2] - 128 / 255) < 1e-6);
  const u16 = dequantizedFloats(new Uint16Array([65535, 32768]), true);
  assert.equal(u16[0], 1);
  assert.ok(Math.abs(u16[1] - 32768 / 65535) < 1e-6);
});

test('dequantizedFloats — floats pass through, plain ints convert numerically', () => {
  const f = dequantizedFloats(new Float32Array([1.5, -0.25]), false);
  assert.deepEqual([...f], [1.5, -0.25]);
  const f64 = dequantizedFloats(new Float64Array([0.5]), true); // normalized flag irrelevant for floats
  assert.equal(f64[0], 0.5);
  const plain = dequantizedFloats(new Int16Array([120, -7]), false); // NOT normalized
  assert.deepEqual([...plain], [120, -7]);
});

test('dequantizedFloats — an unknown array kind throws (never a silent identity)', () => {
  assert.throws(() => dequantizedFloats([1, 2, 3], true));
});

// ── glbRequiredExtensions — reading the finished file's own header ──────────

/** A minimal valid GLB around the given JSON (chunk padded to 4 with spaces). */
function glbWith(json) {
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (enc.length % 4)) % 4;
  const jsonLen = enc.length + pad;
  const buf = new ArrayBuffer(20 + jsonLen);
  const view = new DataView(buf);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, buf.byteLength, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  const bytes = new Uint8Array(buf);
  bytes.set(enc, 20);
  bytes.fill(0x20, 20 + enc.length); // spec-sanctioned space padding
  return buf;
}

test('glbRequiredExtensions — reads extensionsRequired; absent list is []', () => {
  const quantized = glbWith({
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_mesh_quantization', 'KHR_materials_sheen'],
    extensionsRequired: ['KHR_mesh_quantization'],
  });
  assert.deepEqual(glbRequiredExtensions(quantized), ['KHR_mesh_quantization']);
  // Optional-only extensions (sheen) never appear — they don't block importers.
  const clean = glbWith({ asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_sheen'] });
  assert.deepEqual(glbRequiredExtensions(clean), []);
});

test('glbRequiredExtensions — refuses non-GLB buffers', () => {
  assert.throws(() => glbRequiredExtensions(new TextEncoder().encode('{"json":true}').buffer));
  assert.throws(() => glbRequiredExtensions(new ArrayBuffer(4)));
});

// ── The exporter's side of the contract (source pins — the export itself runs
//    on WebGL/browser three, so the wiring is pinned the whatsappOptout way) ──

test('togoGlbExport — exportGlbBlob dequantizes and refuses non-interop output', () => {
  const src = readFileSync(join(ROOT, 'src/components/togo/togoGlbExport.js'), 'utf8');
  // The interop pass runs before parse…
  assert.ok(/toInteropAttributes\(THREE, object\)/.test(src),
    'exportGlbBlob must run the interop (dequantize) pass');
  assert.ok(/dequantizedFloats/.test(src),
    'the decode must come from lib/togo/interopMesh (one home, tested above)');
  // …and the finished buffer is checked: required extensions ⇒ reject.
  assert.ok(/glbRequiredExtensions\(buf\)/.test(src) && /reject\(new Error\(`GLB no interoperable/.test(src),
    'exportGlbBlob must refuse to ship a GLB carrying extensionsRequired');
});

test('ONE 3D export — the geometry-only OBJ path is gone from every surface', () => {
  // The OBJ carried no textures and cm units; Twinmotion imported it as an
  // empty scene. The owner's ask is TWO buttons (2D DXF · 3D GLB) — a surface
  // re-adding OBJExporter re-opens the exact file this suite exists to kill.
  for (const rel of ['src/pages/embed/TogoEmbed.jsx', 'src/pages/DealerInbox.jsx', 'src/pages/TogoRequests.jsx']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(!/OBJExporter/.test(src), `${rel} must not export OBJ — the GLB is the one 3D export`);
  }
});
