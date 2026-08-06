/**
 * Shared loader for REAL Togo models (pCon / dealer exports — GLB/OBJ/FBX/DAE/3DS).
 * ONE implementation behind BOTH the configurator stage (TogoStage) and the WebAR
 * export (TogoArViewer), so AR places the SAME real meshes the preview shows —
 * not the procedural fallback. The three.js loaders are code-split via
 * `safeDynamicImport`, so a scene with no real models pulls in no loader at all.
 */
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { stripLabelMeshes, stripShadowMeshes } from '../../lib/togo/meshClean.js';
import { glbForPiece } from '../../assets/togo/togoModels3d.js';

/** File extension of a model URL (query-stripped, lowercased). */
export const extOf = (url) => String(url || '').split('?')[0].split('.').pop().toLowerCase();

/**
 * The smoothing angle every real model is shaded at — 60°.
 *
 * ONE constant, because the work now happens at two moments: the import
 * pipeline BAKES it into the GLB (`sceneImport.exportPieceGlb`) and this loader
 * applies it to everything older than that. Two literals would mean a piece
 * shades differently depending on which path produced its file.
 */
export const CREASE_ANGLE = Math.PI / 3;

/**
 * The mesh-pipeline stamp a GLB written by `exportPieceGlb` carries in its
 * glTF `asset.extras`. It is a claim about what is ALREADY DONE in the file:
 * v2 = normals creased at CREASE_ANGLE, vertices welded, POSITION/NORMAL
 * quantized. Bump it only when that contract changes — an old file simply
 * reports a lower version and keeps taking the runtime path it always took.
 *
 * v3 = v2 plus SOLID SPLITTING: each mesh is emitted one primitive per connected
 * mass, and unnamed materials are named after their source node so the part keys
 * survive the renumbering. This is what lets the tagger and the selection
 * outline address a cushion instead of every shred sharing its fabric. A v2 file
 * still renders identically — it just cannot offer the parts, so the whole
 * catalogue reads as re-optimizable until the dealer runs the batch.
 *
 * v4 = v3 with the split now TOPOLOGICAL (lib/togo/solidSplit): a part must be a
 * self-contained BODY — mostly-closed surface (2-manifold rim ≤ 25%) that either
 * encloses volume for its size (Wadell sphericity^{3/2} ≥ 0.12) or fills its own
 * bounding box (slabs, rods). Open bands, zipper flaps and wrap-around piping
 * stop being selectable "parts" and fold into the body they hug; closed little
 * legs stay parts. v3 files still render — bumping the version is what makes the
 * automatic pass re-export them through the classifier.
 *
 * v5 = v4 recalibrated against the dealer's own production files (EXCLUSIF
 * autopsy 2026-08): the LR 3DS library's open shells earn part-hood by
 * STRUCTURAL SHARE (≥15% of the mesh) since closedness never holds there;
 * mid-size fragments fold back into the surface they broke off, which is what
 * ended the "cojín en parchos" regression.
 *
 * v6 = v5 with connectivity back on WELDED VERTICES: v5's face graph (whole
 * shared edges only) tore LR's T-junction tessellation apart — the gd canapé's
 * seat split into two ≥15% halves and rendered as a striped cushion. Vertex
 * welding heals those tears; per authored mesh that is the right granularity.
 *
 * v7 = the split is TOPOLOGY ONLY, and it finally runs on the catalogue.
 * Through v6 `splitGeometryBySolid` bailed on any multi-material mesh, and the
 * LR 3DS library ships every product as ONE mesh with several materials — so no
 * LR model was ever segmented by topology at all; its "parts" were its MATERIAL
 * GROUPS. That is why solid bodies read as broken up: a material boundary is an
 * authoring artifact, not a body boundary. Materials now ride across the split
 * as per-solid draw groups, and part-hood dropped its open-shell escape hatch
 * (v5's ≥15%-of-area clause) — a part is a CLOSED body or it is dressing folded
 * into the body it hugs. Measured on the dealer's EXCLUSIF lounge chair: eight
 * closed bodies (frame, seat cushion, back pillow, backrest pad, four legs)
 * where the material fallback offered five wrong ones.
 */
export const ALCOVER_MESH_V = 7;

/** The pipeline version a PARSED glTF declares — 0 for anything we didn't
 *  write (every pCon export, every catalogue GLB predating the pipeline). */
export const meshVersionOf = (parsed) => Number(parsed?.asset?.extras?.alcoverMeshV) || 0;

/** The three.js loader for a model extension, imported on demand. pCon exports
 *  OBJ/FBX/3DS/DAE; GLB/glTF for anything authored web-side. */
export async function loaderFor(ext) {
  switch (ext) {
    case 'glb': case 'gltf': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/GLTFLoader.js')); return new m.GLTFLoader(); }
    case 'obj': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/OBJLoader.js')); return new m.OBJLoader(); }
    case 'fbx': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/FBXLoader.js')); return new m.FBXLoader(); }
    case 'dae': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/ColladaLoader.js')); return new m.ColladaLoader(); }
    case '3ds': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/TDSLoader.js')); return new m.TDSLoader(); }
    default: return null;
  }
}

/** glTF/Collada return a wrapper with `.scene`; OBJ/FBX/3DS return the Object3D. */
export const normalizeLoaded = (ext, res) => ((ext === 'glb' || ext === 'gltf' || ext === 'dae') ? (res.scene || res.scenes?.[0] || res) : res);

/** A piece's model descriptor: a dealer-uploaded mesh (Storage) wins over the
 *  static manifest. Returns `{ url, upAxis?, rotateY?, scale? }` or null. */
export const descForPiece = (p) => ((p && p.mesh && p.mesh.url) ? p.mesh : glbForPiece(p));

/**
 * Load every DISTINCT real model in a scene into `cache` (Map<url, {object, desc}>),
 * reusing whatever's already cached (so re-builds don't reload, and two pieces
 * sharing a model load it once). A missing/unreadable model is skipped → that
 * piece falls back to procedural geometry. Returns `{ cache, modelFor }`, where
 * `modelFor(piece)` is the selector `buildTogoGroup` expects.
 */
/**
 * ONE parsed model per URL, for the whole session, shared by every renderer.
 *
 * A loaded model is CPU-side geometry; WebGL uploads it per context on first
 * draw, and `buildTogoGroup` clones it before touching anything, so the same
 * parsed object can safely dress the live stage, the offscreen thumbnail
 * renderer and the launch card's turntable at once. They each used to keep a
 * private cache, which meant the same FBX was fetched, parsed, label-stripped
 * and re-creased up to three times — and `toCreasedNormals` over a real
 * upholstery mesh is the single heaviest step in the load. Placing a piece
 * whose thumbnail had just been rendered did all of that work again.
 *
 * Deliberately not evicted: it is bounded by the catalogue, and the thumbnail
 * path already held exactly this much for the session. Anything that DOES want
 * to free its meshes (the AR viewer and the OBJ/GLB downloads — short-lived,
 * phone memory budget) passes its own private Map and disposes THAT; disposing
 * the shared cache mid-session guts the live stage and the thumbnail rig.
 */
const sharedModelCache = new Map();

export async function loadTogoModels(scene3d, cache = sharedModelCache) {
  const descByUrl = new Map();
  for (const p of (scene3d?.pieces || [])) {
    const d = descForPiece(p);
    if (d?.url) descByUrl.set(d.url, d);
  }
  await Promise.all([...descByUrl.values()].map(async (desc) => {
    if (cache.has(desc.url)) return;
    const ext = extOf(desc.url);
    try {
      const loader = await loaderFor(ext);
      if (!loader) return;
      const parsed = await loader.loadAsync(desc.url);
      const object = normalizeLoaded(ext, parsed);
      if (object) {
        const THREE = await safeDynamicImport(() => import('three'));
        stripLabelMeshes(THREE, object);    // drop baked-in text labels
        stripShadowMeshes(THREE, object);   // drop pCon ground-shadow decals
        // SMOOTH the shading the way pCon itself does: CAD viewers recompute
        // normals with a SMOOTHING ANGLE at render time, but the exports
        // carry flat per-face normals — rendered verbatim, the same file
        // that looks silky in pCon shades as faceted patches here ("mine
        // just looks off"). toCreasedNormals rebuilds vertex normals shared
        // across faces meeting under 60° (upholstery folds smooth out) while
        // edges sharper than that (platform corners) stay crisp.
        //
        // SKIPPED for a file that already carries them: this is the heaviest
        // step of the whole load, it is a property of the GEOMETRY and not of
        // the viewer, and a GLB written by the import pipeline has it baked in
        // (ALCOVER_MESH_V). Every OLDER file — which is the whole catalogue
        // until the dealer runs «Optimizar mallas» — reports version 0 and
        // takes exactly the path it always took.
        if (meshVersionOf(parsed) < ALCOVER_MESH_V) {
          try {
            const { toCreasedNormals } = await safeDynamicImport(() => import('three/examples/jsm/utils/BufferGeometryUtils.js'));
            object.traverse((o) => {
              if (o.isMesh && o.geometry?.attributes?.position) {
                const smoothed = toCreasedNormals(o.geometry, CREASE_ANGLE);
                o.geometry.dispose();
                o.geometry = smoothed;
              }
            });
          } catch { /* smoothing is an enhancement — the raw normals still render */ }
        }
        cache.set(desc.url, { object, desc });
      }
    } catch { /* missing/unreadable → procedural */ }
  }));
  const modelFor = (piece) => { const d = descForPiece(piece); return d ? (cache.get(d.url) || null) : null; };
  return { cache, modelFor };
}

/**
 * Start fetching and parsing the 3D engine NOW, before anything asks for it.
 *
 * three.js is ~730 KB of JavaScript (190 KB over the wire) and its module
 * evaluation alone is the largest single item in the configurator's boot —
 * measured at 526 ms against the real modules, ahead of the environment
 * pre-filter at 144 ms. Nothing used to request it until a 3D surface actually
 * mounted, which is only after the catalog round-trip has resolved: two
 * independent costs, one a network wait and one pure CPU, run strictly back to
 * back when they could overlap almost completely.
 *
 * Idempotent, and deliberately fire-and-forget — a failure here is not an error,
 * it just means the real `safeDynamicImport` call later does the work (and owns
 * the stale-deploy reload) exactly as it did before.
 *
 * NOT for the embed launch card. That one is a guest on a dealer's home page and
 * boots only when it scrolls into view; downloading an engine for a visitor who
 * never reaches it is the opposite of what it promises.
 */
let enginePrewarm = null;
export function prewarmTogoEngine() {
  if (enginePrewarm) return enginePrewarm;
  enginePrewarm = Promise.all([
    safeDynamicImport(() => import('three')),
    safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
    safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
  ]).catch(() => null);
  return enginePrewarm;
}
