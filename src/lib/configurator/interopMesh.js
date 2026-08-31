/**
 * interopMesh — the INTEROP contract for every 3D file that LEAVES the app.
 *
 * The catalog's streaming GLBs are deliberately quantized (positions int16,
 * normals int8 — see sceneImport's CREASE → WELD → QUANTIZE pipeline): three.js
 * decodes KHR_mesh_quantization natively, so the web configurator gets 80%
 * smaller files for free. But the spec makes that extension REQUIRED — it goes
 * in `extensionsRequired`, and an importer that doesn't implement it is
 * FORBIDDEN from loading the file. Measured 2026-08: Twinmotion's import runs
 * to completion and shows NOTHING for exactly this reason, so a re-export of
 * our own meshes silently produced files no external tool could read.
 *
 * Hence the contract, in two halves both pinned by tests/configuratorInterop.test.js:
 *   • `dequantizedFloats` — the ONE decode (mirrors the glTF/GL conventions
 *     three's own MathUtils.denormalize implements) that turns any quantized
 *     attribute back into plain float32 before export;
 *   • `glbRequiredExtensions` — reads a finished GLB's own header, so the
 *     exporter can REFUSE to ship a file that carries any required extension
 *     (a failed export beats a file that imports as an empty scene).
 *
 * Pure: typed arrays and DataView only — no three, no DOM.
 */

/** max(q/M, -1): glTF's signed-normalized decode — -M and -M-1 both mean -1. */
const snorm = (v, max) => Math.max(v / max, -1);

/**
 * Decode a geometry attribute's backing array to plain Float32.
 *
 * `normalized` follows the glTF/GL rules (what KHR_mesh_quantization stores):
 * signed ints are snorm (÷127 / ÷32767, clamped at -1), unsigned are unorm
 * (÷255 / ÷65535). Without the flag, integers convert numerically (a legal
 * core-glTF integer attribute is a plain number). Floats pass through
 * (Float64 downcasts). Unknown array kinds throw — a silent identity here
 * would ship the very file this module exists to prevent.
 */
export function dequantizedFloats(array, normalized = false) {
  const out = new Float32Array(array.length);
  const kind = array?.constructor?.name || '';
  if (kind === 'Float32Array' || kind === 'Float64Array') {
    out.set(array);
    return out;
  }
  if (!/^(U?i)nt(8|16|32)(Clamped)?Array$/i.test(kind)) {
    throw new Error(`interopMesh: unsupported attribute array ${kind || typeof array}`);
  }
  if (!normalized) {
    for (let i = 0; i < array.length; i++) out[i] = array[i];
    return out;
  }
  const signed = kind.startsWith('Int');
  const bits = kind.includes('8') ? 8 : (kind.includes('16') ? 16 : 32);
  const max = signed ? (2 ** (bits - 1)) - 1 : (2 ** bits) - 1;
  for (let i = 0; i < array.length; i++) {
    out[i] = signed ? snorm(array[i], max) : array[i] / max;
  }
  return out;
}

// GLB container constants (glTF 2.0 binary layout).
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * The `extensionsRequired` list inside a binary glTF (.glb) buffer — the exact
 * field that decides whether a strict importer may load the file at all.
 * Throws on anything that isn't a GLB with a leading JSON chunk: a file this
 * reader can't parse is not a file the exporter should ship either.
 */
export function glbRequiredExtensions(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 20) {
    throw new Error('interopMesh: not a GLB (too short)');
  }
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('interopMesh: not a GLB (bad magic)');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > bytes.byteLength) {
    throw new Error('interopMesh: not a GLB (no JSON chunk)');
  }
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  return Array.isArray(json?.extensionsRequired) ? json.extensionsRequired : [];
}
