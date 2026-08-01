/**
 * Shared loader for REAL models (pCon / dealer exports — GLB/OBJ/FBX/DAE/3DS).
 * ONE implementation behind every 3D surface (the configurator stage, a WebAR
 * export, an offscreen thumbnail rig), so AR places the SAME real meshes the
 * preview shows — never a fallback the preview never drew.
 *
 * The three.js LOADERS are injected. They are the heaviest thing in the graph
 * and a scene with no real models must pull in none of them, so the caller owns
 * the dynamic import (in the app that means the code-split helper that recovers
 * from a stale deploy). `LOADER_MODULES` below is the format→loader table it
 * needs; wiring it is four lines and it stays a caller concern.
 */
import { cleanMeshNodes } from '@veta/geometry';
import type { LoadedModel, ModelDescriptor, ScenePiece, ThreeApi, ThreeObject } from './types.ts';

/** File extension of a model URL (query-stripped, lowercased). */
export const extOf = (url: string | null | undefined): string =>
  String(url || '').split('?')[0].split('.').pop()!.toLowerCase();

/**
 * The smoothing angle every real model is shaded at — 60°.
 *
 * ONE constant, because the work happens at two moments: an import pipeline
 * BAKES it into the GLB and this loader applies it to everything older than
 * that. Two literals would mean a piece shades differently depending on which
 * path produced its file.
 */
export const CREASE_ANGLE = Math.PI / 3;

/**
 * The mesh-pipeline stamp a GLB written by the import pipeline carries in its
 * glTF `asset.extras`. It is a claim about what is ALREADY DONE in the file:
 * v2 = normals creased at CREASE_ANGLE, vertices welded, POSITION/NORMAL
 * quantized. Bump it only when that contract changes — an old file simply
 * reports a lower version and keeps taking the runtime path it always took.
 *
 * NOTE (Phase 0): the stamp is WRITTEN by `@veta/mesh-pipeline` (`MESH_VERSION`,
 * `stampMeshVersion`). The READER is duplicated here — two lines — rather than
 * imported, because the loader must be able to answer "is this already creased?"
 * without pulling the writer's whole graph in: a viewer that never exports a
 * mesh should not load the exporter. Keep the number in lockstep with the
 * pipeline's, or inject the pipeline's own reader (`LoadModelsDeps.meshVersionOf`)
 * and this copy stops being load-bearing.
 */
export const ALCOVER_MESH_V = 2;

/** The legacy stamp key. `@veta/mesh-pipeline` owns the canonical name; this is
 *  the one every already-optimized file in the fleet carries. */
export const LEGACY_MESH_VERSION_KEY = 'alcoverMeshV';

/** The pipeline version a PARSED glTF declares — 0 for anything we didn't
 *  write (every pCon export, every catalogue GLB predating the pipeline). */
export const meshVersionOf = (parsed: any): number =>
  Number(parsed?.asset?.extras?.[LEGACY_MESH_VERSION_KEY]) || 0;

/**
 * THE FORMAT TABLE: extension → the three.js addon module and the export inside
 * it. pCon exports OBJ/FBX/3DS/DAE; GLB/glTF for anything authored web-side.
 * Data, not code, so the caller can import each module however its bundler
 * wants (and skip the ones its scenes never use).
 */
export const LOADER_MODULES: Readonly<Record<string, { module: string; export: string }>> = Object.freeze({
  glb: { module: 'three/examples/jsm/loaders/GLTFLoader.js', export: 'GLTFLoader' },
  gltf: { module: 'three/examples/jsm/loaders/GLTFLoader.js', export: 'GLTFLoader' },
  obj: { module: 'three/examples/jsm/loaders/OBJLoader.js', export: 'OBJLoader' },
  fbx: { module: 'three/examples/jsm/loaders/FBXLoader.js', export: 'FBXLoader' },
  dae: { module: 'three/examples/jsm/loaders/ColladaLoader.js', export: 'ColladaLoader' },
  '3ds': { module: 'three/examples/jsm/loaders/TDSLoader.js', export: 'TDSLoader' },
});

/** Whether a format is loadable at all (no loader ⇒ the piece takes the fallback). */
export const isLoadableFormat = (ext: string): boolean => Object.hasOwn(LOADER_MODULES, ext);

/** glTF/Collada return a wrapper with `.scene`; OBJ/FBX/3DS return the Object3D. */
export const normalizeLoaded = (ext: string, res: any): ThreeObject =>
  ((ext === 'glb' || ext === 'gltf' || ext === 'dae') ? (res.scene || res.scenes?.[0] || res) : res);

/** A three loader instance — anything with `loadAsync`. */
export interface ModelLoaderLike { loadAsync(url: string): Promise<any> }

/** What `loadModels` needs from the outside world. */
export interface LoadModelsDeps {
  /** The three namespace, for the clean/crease passes. */
  THREE: ThreeApi;
  /** Build (or reuse) a loader for an extension; null ⇒ skip the piece. */
  loaderFor: (ext: string) => Promise<ModelLoaderLike | null> | ModelLoaderLike | null;
  /** A piece's model descriptor — a dealer upload beats a static manifest. */
  descFor: (piece: ScenePiece) => ModelDescriptor | null | undefined;
  /**
   * Drop the nodes that are not geometry: baked-in text labels and pCon's own
   * ground-shadow decals. Defaults to `@veta/geometry`'s `cleanMeshNodes`; pass
   * a no-op to render an export exactly as authored, decals included.
   */
  clean?: (THREE: ThreeApi, object: ThreeObject) => void;
  /**
   * `toCreasedNormals` from three's BufferGeometryUtils. Optional: smoothing is
   * an ENHANCEMENT — the raw normals still render.
   */
  toCreasedNormals?: (geometry: any, angle: number) => any;
  /**
   * `@veta/mesh-pipeline`'s stamp reader. Optional — the local `meshVersionOf`
   * is the fallback, and injecting the pipeline's keeps ONE definition of "this
   * file is already creased" once the two are wired together.
   */
  meshVersionOf?: (parsed: any) => number;
  /** The version the injected reader must reach for the crease pass to be
   *  skipped. Defaults to `ALCOVER_MESH_V`. */
  meshVersionRequired?: number;
}

/**
 * ONE parsed model per URL, for the whole session, shared by every renderer.
 *
 * A loaded model is CPU-side geometry; WebGL uploads it per context on first
 * draw, and `buildSceneGroup` clones it before touching anything, so the same
 * parsed object can safely dress the live stage, an offscreen thumbnail renderer
 * and a turntable at once. They each used to keep a private cache, which meant
 * the same FBX was fetched, parsed, label-stripped and re-creased up to three
 * times — and `toCreasedNormals` over a real upholstery mesh is the single
 * heaviest step in the load. Placing a piece whose thumbnail had just been
 * rendered did all of that work again.
 *
 * Deliberately not evicted: it is bounded by the catalogue, and the thumbnail
 * path already held exactly this much for the session. Anything that DOES want
 * to free its meshes (an AR viewer, a one-off download — short-lived, phone
 * memory budget) passes its OWN private Map and disposes THAT; disposing the
 * shared cache mid-session guts the live stage and the thumbnail rig.
 */
export const sharedModelCache = new Map<string, LoadedModel>();

/**
 * Load every DISTINCT real model in a scene into `cache` (Map<url, {object,
 * desc}>), reusing whatever's already cached (so re-builds don't reload, and two
 * pieces sharing a model load it once). A missing/unreadable model is skipped →
 * that piece falls back to the placeholder. Returns `{ cache, modelFor }`, where
 * `modelFor(piece)` is the selector `buildSceneGroup` expects.
 */
export async function loadModels(
  scene3d: { pieces?: ScenePiece[] | null } | null | undefined,
  deps: LoadModelsDeps,
  cache: Map<string, LoadedModel> = sharedModelCache,
): Promise<{ cache: Map<string, LoadedModel>; modelFor: (piece: ScenePiece) => LoadedModel | null }> {
  const { THREE, loaderFor, descFor, toCreasedNormals } = deps;
  const clean = deps.clean ?? ((T: ThreeApi, o: ThreeObject) => { cleanMeshNodes(T as any, o); });
  const versionOf = deps.meshVersionOf || meshVersionOf;
  const versionRequired = Number(deps.meshVersionRequired) || ALCOVER_MESH_V;
  const descByUrl = new Map<string, ModelDescriptor>();
  for (const p of (scene3d?.pieces || [])) {
    const d = descFor(p);
    if (d?.url) descByUrl.set(d.url, d);
  }
  await Promise.all([...descByUrl.values()].map(async (desc) => {
    const url = desc.url!;
    if (cache.has(url)) return;
    const ext = extOf(url);
    try {
      const loader = await loaderFor(ext);
      if (!loader) return;
      const parsed = await loader.loadAsync(url);
      const object = normalizeLoaded(ext, parsed);
      if (!object) return;
      clean(THREE, object);   // baked-in labels + pCon ground-shadow decals
      // SMOOTH the shading the way pCon itself does: CAD viewers recompute
      // normals with a SMOOTHING ANGLE at render time, but the exports carry
      // flat per-face normals — rendered verbatim, the same file that looks
      // silky in pCon shades as faceted patches here ("mine just looks off").
      // toCreasedNormals rebuilds vertex normals shared across faces meeting
      // under 60° (upholstery folds smooth out) while edges sharper than that
      // (platform corners) stay crisp.
      //
      // SKIPPED for a file that already carries them: this is the heaviest step
      // of the whole load, it is a property of the GEOMETRY and not of the
      // viewer, and a GLB written by the import pipeline has it baked in
      // (ALCOVER_MESH_V). Every OLDER file — the whole catalogue until the
      // dealer runs the optimizer — reports version 0 and takes exactly the
      // path it always took.
      if (toCreasedNormals && versionOf(parsed) < versionRequired) {
        try {
          object.traverse((o: any) => {
            if (o.isMesh && o.geometry?.attributes?.position) {
              const smoothed = toCreasedNormals(o.geometry, CREASE_ANGLE);
              o.geometry.dispose();
              o.geometry = smoothed;
            }
          });
        } catch { /* smoothing is an enhancement — the raw normals still render */ }
      }
      cache.set(url, { object, desc });
    } catch { /* missing/unreadable → the placeholder fallback */ }
  }));
  const modelFor = (piece: ScenePiece): LoadedModel | null => {
    const d = descFor(piece);
    return d?.url ? (cache.get(d.url) || null) : null;
  };
  return { cache, modelFor };
}
