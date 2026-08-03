/**
 * THE MESH PIPELINE — what the GLB carries so the CLIENT doesn't have to.
 *
 * A CAD export (pCon.planner and friends) is non-indexed float32 triangle soup
 * with per-face normals, and every visitor paid for that twice: once on the wire
 * (37 collection tiles = 26.6 MB, p90 1.4 MB) and once on the CPU, because
 * `toCreasedNormals` — the single heaviest step of the model load — ran over
 * every mesh of every model on every launch. Both costs belong to the FILE, not
 * to the viewer, so they are paid ONCE here, at import, in the one order that
 * composes:
 *
 *   CREASE → WELD → QUANTIZE
 *
 *   crease    `toCreasedNormals` at the SAME angle the loader used, so the
 *             shading is the shading the catalogue has always had. It explodes
 *             the mesh into loose triangles (toNonIndexed) on the way.
 *   weld      `mergeVertices` merges vertices identical in position AND normal
 *             (and uv), which re-indexes that soup while KEEPING the creased
 *             edges split — the crease survives precisely because a hard edge's
 *             two normals differ. Measured 77% fewer vertices on the real tiles.
 *   quantize  POSITION as normalized int16, NORMAL as normalized int8
 *             (KHR_mesh_quantization). three's GLTFExporter declares the
 *             extension itself the moment it sees integer attributes and pads
 *             each element to the 4-byte alignment the spec demands; its
 *             GLTFLoader decodes them natively. That native decode is the whole
 *             reason this and not Draco/meshopt — no decoder bundle to ship to
 *             a visitor who is looking at a sofa.
 *
 * Measured on three real catalogue GLBs: −80%, −80% and −36% of vertex bytes
 * (the last one already shipped indexed, so welding buys it nothing and
 * quantization is its entire win).
 */
import { splitSolids } from '@veta/geometry';
import type {
  BufferGeometryLike,
  BufferGeometryUtilsLike,
  GltfExporterLike,
  MaterialLike,
  MeshLike,
  Object3DLike,
  ThreeLike,
} from './three.ts';
import { collectMeshes } from './three.ts';
import { MESH_VERSION, readGlbMeshVersion, stampMeshVersion } from './glbStamp.ts';

/**
 * The smoothing angle every real model is shaded at — 60°.
 *
 * ONE constant, because the work happens at two moments: this pipeline BAKES it
 * into the GLB and the runtime loader applies it to everything older than that.
 * Two literals would mean a piece shades differently depending on which path
 * produced its file.
 */
export const CREASE_ANGLE = Math.PI / 3;

// Signed-normalized ranges. glTF dequantizes SNORM as max(q/M, -1), so -M and
// -M-1 both decode to -1: clamping at ±M keeps the encoding one-to-one.
const SNORM16 = 32767;
const SNORM8 = 127;
const snorm = (v: number, m: number): number => {
  const q = Math.round(v * m);
  return q > m ? m : (q < -m ? -m : q);
};

/**
 * How far off its OWN origin a geometry may sit and still be quantized, as a
 * multiple of its own half-span. The bound is the precision invariant solved
 * for: an int16 step is `scale / 32767`, the invariant is 0.5 mm over a 2 m span
 * (1 part in 4000), so `scale ≤ 16 × halfSpan` keeps every vertex inside it.
 * Measured worst case on the real catalogue is 3.5 — a CAD export authors its
 * geometry local and carries the placement on the node. Anything past this
 * exports as floats and simply keeps the crease-and-weld win.
 */
export const MAX_ORIGIN_RATIO = 16;

/** The three surface `quantizeGeometry` constructs against. */
type QuantizeThree = Pick<ThreeLike, 'BufferAttribute'>;

/**
 * Quantize one geometry IN PLACE; returns the uniform `scale` the exported node
 * must re-apply, or null when the geometry is outside the contract (which is not
 * a failure — it just exports as floats, exactly as before).
 *
 * glTF has no per-accessor scale, so the dequantization lives in the NODE
 * matrix. Two properties of that mapping are load-bearing, and both are about
 * box-projected UV generation, which projects the fabric UVs from RAW LOCAL
 * POSITIONS divided by the tile ÷ the node's own world scale:
 *
 *   • ONE scale for all three axes, never per-axis — that divisor is a SINGLE
 *     number (`max` of the world scale), so an anisotropic dequantization would
 *     mis-tile the cloth on two axes out of three.
 *   • ANCHORED AT THE ORIGIN, never at the bounding-box centre. Scaling alone is
 *     what the UV divisor cancels exactly (`p/s × s = p`), so the generated UVs
 *     come out bit-identical; re-centring would additionally shift every UV by
 *     `centre/tile`, which lands the weave in a different phase on every mesh.
 *     Measured: 8× downscaled channel delta 0.6 with the origin anchor vs 28
 *     with the centre. The cost is the range guard above, and it is cheap.
 *
 * Morph targets are left alone: their deltas live in the same space as the
 * positions and quantizing one side of that pair deforms the mesh silently.
 */
export function quantizeGeometry(THREE: QuantizeThree, geometry: BufferGeometryLike): number | null {
  const pos = geometry.attributes?.position;
  if (!pos || pos.itemSize !== 3 || pos.normalized) return null;
  if (Object.keys(geometry.morphAttributes || {}).length) return null;
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb || !Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) return null;
  const scale = Math.max(
    Math.abs(bb.min.x), Math.abs(bb.max.x),
    Math.abs(bb.min.y), Math.abs(bb.max.y),
    Math.abs(bb.min.z), Math.abs(bb.max.z),
  );
  const halfSpan = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) / 2;
  if (!(scale > 0) || !(halfSpan > 0)) return null;      // a point, or already at the origin
  if (scale / halfSpan > MAX_ORIGIN_RATIO) return null;  // too far off its own origin to stay precise
  const q = new Int16Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    q[i * 3] = snorm(pos.getX(i) / scale, SNORM16);
    q[i * 3 + 1] = snorm(pos.getY(i) / scale, SNORM16);
    q[i * 3 + 2] = snorm(pos.getZ(i) / scale, SNORM16);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(q, 3, true));
  geometry.boundingBox = null;
  geometry.boundingSphere = null;
  // Normals are unit vectors, so int8 is a ~0.45° step — the meshopt default,
  // and invisible on matte upholstery. UVs are deliberately NOT quantized: a
  // factory piece's baked set is what makes its own bitmaps land where the
  // product designer put them, and it is free to run outside [0,1].
  const nrm = geometry.attributes.normal;
  if (nrm && nrm.itemSize === 3 && !nrm.normalized) {
    const n = new Int8Array(nrm.count * 3);
    for (let i = 0; i < nrm.count; i++) {
      n[i * 3] = snorm(nrm.getX(i), SNORM8);
      n[i * 3 + 1] = snorm(nrm.getY(i), SNORM8);
      n[i * 3 + 2] = snorm(nrm.getZ(i), SNORM8);
    }
    geometry.setAttribute('normal', new THREE.BufferAttribute(n, 3, true));
  }
  return scale;
}

export interface BakedGeometry {
  /** The baked geometry, or the SOURCE verbatim when it couldn't be baked. */
  geometry: BufferGeometryLike;
  /** The uniform dequantization the exported node must compose in, if any. */
  fit: unknown | null;
  /** False when the source came back untouched — the stamp is all-or-nothing. */
  creased: boolean;
  /** The geometry's connected masses, one primitive each — computed lazily and
   *  cached HERE, per SOURCE geometry, so a buffer placed eight times is split
   *  once (`splitGeometryBySolid`). `[geometry]` when it exports whole. */
  pieces?: BufferGeometryLike[];
}

/**
 * Crease + weld + quantize ONE geometry, off to the side.
 *
 * NEVER touches the source. `toCreasedNormals` MUTATES a non-indexed input, and
 * the scene's own meshes may still be on screen behind a review list (a piece can
 * also be exported twice) — so it always runs on a clone. A geometry that can't
 * be baked still has to export: it comes back verbatim with `creased: false`,
 * which is what stops the GLB from claiming work it didn't get.
 */
export function bakeGeometry(
  THREE: Pick<ThreeLike, 'BufferAttribute' | 'Matrix4'>,
  utils: BufferGeometryUtilsLike | null | undefined,
  source: BufferGeometryLike,
  creaseAngle: number = CREASE_ANGLE,
): BakedGeometry {
  if (!utils?.toCreasedNormals || !utils?.mergeVertices || !source?.attributes?.position) {
    return { geometry: source, fit: null, creased: false };
  }
  let geometry: BufferGeometryLike;
  try {
    geometry = utils.mergeVertices(utils.toCreasedNormals(source.clone(), creaseAngle));
  } catch {
    return { geometry: source, fit: null, creased: false };
  }
  // A pure uniform scale — no rotation, no translation. That is the whole point
  // of anchoring at the origin (see quantizeGeometry): the node scales the
  // normalized positions back up and nothing else moves.
  const scale = quantizeGeometry(THREE, geometry);
  const fit = scale ? new THREE.Matrix4().makeScale(scale, scale, scale) : null;
  return { geometry, fit, creased: true };
}

/**
 * Above this many masses a mesh is CONFETTI (scan noise, exploded seams), and
 * one primitive each would bloat the file and the draw calls for nothing. The
 * mesh then exports whole, exactly as it did before the split existed. A real
 * sofa lands well under it.
 */
export const MAX_SOLIDS_PER_MESH = 64;

/**
 * Freeze a node's part key by giving its material a NAME.
 *
 * This is the hazard the whole split had to clear. An unnamed material keys its
 * part by NODE INDEX (`partKeyFor`), so emitting one node per mass renumbers
 * every node after the first split — which would silently re-tag a cushion as a
 * bolster across the whole catalogue. Naming the material after the node it came
 * from freezes the key, so the split is ADDITIVE: what the dealer already tagged
 * keeps its key and the new masses arrive as `key~2`, `key~3` (the `~n` space
 * `partKeysFor` already uses).
 *
 * CLONED per node on purpose: two nodes sharing one unnamed material had two
 * distinct keys (`#3`, `#5`), and naming the shared instance would collapse them
 * into one part.
 */
export function pinnedMaterial(
  material: MaterialLike | MaterialLike[],
  nodeIndex: number,
): MaterialLike | MaterialLike[] {
  const first = Array.isArray(material) ? material[0] : material;
  if (!first) return material;
  if (first.name && String(first.name).trim()) return material;
  const clone = Array.isArray(material) ? material.map((mm) => mm.clone()) : first.clone();
  const target = Array.isArray(clone) ? clone[0] : clone;
  if (target) target.name = `#${nodeIndex}`;
  return clone;
}

/** A typed-array constructor, as read back off an attribute's own buffer. */
type TypedArrayCtor = new (length: number) => { [i: number]: number; length: number };

/**
 * One geometry holding only `triangles`, with its own COMPACTED vertices.
 *
 * Compacting is the point: sharing the parent's attribute buffers would write
 * the WHOLE vertex array into every primitive and multiply the file by the
 * number of masses. Attribute types and the `normalized` flag are preserved, so
 * a quantized geometry stays quantized.
 */
function subGeometry(
  THREE: Pick<ThreeLike, 'BufferAttribute' | 'BufferGeometry'>,
  geometry: BufferGeometryLike,
  triangles: readonly number[],
  indexAt: (i: number) => number,
): BufferGeometryLike {
  const remap = new Map<number, number>();
  const order: number[] = [];
  const index = new Uint32Array(triangles.length * 3);
  let at = 0;
  for (const t of triangles) {
    for (let k = 0; k < 3; k += 1) {
      const v = indexAt(t * 3 + k);
      let n = remap.get(v);
      if (n === undefined) { n = order.length; remap.set(v, n); order.push(v); }
      index[at] = n; at += 1;
    }
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes || {})) {
    const size = attr.itemSize;
    const Ctor = attr.array.constructor as unknown as TypedArrayCtor;
    const arr = new Ctor(order.length * size);
    for (let i = 0; i < order.length; i += 1) {
      const src = order[i]! * size;
      for (let c = 0; c < size; c += 1) arr[i * size + c] = attr.array[src + c] as number;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr as never, size, attr.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

/**
 * Split a baked geometry into its SOLID MASSES — the reason a tagger can offer a
 * cushion instead of a scatter of shreds. Every consumer downstream (the tagger,
 * the raycast, the selection outline) already works per MESH, so making one mesh
 * BE one mass is the whole integration: nothing else changes.
 *
 * Runs AFTER crease/weld/quantize so all masses share the node's dequantization
 * fit, and reads the quantized integer positions directly — `splitSolids` sizes
 * its weld grid off the model's own bounding diagonal, so integers segment
 * exactly like floats.
 *
 * Bails (exporting the mesh whole) on multi-material groups and morph targets,
 * where a per-mass index would lose the material assignment or the morph.
 */
export function splitGeometryBySolid(
  THREE: Pick<ThreeLike, 'BufferAttribute' | 'BufferGeometry'>,
  geometry: BufferGeometryLike,
): BufferGeometryLike[] {
  const pos = geometry?.attributes?.position;
  if (!pos?.array) return [geometry];
  if ((geometry.groups?.length || 0) > 1) return [geometry];
  if (Object.keys(geometry.morphAttributes || {}).length) return [geometry];
  let solids;
  try {
    ({ solids } = splitSolids({ positions: pos.array, indices: geometry.index?.array || null }));
  } catch { return [geometry]; }
  if (solids.length < 2 || solids.length > MAX_SOLIDS_PER_MESH) return [geometry];
  const index = geometry.index?.array || null;
  const indexAt = index ? (i: number) => index[i] as number : (i: number) => i;
  return solids.map((s) => subGeometry(THREE, geometry, s.triangles, indexAt));
}

export interface ExportPieceDeps {
  /** A GLTFExporter instance (code-split and constructed by the caller). */
  exporter: GltfExporterLike;
  /** BufferGeometryUtils; omit it and the piece exports unbaked and unstamped. */
  utils?: BufferGeometryUtilsLike | null;
  /** The smoothing angle to bake — must match the runtime loader's. */
  creaseAngle?: number;
  /** The version to stamp. Only bump alongside the pipeline's contract. */
  meshVersion?: number;
}

/**
 * Re-export one piece's meshes as a self-contained binary GLB (ArrayBuffer).
 * World transforms are baked onto each clone, so the piece carries exactly the
 * geometry it had in the scene (a configurator recentres on load anyway).
 *
 * INVARIANT — MATERIAL NAMES SURVIVE THE ROUND TRIP. Each clone reuses the
 * SOURCE material object by reference (never a substitute or a re-created one),
 * because GLTFExporter copies `material.name` straight into the GLB's
 * `materials[].name`, and the part tagger keys every mesh part by that name
 * (`partKeyFor` — pCon gives a part type one material id across a whole
 * collection and no node names at all). Swap in a fresh material here and the
 * re-imported GLB is one anonymous blob: "detect parts" can no longer tell a
 * cushion from a bolster, and per-part fabric pricing dies with it.
 *
 * ONE MESH PER SOLID (v3). Each baked geometry is then split into its connected
 * masses (`splitGeometryBySolid`), because every consumer downstream already
 * works per MESH — so making one mesh BE one mass is what lets a tagger address
 * a cushion instead of every shred that shares its fabric. The ONLY thing that
 * makes that safe is `pinnedMaterial`: an UNNAMED material keys its part by node
 * index, so the renumbering a split causes would re-tag the catalogue. Name
 * first, split second; the order is the invariant.
 *
 * Reusing the source material is also what BAKES a bundled finish in: a binary
 * GLB embeds its images, so a material carrying a decoded map exports as a
 * self-contained texture — nothing to store beside the mesh, nothing to resolve
 * at render time. `bakeBundledMaps` (sidecarTextures) has already bounded and
 * re-mimed those images; this call is where they become bytes.
 *
 * The GEOMETRY goes through the pipeline above (crease → weld → quantize) and
 * the file says so, so the loader can skip the runtime crease. Materials,
 * textures and UVs are untouched by all of it.
 */
export async function exportPieceGlb(
  THREE: ThreeLike,
  meshes: MeshLike[],
  { exporter, utils = null, creaseAngle = CREASE_ANGLE, meshVersion = MESH_VERSION }: ExportPieceDeps,
): Promise<ArrayBuffer> {
  const group = new THREE.Group();
  // ONE bake per SOURCE geometry, not per node: a CAD scene places the same
  // buffer many times (an eight-module sofa is one cushion mesh over and over),
  // and GLTFExporter dedups meshes by geometry IDENTITY — bake per node and the
  // GLB carries eight copies of the same cushion.
  const baked = new Map<BufferGeometryLike, BakedGeometry>();
  // Whether EVERY mesh actually came through the pipeline. A GLB that claimed
  // baked normals it never got would ship flat-shaded soup to every visitor,
  // with the loader's own creasing switched off — so the stamp is all-or-nothing.
  let creased = meshes.length > 0;
  meshes.forEach((m, nodeIndex) => {
    let entry = baked.get(m.geometry);
    if (!entry) { entry = bakeGeometry(THREE, utils, m.geometry, creaseAngle); baked.set(m.geometry, entry); }
    if (!entry.creased) creased = false;
    // PIN THE PART KEY BEFORE SPLITTING. An unnamed material keys its part by
    // NODE INDEX, and emitting one node per solid renumbers every node after the
    // first split — which would silently re-tag a cushion as a bolster across
    // the whole catalogue. Naming the material after the node it came from
    // freezes the key, so the split is additive: what the dealer already tagged
    // keeps its key and the new masses arrive as `key~2`, `key~3`.
    const material = pinnedMaterial(m.material, nodeIndex);
    if (!entry.pieces) entry.pieces = splitGeometryBySolid(THREE, entry.geometry);
    for (const geometry of entry.pieces) {
      const c = new THREE.Mesh(geometry, material);
      c.matrixAutoUpdate = false;
      // The node carries the world transform it always did, now composed with
      // the dequantization fit — the exporter writes the composed matrix
      // verbatim, and every mass of a node shares that one fit.
      c.matrix.copy(m.matrixWorld);
      if (entry.fit) c.matrix.multiply(entry.fit as InstanceType<ThreeLike['Matrix4']>);
      group.add(c);
    }
  });
  const buffer = await exporter.parseAsync(group, { binary: true }) as ArrayBuffer;
  return creased ? stampMeshVersion(buffer, meshVersion) : buffer;
}

/**
 * Whether a stored mesh URL can go through the re-export. GLB only: a row still
 * serving a raw .fbx/.obj (a multi-piece drop uploads the file verbatim) carries
 * no stamp to read, so a batch would re-convert it on every run. ONE rule, so a
 * button's count and the run itself can never disagree about which models the
 * batch is even about.
 */
export const isOptimizableMeshUrl = (url: unknown): boolean =>
  /\.(glb|gltf)(\?|$)/i.test(String(url || ''));

export interface OptimizeGlbDeps extends ExportPieceDeps {
  THREE: ThreeLike;
  /**
   * Parse a GLB buffer into its scene root — the caller's GLTFLoader, injected.
   *
   * Deliberately NOT the app's model loader: that one strips label/shadow meshes
   * and creases, and re-exporting a stripped scene would silently drop nodes AND
   * renumber the rest (part tagging keys unnamed materials by node index, so a
   * shifted index is a cushion re-tagged as a bolster). This reads the file
   * exactly as it is.
   */
  parseGlb(buffer: ArrayBuffer): Promise<Object3DLike | null>;
}

export interface OptimizeGlbResult {
  /** True when the file already carried this pipeline's stamp. */
  skipped: boolean;
  before: number;
  after: number;
  /** The re-exported bytes, or null when nothing was done. */
  buffer: ArrayBuffer | null;
}

/**
 * Re-export one ALREADY-PUBLISHED GLB through the current pipeline — the
 * per-model unit of a bulk "optimize meshes" run, which is how meshes ingested
 * before the pipeline existed get the same treatment as a fresh import.
 *
 * Idempotent by the file's own stamp: a GLB already at `meshVersion` comes back
 * `skipped`, so re-running a batch costs bandwidth and nothing else. Throws only
 * on a file it cannot read at all — a caller collects that as a casualty.
 */
export async function optimizeGlbBuffer(
  buffer: ArrayBuffer,
  deps: OptimizeGlbDeps,
): Promise<OptimizeGlbResult> {
  const { THREE, parseGlb, meshVersion = MESH_VERSION } = deps;
  const before = buffer.byteLength;
  // Read off the BYTES, not off a parse: "already done" costs the download and
  // nothing else, and the legacy alias is honoured there (glbStamp).
  if (readGlbMeshVersion(buffer) >= meshVersion) {
    return { skipped: true, before, after: before, buffer: null };
  }
  const object = await parseGlb(buffer);
  if (!object) throw new Error('The file could not be read.');
  object.updateMatrixWorld(true);
  const meshes = collectMeshes(object);
  if (!meshes.length) throw new Error('The file carries no geometry.');
  const out = await exportPieceGlb(THREE, meshes, deps);
  return { skipped: false, before, after: out.byteLength, buffer: out };
}
