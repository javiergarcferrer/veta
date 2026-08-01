/**
 * THE GLB VERSION STAMP — what a file says about the work already baked into it.
 *
 * A GLB is a 12-byte header (magic, version, total length) followed by chunks,
 * each an 8-byte header (length, type) plus its padded payload. The JSON chunk
 * comes first and is the only one we ever touch: the marker has to sit somewhere
 * any glTF reader can find it (not in a node's userData, which is an
 * implementation detail of how we happen to wrap the group), and the exporter
 * owns `asset` and offers no hook into it — so the JSON chunk is rewritten and
 * the container rebuilt around it, byte for byte, with the BIN chunk copied
 * verbatim.
 *
 * Reading the version off the BYTES (rather than parsing the model) is what lets
 * a batch decide "already done" for the price of a `fetch`.
 */

/**
 * The pipeline version a stamped GLB carries. It is a claim about what is
 * ALREADY DONE in the file: v2 = normals creased at `CREASE_ANGLE`, vertices
 * welded, POSITION/NORMAL quantized. Bump it only when THAT contract changes —
 * an older file simply reports a lower version and keeps taking the runtime
 * path it always took.
 */
export const MESH_VERSION = 2;

/** The `asset.extras` key this package WRITES. */
export const MESH_VERSION_KEY = 'vetaMeshV';

/**
 * The key it also ACCEPTS when reading. The fleet stamped before the extraction
 * (every GLB the dealer published through the AlcoverSoft studio) carries
 * `alcoverMeshV`, and those files are already creased + welded + quantized. Drop
 * the alias and every one of them reads as version 0 — the loader would redo the
 * single heaviest step of the model load on the whole catalogue, and a re-run of
 * «Optimizar mallas» would re-export files that need nothing. The alias is
 * READ-ONLY on purpose: new files carry the new key, so the legacy name ages out
 * of the fleet on its own instead of being written forever.
 */
export const LEGACY_MESH_VERSION_KEY = 'alcoverMeshV';

const GLB_MAGIC = 0x46546c67; // 'glTF', little-endian
const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'

interface GlbChunk { type: number; start: number; length: number }

/** The chunk table of a GLB buffer, or null if it isn't one. */
function glbChunks(buffer: ArrayBuffer | null | undefined): GlbChunk[] | null {
  if (!buffer || buffer.byteLength < 20) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) return null;
  const total = Math.min(view.getUint32(8, true), buffer.byteLength);
  const chunks: GlbChunk[] = [];
  for (let at = 12; at + 8 <= total;) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + length > total) return null;
    chunks.push({ type, start, length });
    at = start + length;
  }
  return chunks.length ? chunks : null;
}

/** The glTF JSON document of a GLB buffer, or null when it isn't readable. */
function glbJson(buffer: ArrayBuffer | null | undefined): Record<string, any> | null {
  const json = glbChunks(buffer)?.find((c) => c.type === GLB_CHUNK_JSON);
  if (!json || !buffer) return null;
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, json.start, json.length)));
  } catch { return null; }
}

/** The version an `asset.extras` bag declares — the current key, else the legacy
 *  alias, else 0 (anything we didn't write). */
const versionOfExtras = (extras: any): number =>
  Number(extras?.[MESH_VERSION_KEY] ?? extras?.[LEGACY_MESH_VERSION_KEY]) || 0;

/**
 * The pipeline version a GLB's BYTES declare — 0 for anything we didn't write
 * (every CAD export, every catalogue GLB predating the pipeline).
 */
export function readGlbMeshVersion(buffer: ArrayBuffer | null | undefined): number {
  return versionOfExtras(glbJson(buffer)?.asset?.extras);
}

/**
 * The pipeline version a PARSED glTF declares. Callers gate on the VERSION
 * (`meshVersionOf(parsed) < MESH_VERSION`), never on a truthy stamp — a future
 * v3 file has to fall back to runtime creasing until the reader learns it.
 */
export const meshVersionOf = (parsed: any): number => versionOfExtras(parsed?.asset?.extras);

/**
 * Stamp `asset.extras` onto an exported GLB. Only the JSON chunk's length and
 * the file total change; a buffer we don't recognise ships back unmarked rather
 * than throwing (an unstamped file is merely slower, a corrupted one is lost).
 */
export function stampGlbAsset(buffer: ArrayBuffer, extras: Record<string, unknown>): ArrayBuffer {
  const chunks = glbChunks(buffer);
  const jsonChunk = chunks?.find((c) => c.type === GLB_CHUNK_JSON);
  if (!chunks || !jsonChunk) return buffer; // not a container we recognise — ship it unmarked
  let doc: Record<string, any>;
  try {
    doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, jsonChunk.start, jsonChunk.length)));
  } catch { return buffer; }
  doc.asset = { ...(doc.asset || {}), extras: { ...(doc.asset?.extras || {}), ...extras } };
  const encoded = new TextEncoder().encode(JSON.stringify(doc));
  // Chunk payloads are 4-byte aligned; the JSON chunk pads with SPACES so it
  // stays parseable, the binary one with zeros (it is copied already padded).
  const json = new Uint8Array(Math.ceil(encoded.length / 4) * 4).fill(0x20);
  json.set(encoded);
  const rest = chunks.filter((c) => c !== jsonChunk);
  const total = 12 + 8 + json.length + rest.reduce((n, c) => n + 8 + c.length, 0);
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, GLB_CHUNK_JSON, true);
  bytes.set(json, 20);
  let at = 20 + json.length;
  for (const c of rest) {
    view.setUint32(at, c.length, true);
    view.setUint32(at + 4, c.type, true);
    bytes.set(new Uint8Array(buffer, c.start, c.length), at + 8);
    at += 8 + c.length;
  }
  return out;
}

/** Stamp the CURRENT pipeline version onto an exported GLB. */
export const stampMeshVersion = (buffer: ArrayBuffer, version: number = MESH_VERSION): ArrayBuffer =>
  stampGlbAsset(buffer, { [MESH_VERSION_KEY]: version });
