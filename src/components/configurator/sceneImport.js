/**
 * Batch scene import — the three.js half of "Importar escena". pCon.planner
 * exports a WHOLE plan into one file (there is no per-article export), so the
 * dealer lays every piece out with some air between them, exports once
 * (GLB/FBX/OBJ/DAE/3DS), and drops that single file here. We load it with the
 * SAME loaders the configurator uses, cluster the meshes into pieces on the
 * floor plane (lib/configurator/sceneSplit — pure, tested), and re-export each piece as
 * its own compact GLB ready for `uploadConfiguratorMesh` + a togo_models row. three and
 * the exporter are code-split (safeDynamicImport) — the admin page pays nothing
 * until a scene is actually dropped.
 */
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { autoUnitScale } from '../../lib/configurator/model.js';
import { detectUpAxis, clusterFootprints, clusterName } from '../../lib/configurator/sceneSplit.js';
import { splitSolids } from '../../lib/configurator/solidSplit.js';
import { readTdsMaterialGroups, reorderIndexForGroups } from '../../lib/configurator/tdsMaterialGroups.js';
import { loaderFor, normalizeLoaded, extOf, CREASE_ANGLE, ALCOVER_MESH_V } from './modelLoader.js';

// Pieces whose footprint tops out under this are exporter debris (labels,
// origin markers), not furniture — dropped from the review list.
const MIN_PIECE_CM = 15;
// Two meshes further apart than this on the floor are different pieces; the
// dealer just needs to leave MORE than this between pieces in pCon.
const CLUSTER_GAP_CM = 15;
// What the loaders cover. The batch checks this BEFORE touching a file so a
// stray PDF/DWG caught by a folder multi-select is refused for free, instead of
// paying a loader import to fail on it.
const MODEL_EXT_RE = /\.(fbx|glb|gltf|obj|dae|3ds)$/i;
// SIDECAR BITMAPS — a Ligne Roset product folder ships the .3ds AND the maps its
// materials name (Intervalle_Shelf_Small_Walnut_Green/ holds DCMAP1..3.JPG: the
// walnut, its bump, the green lacquer). They are never models and never
// casualties: they are the FINISH, paired to their mesh by folder below.
const TEXTURE_EXT_RE = /\.(jpe?g|png|gif|bmp|webp|tga)$/i;
// The accept list the intake needs to let those through — exported so the page's
// folder zones and this module can never disagree about what a sidecar IS.
export const ACCEPT_TEXTURES = '.jpg,.jpeg,.png,.gif,.bmp,.webp,.tga';

// A bundled map is downscaled to this longer edge before export. A GLB is
// re-downloaded by every visitor who opens the configurator, and an LR product
// bitmap is routinely 2–4k for a shelf that renders 300 px wide — the cost is
// paid forever for detail nobody can see. 1024 keeps grain legible at full-
// screen and bounds the file.
const MAX_TEXTURE_PX = 1024;
// A bitmap that never loads must not hang the import: the mesh still imports,
// just without that map (the whole point of the missing-bitmap rule).
const TEXTURE_TIMEOUT_MS = 15000;

// A file name read as a piece name — the same cleaning the single-file drop
// does. Converting one DWG at a time, the dealer names the OUTPUT after the
// article ("Prado_2-plazas.glb"), so for a one-piece file the filename beats
// anything inside the export (pCon writes block ids as node names).
const nameFromFile = (fileName) =>
  String(fileName || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

/**
 * A dropped File's path inside the library — the ONE place that property is
 * read, so the shape pass and the per-file read can never disagree about what
 * string a file's path even is. `relPath` is what `useFileIntake` stamps on
 * every walked/picked file; a loose file carries its bare name there.
 */
const relPathOf = (file) => String(file?.relPath || file?.webkitRelativePath || file?.name || '');

/** How many DISTINCT grupos/categorías/colecciones a piece list proposes — the
 *  one line the review step shows above the rows. */
export function summarizeFolderProposals(pieces) {
  const groups = new Set();
  const categories = new Set();
  const collections = new Set();
  for (const p of pieces || []) {
    if (p?.folderGroup) groups.add(p.folderGroup);
    if (p?.folderCategory) categories.add(p.folderCategory);
    if (p?.folderCollection) collections.add(p.folderCollection);
  }
  return { groups: groups.size, categories: categories.size, collections: collections.size };
}

/** The folder a walked path sits in ("Occasional/Intervalle/x.3ds" →
 *  "Occasional/Intervalle"). A loose file's folder is the empty string, which
 *  is a real key — loose files pair with loose files, never with a tree. */
const dirOf = (path) => { const s = String(path || ''); const i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i); };

/** The bare filename of a requested URL, lowercased — the ONLY part of it a
 *  bundled bitmap can be matched on. A 3DS names its maps in DOS 8.3 caps
 *  ("DCMAP1.JPG") while the file on disk may be any case, and the loaders hand
 *  the manager a full URL with whatever base they derived (a blob: origin, a
 *  resourcePath, a relative prefix) glued in front. Matching the basename
 *  case-INSENSITIVELY is what makes the pairing work at all. */
const baseNameOf = (url) => String(url || '').split(/[?#]/)[0].split(/[/\\]/).pop().toLowerCase();

/**
 * A LoadingManager that resolves the material-referenced bitmap NAMES against
 * the actual sibling files of the product folder.
 *
 * The loaders resolve a map name against the model's own URL — which here is a
 * `blob:` handle with no folder behind it, so every bundled map 404s and the
 * piece imports as an untextured shell. `setURLModifier` is the seam three
 * gives us: the request still goes out under whatever base the loader built,
 * and we swap in the object URL of the sibling file with that basename.
 *
 * Returns the manager plus `settled()`, `sourceOf(url)` (which File a served
 * blob URL came from — the mime decision below reads it) and `dispose()`. Blob
 * handles are revoked by `dispose`; an <img> that has fired `load` already holds
 * its decoded pixels, so nothing is lost by revoking after the wait.
 *
 * `settled()` is the manager's own `onLoad`, and it is NOT optional: a loader's
 * `loadAsync` resolves the moment the MESH is parsed, while `TextureLoader`
 * assigns `texture.image` from an async callback — read the object at that
 * instant and every map is an image-less shell, which is indistinguishable from
 * "the bitmap was missing". The manager counts the mesh read as an item too, and
 * closes it only AFTER the parse has registered the maps, so its completion is
 * the one signal that means "the maps are decoded". Raced against a timeout: a
 * bitmap that never answers costs that map, never the import.
 */
function bundleTextures(THREE, files) {
  const manager = new THREE.LoadingManager();
  const byName = new Map();     // lowercased basename → object URL
  const byUrl = new Map();      // object URL → the File it came from
  for (const f of files) {
    const name = baseNameOf(f?.name);
    if (!name || byName.has(name)) continue;   // first wins — a folder can't hold two of a name
    const url = URL.createObjectURL(f);
    byName.set(name, url);
    byUrl.set(url, f);
  }
  manager.setURLModifier((url) => byName.get(baseNameOf(url)) || url);
  let finish = null;
  const done = new Promise((resolve) => { finish = resolve; });
  manager.onLoad = () => finish();
  return {
    manager,
    settled: (ms) => Promise.race([done, new Promise((r) => { setTimeout(r, ms); })]),
    sourceOf: (url) => byUrl.get(url) || null,
    dispose: () => { for (const url of byName.values()) URL.revokeObjectURL(url); byName.clear(); },
  };
}

/** Every texture hanging off a loaded object, once each. */
function texturesOf(object) {
  const out = new Set();
  object?.traverse?.((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const slot of ['map', 'bumpMap', 'alphaMap', 'specularMap', 'normalMap', 'emissiveMap']) {
        if (m?.[slot]?.isTexture) out.add(m[slot]);
      }
    }
  });
  return [...out];
}

/** Resolve once one bitmap has decoded (or failed, or run out of patience) —
 *  the second gate behind the manager's, for a loader that hands a texture its
 *  image without ever telling the manager. */
function imageSettled(image, ms) {
  return new Promise((resolve) => {
    if (!image || typeof image.addEventListener !== 'function') { resolve(); return; }
    if (image.complete) { resolve(); return; }
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    image.addEventListener('load', done);
    image.addEventListener('error', done);
  });
}

/**
 * Make the bundled maps EXPORTABLE, in place.
 *
 *   • a map that never decoded is DROPPED off its material — a missing bitmap
 *     costs that map, never the import (the piece still lands, just plainer).
 *   • the diffuse map is tagged sRGB (the loaders leave it linear, which reads
 *     as a washed-out finish anywhere the object is rendered before export).
 *   • anything past MAX_TEXTURE_PX is redrawn through a canvas at that size;
 *     GLTFExporter re-encodes whatever `image` holds, so the resize IS the
 *     bound on the GLB.
 *   • the encode mime is pinned to the SOURCE's: an LR map is a photographic
 *     JPEG, and the exporter's PNG default turns 150 KB of wood grain into
 *     ~2 MB of lossless noise, three times over, in a file every visitor
 *     downloads. PNG stays the default wherever alpha might matter.
 */
function bakeBundledMaps(THREE, object, sourceOf) {
  for (const tex of texturesOf(object)) {
    const image = tex.image;
    const width = image?.width || 0;
    const height = image?.height || 0;
    if (!width || !height) { tex.userData.bundleFailed = true; continue; }
    const src = sourceOf?.(image?.currentSrc || image?.src || '');
    if (src && /\.jpe?g$/i.test(src.name || '')) tex.userData.mimeType = 'image/jpeg';
    const longest = Math.max(width, height);
    if (longest > MAX_TEXTURE_PX) {
      const k = MAX_TEXTURE_PX / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * k));
      canvas.height = Math.max(1, Math.round(height * k));
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.drawImage(image, 0, 0, canvas.width, canvas.height); tex.image = canvas; }
    }
    tex.needsUpdate = true;
  }
  object?.traverse?.((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const slot of ['map', 'bumpMap', 'alphaMap', 'specularMap', 'normalMap', 'emissiveMap']) {
        if (m?.[slot]?.userData?.bundleFailed) m[slot] = null;
      }
      if (m?.map) m.map.colorSpace = THREE.SRGBColorSpace;
      if (m) m.needsUpdate = true;
    }
  });
}

/**
 * Put a .3ds import's materials back on the geometry they belong to, in place.
 *
 * TDSLoader assigns each material a consecutive slice of the index buffer while
 * the file assigns materials by explicit face LISTS (see lib/configurator/tdsMaterialGroups
 * for the measured damage). Reordering each mesh's faces into group order makes
 * the loader's own groups describe the geometry exactly — no group rewriting, no
 * material remapping, and the draw-call count stays one per material.
 *
 * Meshes pair with parsed objects BY ORDER (TDSLoader walks the same chunks in
 * the same order) and every pairing is checked against the face count before
 * anything is touched. Any mismatch, any unreadable buffer, any ambiguous face
 * list → that mesh is left exactly as it loaded.
 *
 * @returns the number of meshes repaired.
 */
function repairTdsMaterialGroups(THREE, object, buffer) {
  const parsed = readTdsMaterialGroups(buffer);
  if (!parsed.length) return 0;
  const meshes = [];
  object.traverse((o) => { if (o.isMesh && o.geometry?.index) meshes.push(o); });
  if (meshes.length !== parsed.length) return 0;   // can't pair — repair nothing
  let fixed = 0;
  for (const [i, mesh] of meshes.entries()) {
    const entry = parsed[i];
    const index = mesh.geometry.index;
    if (!entry || index.count !== entry.faceCount * 3) continue;
    if (entry.groups.length < 2) continue;         // one material — order is moot
    const reordered = reorderIndexForGroups(index.array, entry.groups, entry.faceCount);
    if (!reordered) continue;
    mesh.geometry.setIndex(new THREE.BufferAttribute(reordered, 1));
    fixed += 1;
  }
  return fixed;
}

/**
 * Load a local scene file (from a file input / drop) into an Object3D.
 *
 * `opts.textures` are the SIBLING bitmaps of the same product folder — pass them
 * and the material-referenced map names resolve against them (bundleTextures);
 * omit them and this is exactly the untextured load it always was.
 */
export async function loadSceneFile(file, { textures } = {}) {
  const THREE = await safeDynamicImport(() => import('three'));
  const ext = extOf(file.name);
  const loader = await loaderFor(ext);
  if (!loader) throw new Error('Formato no soportado — usa GLB, FBX, OBJ, DAE o 3DS.');
  const url = URL.createObjectURL(file);
  // The loaders are freshly constructed per call, so re-pointing the manager is
  // private to this load — no shared instance to leak a modifier onto.
  const bundle = textures?.length ? bundleTextures(THREE, textures) : null;
  if (bundle) loader.manager = bundle.manager;
  try {
    const res = await loader.loadAsync(url);
    const object = normalizeLoaded(ext, res);
    // A .3ds arrives with its materials on the wrong faces — repair before
    // anything reads them (the split carries the assignment across, and the
    // part key IS the material name).
    if (ext === '3ds' && object) {
      try { repairTdsMaterialGroups(THREE, object, await file.arrayBuffer()); } catch { /* leave it as it loaded */ }
    }
    if (bundle) {
      await bundle.settled(TEXTURE_TIMEOUT_MS);
      await Promise.all(texturesOf(object).map((t) => imageSettled(t.image, TEXTURE_TIMEOUT_MS)));
      bakeBundledMaps(THREE, object, bundle.sourceOf);
    }
    return { THREE, object };
  } finally {
    URL.revokeObjectURL(url);
    bundle?.dispose();
  }
}

/**
 * Split a loaded scene into pieces. Returns `{ upAxis, unitScale, pieces }`,
 * each piece `{ name, widthCm, depthCm, meshes }` (meshes = the source scene's
 * mesh nodes, world matrices up to date). `widthCm`/`depthCm` are footprint
 * ESTIMATES for the review list — the real stored footprint is re-derived from
 * the uploaded GLB by the same meshToPlan pipeline as a single upload.
 */
export function splitScene(THREE, object) {
  object.updateMatrixWorld(true);
  const meshes = [];
  object.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
  if (!meshes.length) return { upAxis: 'y', unitScale: 1, pieces: [] };

  const whole = new THREE.Box3().setFromObject(object);
  const size = whole.getSize(new THREE.Vector3());
  const upAxis = detectUpAxis(size);
  const [fa, fb] = upAxis === 'z' ? ['x', 'y'] : ['x', 'z'];
  // Power-of-ten unit factor from the scene HEIGHT (≈ the tallest piece): the
  // same auto-unit guard the single-upload pipeline applies, so the clustering
  // gap and the size filter mean real centimetres whatever the export units.
  const unitScale = autoUnitScale(upAxis === 'z' ? size.z : size.y);

  const boxes = meshes.map((m, i) => {
    const b = new THREE.Box3().setFromObject(m);
    return { id: i, min: [b.min[fa], b.min[fb]], max: [b.max[fa], b.max[fb]] };
  });
  const clusters = clusterFootprints(boxes, CLUSTER_GAP_CM / unitScale);

  // A mesh's candidate name: its child-of-root ancestor's name (pCon groups a
  // piece's meshes under one node), falling back to the mesh's own name.
  const topName = (m) => {
    let o = m, last = m.name || '';
    while (o.parent && o.parent !== object) { o = o.parent; if (o.name) last = o.name; }
    return last;
  };

  const pieces = clusters.map((ids, ci) => {
    let minA = Infinity, minB = Infinity, maxA = -Infinity, maxB = -Infinity;
    for (const id of ids) {
      const b = boxes[id];
      minA = Math.min(minA, b.min[0]); minB = Math.min(minB, b.min[1]);
      maxA = Math.max(maxA, b.max[0]); maxB = Math.max(maxB, b.max[1]);
    }
    return {
      name: clusterName(ids.map((id) => topName(meshes[id])), ci),
      widthCm: Math.round((maxA - minA) * unitScale),
      depthCm: Math.round((maxB - minB) * unitScale),
      meshes: ids.map((id) => meshes[id]),
    };
  }).filter((p) => Math.max(p.widthCm, p.depthCm) >= MIN_PIECE_CM);

  return { upAxis, unitScale, pieces };
}

/**
 * Load MANY model files into ONE aggregated piece list — the bulk ingest entry.
 *
 * pCon.planner has no batch export: converting Ligne Roset's DWGs, the dealer
 * gets ONE FILE PER MODEL, so a whole collection arrives as a folder of thirty
 * files rather than as one laid-out scene. Each file still goes through the same
 * load + cluster pipeline as a single drop (a converted file can itself hold
 * several pieces), and everything found lands in one list for one review pass.
 *
 * Files are walked STRICTLY SEQUENTIALLY: one pCon export is tens of MB of
 * geometry, and parsing thirty in parallel is how the tab dies with the dealer's
 * afternoon of conversions in it.
 *
 * A file that won't parse NEVER aborts the batch — dropping a folder must yield
 * the twenty-nine good models, not a dead run because one DWG converted badly.
 * Casualties come back in `failed` so the review list can name them and the
 * dealer knows exactly which ones to redo.
 *
 * SOME PRODUCTS BRING THEIR OWN MATERIALS: a product folder can hold the mesh
 * AND the bitmaps its materials name (Ligne Roset's do). Those ride the same
 * drop, are paired to the mesh of THEIR folder, and get baked into the exported
 * GLB — so an Intervalle imports as walnut and green lacquer, not a grey shell.
 *
 * WHAT THIS FUNCTION DOES NOT DO IS READ THE TAXONOMY. Where a file sits in a
 * library says grupo / categoría / colección, but only in the vocabulary of the
 * manufacturer who filed it — so that read belongs to the ACTIVE BRAND's
 * geometry module and the caller does it (`resolveShape` over the whole drop,
 * then `parsePath` per `sourceFile`). This module is the three.js half and stays
 * brand-agnostic.
 *
 * @param {File[]|FileList} files  the dropped/picked files, processed in order.
 * @param {object} [opts]
 * @param {(p: { done: number, total: number, current: string }) => void} [opts.onProgress]
 *   Fired BEFORE each file starts; `done` counts the files already finished.
 * @returns {Promise<{
 *   THREE: any,
 *   pieces: Array<{ name: string, widthCm: number, depthCm: number, meshes: any[],
 *                   upAxis: string, sourceFile: File, sourceName: string,
 *                   folderGroup: string|null, folderCategory: string|null,
 *                   folderCollection: string|null }>,
 *   failed: Array<{ name: string, error: string }>
 * }>} `THREE` is the module the returned meshes belong to — null only when
 *   nothing loaded at all, so it is always present when `pieces` is non-empty.
 *   The three `folder*` fields come back NULL and are the caller's to fill from
 *   the brand's module — see above.
 */
export async function loadPiecesFromFiles(files, { onProgress } = {}) {
  const list = Array.from(files || []);
  // The drop splits in two BEFORE anything is read: the meshes, and the bitmaps
  // that dress them. A sidecar is not a model and must never surface as a
  // casualty — "No se pudieron leer: DCMAP1.JPG" would name the dealer's own
  // textures as broken files, and the progress counter would count them as work.
  const models = list.filter((f) => !TEXTURE_EXT_RE.test(f?.name || ''));
  const texturesByDir = new Map();
  for (const f of list) {
    if (!TEXTURE_EXT_RE.test(f?.name || '')) continue;
    const dir = dirOf(relPathOf(f));
    const bag = texturesByDir.get(dir);
    if (bag) bag.push(f); else texturesByDir.set(dir, [f]);
  }
  const pieces = [];
  const failed = [];
  let THREE = null;
  let done = 0;

  for (const file of models) {
    onProgress?.({ done, total: models.length, current: file.name });
    try {
      if (!MODEL_EXT_RE.test(file.name)) {
        throw new Error('No es un modelo 3D (.fbx, .glb, .obj, .dae, .3ds).');
      }
      // ITS OWN folder's bitmaps, nobody else's. Ligne Roset ships one product
      // per folder and reuses the same DOS map names (DCMAP1.JPG) across the
      // whole library, so pairing by anything wider than the exact folder
      // dresses a shelf in the sofa next door's fabric.
      const loaded = await loadSceneFile(file, { textures: texturesByDir.get(dirOf(relPathOf(file))) });
      // three is module-cached behind safeDynamicImport, so every file yields
      // the SAME module — hold the first one and hand it back for exportPieceGlb.
      THREE = THREE || loaded.THREE;
      const split = splitScene(loaded.THREE, loaded.object);
      if (!split.pieces.length) {
        throw new Error('No se detectaron piezas — ¿exportaste la geometría 3D?');
      }
      // One file, one piece = the normal per-article conversion → the filename
      // IS the model name. Several pieces means the dealer laid a few articles
      // out in one plan, and there the clustered node names are all we have.
      const single = split.pieces.length === 1;
      for (const p of split.pieces) {
        pieces.push({
          ...p,
          name: (single && nameFromFile(file.name)) || p.name,
          // The TAXONOMY IS THE BRAND'S, so this loader does not read it. Every
          // piece carries its `sourceFile`, and the caller files the whole batch
          // through the ACTIVE BRAND's geometry module (one `resolveShape` over
          // the drop, then `parsePath` per file) — see ConfiguratorCatalog's
          // `onManyFiles`. These three stay on the shape so the review row's
          // "what the drop proposed" fields have a home to be written into.
          folderGroup: null,
          folderCategory: null,
          folderCollection: null,
          // PER FILE, never per batch: a folder mixes exports from different
          // pCon sessions and different source DWGs, so one model can be y-up
          // and the next z-up. One axis for the whole run lays half of them down.
          upAxis: split.upAxis,
          // The original File rides along so the review list can show which
          // conversion a piece came from (two files can both fall back to
          // "Pieza 1") and so a one-piece file can be uploaded VERBATIM instead
          // of re-exported, exactly like the single-drop path does.
          sourceFile: file,
          sourceName: file.name,
        });
      }
    } catch (e) {
      failed.push({ name: file.name, error: e?.message || 'No se pudo leer el archivo.' });
    }
    done++;
  }

  return { THREE, pieces, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MESH PIPELINE — what the GLB carries so the CLIENT doesn't have to
//
// A pCon export is non-indexed float32 triangle soup with per-face normals, and
// every visitor paid for that twice: once on the wire (37 collection tiles =
// 26.6 MB, p90 1.4 MB) and once on the CPU, because `toCreasedNormals` — the
// single heaviest step of the model load — ran over every mesh of every model
// on every launch. Both costs belong to the FILE, not to the viewer, so they
// are paid ONCE here, at import, in the one order that composes:
//
//   CREASE → WELD → QUANTIZE
//
//   crease    `toCreasedNormals` at the SAME angle the loader used, so the
//             shading is the shading the catalogue has always had. It explodes
//             the mesh into loose triangles (toNonIndexed) on the way.
//   weld      `mergeVertices` merges vertices identical in position AND normal
//             (and uv), which re-indexes that soup while KEEPING the creased
//             edges split — the crease survives precisely because a hard edge's
//             two normals differ. Measured 77% fewer vertices on the real tiles.
//   quantize  POSITION as normalized int16, NORMAL as normalized int8
//             (KHR_mesh_quantization). three's GLTFExporter declares the
//             extension itself the moment it sees integer attributes and pads
//             each element to the 4-byte alignment the spec demands; its
//             GLTFLoader decodes them natively. That native decode is the whole
//             reason this and not Draco/meshopt — no decoder bundle to ship to
//             a visitor who is looking at a sofa.
//
// Measured on three real catalogue GLBs: −80%, −80% and −36% of vertex bytes
// (the last one already shipped indexed, so welding buys it nothing and
// quantization is its entire win).

// Signed-normalized ranges. glTF dequantizes SNORM as max(q/M, -1), so -M and
// -M-1 both decode to -1: clamping at ±M keeps the encoding one-to-one.
const SNORM16 = 32767;
const SNORM8 = 127;
const snorm = (v, m) => { const q = Math.round(v * m); return q > m ? m : (q < -m ? -m : q); };

/**
 * How far off its OWN origin a geometry may sit and still be quantized, as a
 * multiple of its own half-span. The bound is the precision invariant solved
 * for: an int16 step is `scale / 32767`, the invariant is 0.5 mm over a 2 m span
 * (1 part in 4000), so `scale ≤ 16 × halfSpan` keeps every vertex inside it.
 * Measured worst case on the real catalogue is 3.5 — a pCon export authors its
 * geometry local and carries the placement on the node. Anything past this
 * exports as floats and simply keeps the crease-and-weld win.
 */
const MAX_ORIGIN_RATIO = 16;

/**
 * Quantize one geometry IN PLACE; returns the uniform `scale` the exported node
 * must re-apply, or null when the geometry is outside the contract (which is not
 * a failure — it just exports as floats, exactly as before).
 *
 * glTF has no per-accessor scale, so the dequantization lives in the NODE
 * matrix. Two properties of that mapping are load-bearing, and both are about
 * `generateBoxUvs` (sceneBuilder), which box-projects the fabric UVs from
 * RAW LOCAL POSITIONS divided by the tile ÷ the node's own world scale:
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
function quantizeGeometry(THREE, geometry) {
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

/**
 * Crease + weld + quantize ONE geometry, off to the side.
 *
 * NEVER touches the source. `toCreasedNormals` MUTATES a non-indexed input, and
 * the scene's own meshes are still on screen behind the review list (a piece can
 * also be exported twice) — so it always runs on a clone. A geometry that can't
 * be baked still has to export: it comes back verbatim with `creased: false`,
 * which is what stops the GLB from claiming work it didn't get.
 */
function bakeGeometry(THREE, utils, source) {
  if (!utils?.toCreasedNormals || !utils?.mergeVertices || !source?.attributes?.position) {
    return { geometry: source, fit: null, creased: false };
  }
  let geometry;
  try {
    geometry = utils.mergeVertices(utils.toCreasedNormals(source.clone(), CREASE_ANGLE));
  } catch {
    return { geometry: source, fit: null, creased: false };
  }
  // THE POSITIONS THE SPLIT MUST SEE — snapshotted here, between the weld and
  // the quantization, because those two steps want opposite precisions.
  //
  // Quantizing to Int16 snorm lays every vertex on a grid sized by the mesh's
  // own extent, and TWO BODIES IN CONTACT then land on the SAME grid points:
  // measured on EXCLUSIF Lounge NoArm, whose M1 sits far enough off-origin that
  // the step is 0.157 mm — the seat pad and the back cushions rest on each
  // other, so the snap welded them into ONE component. splitSolids answered 2
  // solids on the exact coordinates and 1 on the quantized ones, `splitGeometry
  // BySolid` bailed at `< 2`, and the piece exported as a single 58 958-triangle
  // primitive that no tagging could ever take apart.
  //
  // Segmentation is a property of the GEOMETRY; quantization is a property of
  // the FILE. Running the classifier on lossy coordinates destroys exactly the
  // separation it exists to find, so the split reads these floats and the GLB
  // still stores the integers. The index buffer is untouched by quantization, so
  // a partition found here applies verbatim to the quantized geometry.
  const splitPositions = geometry.attributes?.position?.array
    ? Float32Array.from(geometry.attributes.position.array)
    : null;
  // A pure uniform scale — no rotation, no translation. That is the whole point
  // of anchoring at the origin (see quantizeGeometry): the node scales the
  // normalized positions back up and nothing else moves.
  const scale = quantizeGeometry(THREE, geometry);
  const fit = scale ? new THREE.Matrix4().makeScale(scale, scale, scale) : null;
  return { geometry, fit, creased: true, splitPositions };
}

/** Above this many masses a mesh is confetti (scan noise, exploded seams), and
 *  one primitive each would bloat the file and the draw calls for nothing. The
 *  mesh then exports whole, exactly as before. A real sofa lands well under it. */
const MAX_SOLIDS_PER_MESH = 64;

/**
 * Freeze a node's part key by giving its material a name. Unnamed materials key
 * by node index, so anything that changes the node count re-tags every part
 * after it. CLONED per node on purpose: two nodes sharing one unnamed material
 * had two distinct keys (`#3`, `#5`), and naming the shared instance would
 * collapse them into one part.
 */
function pinnedMaterial(material, nodeIndex) {
  const first = Array.isArray(material) ? material[0] : material;
  if (!first) return material;
  if (first.name && String(first.name).trim()) return material;
  const clone = Array.isArray(material) ? material.map((mm) => mm.clone()) : first.clone();
  const target = Array.isArray(clone) ? clone[0] : clone;
  if (target) target.name = `#${nodeIndex}`;
  return clone;
}

/**
 * Triangle → material index, read off a geometry's DRAW GROUPS. `-1` marks a
 * triangle no group covers, which must stay uncovered: with a material array
 * three draws only what a group names, so inventing a group for it would make
 * geometry appear that the source never drew. Null when the geometry has no
 * groups at all (a single material — nothing to carry).
 */
function triangleMaterials(geometry, triCount) {
  const groups = geometry?.groups || [];
  if (!groups.length) return null;
  const out = new Int32Array(triCount).fill(-1);
  for (const g of groups) {
    const from = Math.max(0, Math.floor(g.start / 3));
    const to = Math.min(triCount, Math.floor((g.start + g.count) / 3));
    for (let t = from; t < to; t += 1) out[t] = Number(g.materialIndex) || 0;
  }
  return out;
}

/** One geometry holding only `triangles`, with its own compacted vertices.
 *  Compacting is the point: sharing the parent's attribute buffers would write
 *  the WHOLE vertex array into every primitive and multiply the file by the
 *  number of masses. Attribute types and the `normalized` flag are preserved, so
 *  a quantized geometry stays quantized.
 *
 *  `matOfTri` carries the parent's MATERIAL ASSIGNMENT across the split. The
 *  solid's triangles are emitted material by material so each run is one
 *  contiguous draw group, and the group keeps the PARENT's `materialIndex` —
 *  the caller hands every sub-mesh the same material array, so an index that
 *  was right before the split is still right after it, with no remapping to get
 *  wrong. Triangle order inside a primitive is not observable (the classifier
 *  already sorts), so grouping them costs nothing. */
function subGeometry(THREE, geometry, triangles, indexAt, matOfTri = null) {
  const remap = new Map();
  const order = [];
  const index = new Uint32Array(triangles.length * 3);
  let at = 0;
  // Uncovered triangles (-1) sort LAST and emit no group, exactly as they drew
  // before. Ordinal is the tie-break, so the output stays deterministic.
  const rank = (t) => (matOfTri[t] < 0 ? Number.MAX_SAFE_INTEGER : matOfTri[t]);
  const ordered = matOfTri
    ? [...triangles].sort((a, b) => (rank(a) - rank(b)) || (a - b))
    : triangles;
  const groups = [];
  let runMat = -1;
  let runStart = 0;
  for (const t of ordered) {
    const mat = matOfTri ? matOfTri[t] : -1;
    if (matOfTri && mat !== runMat) {
      if (runMat >= 0) groups.push([runStart, at - runStart, runMat]);
      runMat = mat; runStart = at;
    }
    for (let k = 0; k < 3; k += 1) {
      const v = indexAt(t * 3 + k);
      let n = remap.get(v);
      if (n === undefined) { n = order.length; remap.set(v, n); order.push(v); }
      index[at] = n; at += 1;
    }
  }
  if (runMat >= 0) groups.push([runStart, at - runStart, runMat]);
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes || {})) {
    const size = attr.itemSize;
    const arr = new attr.array.constructor(order.length * size);
    for (let i = 0; i < order.length; i += 1) {
      const src = order[i] * size;
      for (let c = 0; c < size; c += 1) arr[i * size + c] = attr.array[src + c];
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size, attr.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  for (const [start, count, materialIndex] of groups) out.addGroup(start, count, materialIndex);
  return out;
}

/**
 * Split a baked geometry into its SOLID MASSES — the reason «Detectar partes»
 * can offer a cushion instead of a scatter of shreds. Every consumer downstream
 * (the tagger, the raycast, the selection outline) already works per MESH, so
 * making one mesh BE one mass is the whole integration: nothing else changes.
 *
 * Runs AFTER crease/weld/quantize so all masses share the node's dequantization
 * fit. It reads the EXACT positions the caller snapshotted before quantization
 * (`bakeGeometry.splitPositions`), never the stored integers: the old claim that
 * "integers segment exactly like floats" is false wherever two bodies TOUCH —
 * the Int16 grid snaps both contact surfaces onto the same points and welds them
 * into one component. That is what fused a seat pad to its back cushions.
 *
 * MULTI-MATERIAL MESHES SPLIT TOO, and that is the whole point of this pass
 * existing for the dealer's catalogue. This used to bail on any geometry with
 * more than one draw group — and the Ligne Roset 3DS library ships EVERY
 * product as ONE authored mesh carrying several materials, so the topological
 * classifier never ran on a single one of them. Parts fell back to MATERIAL
 * GROUPS, which are an authoring artifact and not bodies: on the EXCLUSIF
 * lounge chair, `Ligne_Roset_Excl` spans the frame AND the seat cushion (two
 * separate closed bodies fused into one part), `Ligne_Roset_E4` spans all four
 * legs, and `Ligne_Roset_E3` is a 2-triangle ground-shadow quad that became a
 * "part" of its own. The material assignment now rides ACROSS the split
 * (`triangleMaterials` → per-solid draw groups), so nothing is lost by
 * splitting and a body is a body whatever it is painted with.
 *
 * Still bails on morph targets, where a per-mass index would lose the morph.
 */
export async function splitGeometryBySolid(THREE, geometry, positions = null) {
  const pos = geometry?.attributes?.position;
  if (!pos?.array) return [geometry];
  if (Object.keys(geometry.morphAttributes || {}).length) return [geometry];
  // `positions` are the EXACT (pre-quantization) coordinates when the caller
  // kept them — see bakeGeometry. Falling back to the stored array keeps every
  // other caller working, at the old precision.
  const forSplit = positions && positions.length === pos.array.length ? positions : pos.array;
  let solids;
  try {
    ({ solids } = await splitSolidsOffThread(forSplit, geometry.index?.array || null));
  } catch { return [geometry]; }
  if (solids.length < 2 || solids.length > MAX_SOLIDS_PER_MESH) return [geometry];
  const index = geometry.index?.array || null;
  const indexAt = index ? (i) => index[i] : (i) => i;
  const triCount = Math.floor((index ? index.length : pos.count) / 3);
  const matOfTri = triangleMaterials(geometry, triCount);
  return solids.map((s) => subGeometry(THREE, geometry, s.triangles, indexAt, matOfTri));
}

// ── The classifier runs OFF THE MAIN THREAD. It is the heaviest pure-math step
// of the pipeline (weld grid + edge topology over hundreds of thousands of
// vertices), and it used to run on the UI thread — with the automatic batch
// draining three models at once, that is exactly the freeze the dealer felt
// while «Preparando mallas» ran. One worker, lazily spawned, shared by every
// caller: splits are memory-hungry, so serializing them in ONE thread bounds
// peak memory while the UI thread stays free — the parallelism that matters is
// UI vs math, not math vs math.
let splitWorker = null;
let splitSeq = 0;
const splitPending = new Map();   // id → {resolve, reject}

function splitWorkerInstance() {
  if (splitWorker) return splitWorker;
  splitWorker = new Worker(new URL('../../lib/configurator/solidSplit.worker.js', import.meta.url), { type: 'module' });
  splitWorker.onmessage = (e) => {
    const p = splitPending.get(e.data?.id);
    if (!p) return;
    splitPending.delete(e.data.id);
    if (e.data.ok) p.resolve({ solids: e.data.solids });
    else p.reject(new Error(e.data.error || 'split worker'));
  };
  splitWorker.onerror = () => {
    // A dead worker answers nobody: fail everything in flight (each caller
    // falls back inline) and let the next call spawn a fresh worker.
    const pending = [...splitPending.values()];
    splitPending.clear();
    try { splitWorker.terminate(); } catch { /* already gone */ }
    splitWorker = null;
    for (const p of pending) p.reject(new Error('split worker crashed'));
  };
  return splitWorker;
}

/**
 * `splitSolids`, off-thread when the platform allows it, inline when it
 * doesn't (node tests, ancient WebViews) or when the worker dies mid-flight.
 *
 * The buffers are COPIED before posting (slice) and the copies TRANSFERRED —
 * zero-clone across the thread, while the geometry's own arrays stay attached
 * for the inline fallback and for `subGeometry` afterwards. Never transfer the
 * live arrays themselves: a transferred buffer is detached, and a crashed
 * worker would leave the geometry unreadable.
 */
async function splitSolidsOffThread(positions, indices) {
  if (typeof Worker === 'undefined') return splitSolids({ positions, indices });
  try {
    const posCopy = positions.slice();
    const idxCopy = indices ? indices.slice() : null;
    const id = ++splitSeq;
    const w = splitWorkerInstance();
    const out = new Promise((resolve, reject) => splitPending.set(id, { resolve, reject }));
    const transfers = [posCopy.buffer];
    if (idxCopy) transfers.push(idxCopy.buffer);
    w.postMessage({ id, positions: posCopy, indices: idxCopy }, transfers);
    return await out;
  } catch {
    return splitSolids({ positions, indices });
  }
}

// A GLB is a 12-byte header (magic, version, total length) followed by chunks,
// each an 8-byte header (length, type) plus its padded payload. The JSON chunk
// comes first and is the only one we ever touch.
const GLB_MAGIC = 0x46546c67;      // 'glTF', little-endian
const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'

/** The chunk table of a GLB buffer, or null if it isn't one. */
function glbChunks(buffer) {
  if (!buffer || buffer.byteLength < 20) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) return null;
  const total = Math.min(view.getUint32(8, true), buffer.byteLength);
  const chunks = [];
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

/** Whether a GLB carries any texture images — the guard that keeps the
 *  heal-from-source path away from models whose baked sidecar bitmaps a bare
 *  re-import would lose. Same cheap JSON-chunk read as the version. */
function glbHasImages(buffer) {
  const json = glbChunks(buffer)?.find((c) => c.type === GLB_CHUNK_JSON);
  if (!json) return false;
  try {
    const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, json.start, json.length)));
    return (doc?.images?.length || 0) > 0;
  } catch { return false; }
}

/**
 * The mesh-pipeline version a GLB's bytes declare — 0 for anything we didn't
 * write. Reading it off the JSON chunk (rather than parsing the model) is what
 * lets the batch decide "already done" for the price of a `fetch`.
 */
export function readGlbMeshVersion(buffer) {
  const json = glbChunks(buffer)?.find((c) => c.type === GLB_CHUNK_JSON);
  if (!json) return 0;
  try {
    const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, json.start, json.length)));
    return Number(doc?.asset?.extras?.alcoverMeshV) || 0;
  } catch { return 0; }
}

/**
 * Stamp `asset.extras` onto an exported GLB. GLTFExporter owns `asset` and
 * offers no hook into it, and the marker has to sit somewhere any glTF reader
 * can find it (not in a node's userData, which is an implementation detail of
 * how we happen to wrap the group) — so the JSON chunk is rewritten and the
 * container rebuilt around it. The BIN chunk is copied byte for byte; only the
 * JSON chunk's length and the file total change.
 */
function stampGlbAsset(buffer, extras) {
  const chunks = glbChunks(buffer);
  const jsonChunk = chunks?.find((c) => c.type === GLB_CHUNK_JSON);
  if (!jsonChunk) return buffer;   // not a container we recognise — ship it unmarked
  let doc;
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

/**
 * Re-export one piece's meshes as a self-contained binary GLB Blob. World
 * transforms are baked onto each clone, so the piece carries exactly the
 * geometry it had in the scene (the configurator recentres on load anyway).
 *
 * INVARIANT — MATERIAL NAMES SURVIVE THE ROUND TRIP. Each clone reuses the
 * SOURCE material object by reference (never a substitute or a re-created one),
 * because GLTFExporter copies `material.name` straight into the GLB's
 * `materials[].name`, and the part tagger keys every mesh part by that name
 * (lib/configurator/meshParts.js `partKeyFor` — pCon gives a part type one material id
 * across a whole collection and no node names at all). Swap in a fresh material
 * here and the re-imported GLB is one anonymous blob: "Detectar partes" can no
 * longer tell a cushion from a bolster, and per-part fabric pricing dies with it.
 *
 * Reusing the source material is also what BAKES a bundled finish in: a binary
 * GLB embeds its images, so a material carrying a decoded map exports as a
 * self-contained texture — nothing to store beside the mesh, nothing to resolve
 * at render time. `bakeBundledMaps` has already bounded and re-mimed those
 * images; this call is where they become bytes.
 *
 * The GEOMETRY goes through the mesh pipeline above (crease → weld → quantize)
 * and the file says so, so the loader can skip the runtime crease. Materials,
 * textures and UVs are untouched by all of it.
 */
export async function exportPieceGlb(THREE, meshes) {
  const [{ GLTFExporter }, utils] = await Promise.all([
    safeDynamicImport(() => import('three/examples/jsm/exporters/GLTFExporter.js')),
    safeDynamicImport(() => import('three/examples/jsm/utils/BufferGeometryUtils.js')).catch(() => null),
  ]);
  const group = new THREE.Group();
  // ONE bake per SOURCE geometry, not per node: a pCon scene places the same
  // buffer many times (an eight-module sofa is one cushion mesh over and over),
  // and GLTFExporter dedups meshes by geometry IDENTITY — bake per node and the
  // GLB carries eight copies of the same cushion.
  const baked = new Map();
  // Whether EVERY mesh actually came through the pipeline. A GLB that claimed
  // baked normals it never got would ship the catalogue's flat-shaded soup to
  // every visitor, with the loader's own creasing switched off — so the stamp
  // is all-or-nothing.
  let creased = meshes.length > 0;
  for (const [nodeIndex, m] of meshes.entries()) {
    let entry = baked.get(m.geometry);
    if (!entry) { entry = bakeGeometry(THREE, utils, m.geometry); baked.set(m.geometry, entry); }
    if (!entry.creased) creased = false;
    // PIN THE PART KEY BEFORE SPLITTING. An unnamed material keys its part by
    // NODE INDEX (`partKeyFor`), and emitting one node per solid renumbers every
    // node after the first split — which would silently re-tag a cushion as a
    // bolster across the whole catalogue. Naming the material after the node it
    // came from freezes the key, so the split is additive: what the dealer
    // already tagged keeps its key and the new masses arrive as `key~2`, `key~3`.
    const material = pinnedMaterial(m.material, nodeIndex);
    // The PROMISE is what's cached, not the result: an eight-module sofa reuses
    // one cushion geometry across nodes, and caching the settled value only
    // would let the second node kick off a duplicate split before the first
    // resolves.
    if (!entry.pieces) entry.pieces = splitGeometryBySolid(THREE, entry.geometry, entry.splitPositions);
    for (const geometry of await entry.pieces) {
      const c = new THREE.Mesh(geometry, material);
      c.matrixAutoUpdate = false;
      // The node carries the world transform it always did, now composed with the
      // dequantization fit — the exporter writes the composed matrix verbatim.
      c.matrix.copy(m.matrixWorld);
      if (entry.fit) c.matrix.multiply(entry.fit);
      group.add(c);
    }
  }
  const buffer = await new GLTFExporter().parseAsync(group, { binary: true });
  const stamped = creased ? stampGlbAsset(buffer, { alcoverMeshV: ALCOVER_MESH_V }) : buffer;
  return new Blob([stamped], { type: 'model/gltf-binary' });
}

/**
 * Whether a stored `mesh_url` can go through `optimizeGlbUrl`. GLB only: a row
 * still serving a raw .fbx/.obj (a multi-piece drop uploads the file verbatim)
 * carries no stamp to read, so the batch would re-convert it on every run. ONE
 * rule, so the button's count and the run itself can never disagree about which
 * models the batch is even about.
 */
export const isOptimizableMeshUrl = (url) => /\.(glb|gltf)(\?|$)/i.test(String(url || ''));

/**
 * Re-export one ALREADY-PUBLISHED GLB through the current mesh pipeline — the
 * per-model unit of «Optimizar mallas», which is how the 605 meshes ingested
 * before the pipeline existed get the same treatment as a fresh import.
 *
 * Idempotent by the file's own stamp: a GLB already at ALCOVER_MESH_V comes back
 * `skipped` for the price of the download, so re-running the batch costs
 * bandwidth and nothing else. Deliberately NOT routed through `loadConfiguratorModels`:
 * that one strips label/shadow meshes and creases, and re-exporting a stripped
 * scene would silently drop nodes AND renumber the rest — the parts tagging
 * keys unnamed materials by node index (`partKeyFor`), so a shifted index is a
 * cushion re-tagged as a bolster. This reads the file exactly as it is.
 *
 * @returns {Promise<{ skipped: boolean, before: number, after: number, file: File|null }>}
 */
export async function optimizeGlbUrl(url, { name = 'modelo', sourceUrl = null } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar (${res.status}).`);
  const buffer = await res.arrayBuffer();
  const before = buffer.byteLength;
  if (readGlbMeshVersion(buffer) >= ALCOVER_MESH_V) return { skipped: true, before, after: before, file: null };
  // ── HEAL FROM THE SOURCE when we can. A GLB already split by an OLDER
  // pipeline has its authored meshes torn into per-solid nodes, and node-wise
  // re-export can only ever split further — a tear baked in by one version
  // would survive every later one. The row keeps the original upload
  // (`mesh_source_url`), so the honest re-export is a re-IMPORT: same path as
  // a fresh drop, current splitter, pristine authored structure. Gated to
  // texture-less served files (the LR 3DS library — flat COL* colors): a
  // textured GLB carries baked sidecar bitmaps a bare source re-import would
  // lose, so those keep the node-wise path below.
  if (sourceUrl && !glbHasImages(buffer) && MODEL_EXT_RE.test(String(sourceUrl).split('?')[0])) {
    try {
      const srcRes = await fetch(sourceUrl);
      if (srcRes.ok) {
        const srcName = String(sourceUrl).split('?')[0].split('/').pop() || 'source.3ds';
        const file = new File([await srcRes.arrayBuffer()], srcName);
        const { THREE: T2, object: src } = await loadSceneFile(file);
        const split = splitScene(T2, src);
        // One piece = this row's own model. A multi-piece source is a batch
        // scene shared by several rows — never re-cluster it against one row.
        if (split.pieces.length === 1) {
          const blob2 = await exportPieceGlb(T2, split.pieces[0].meshes);
          const slug2 = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'modelo';
          return { skipped: false, before, after: blob2.size, file: new File([blob2], `${slug2}.glb`, { type: 'model/gltf-binary' }) };
        }
      }
    } catch { /* the served file still re-exports below — slower, never stuck */ }
  }
  const THREE = await safeDynamicImport(() => import('three'));
  const loader = await loaderFor('glb');
  const object = normalizeLoaded('glb', await loader.parseAsync(buffer, ''));
  if (!object) throw new Error('El archivo no se pudo leer.');
  object.updateMatrixWorld(true);
  // Depth-first, the same order every consumer traverses in — so the flattened
  // export hands the node-index fallback back the sequence it had.
  const meshes = [];
  object.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
  if (!meshes.length) throw new Error('El archivo no trae geometría.');
  const blob = await exportPieceGlb(THREE, meshes);
  const slug = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'modelo';
  return {
    skipped: false,
    before,
    after: blob.size,
    file: new File([blob], `${slug}.glb`, { type: 'model/gltf-binary' }),
  };
}
