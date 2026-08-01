/**
 * GLB export — the bridge from a live three.js scene to portable 3D formats
 * (GLB) so a configured piece can be launched into WebAR and, on iOS,
 * auto-converted to USDZ for AR Quick Look. three.js AND the exporter are
 * DEPENDENCY-INJECTED (same pattern as the rest of this package) so nothing here
 * carries a static `three` import and the whole path stays code-split — the AR
 * viewer loads three + the exporter only when a visitor taps AR.
 *
 * The export reuses `buildSceneGroup`, so the GLB is upholstered in the SAME
 * physically-based fabric (sheen lobe + quilt normal map + the chosen swatch)
 * the inline 3D preview shows — GLTFExporter writes the sheen as the standard
 * KHR_materials_sheen extension, so model-viewer (and Scene Viewer / Quick Look)
 * render real upholstery, not flat plastic.
 *
 * Units: the scene is authored in CENTIMETRES; glTF's unit is the METRE, so the
 * exported root is scaled 0.01 — that's what makes AR place the piece
 * TRUE-TO-SCALE in the customer's room.
 */
import type { SceneSpec, ThreeApi, ThreeObject, ThreeTexture } from './types.ts';
import type { BuildSceneOptions, ScanPbr } from './sceneBuilder.ts';
import { buildSceneGroup, disposeGroup, makeFabricMaps } from './sceneBuilder.ts';

/** Centimetres → metres. glTF's unit is the metre; the scene is authored in cm. */
export const CM_TO_M = 0.01;

/**
 * Load the distinct fabric swatches in a scene as THREE.Textures, keyed by code.
 * `urlFor(code)` returns a (CORS-safe) image URL or null. Failures are swallowed
 * (a 404 swatch just falls back to the default colour) so one bad code never
 * blocks the export. Returns a Map<code, THREE.Texture>.
 */
export async function loadFabricTextures(
  THREE: ThreeApi,
  codes: readonly (string | null | undefined)[] | null | undefined,
  urlFor: (code: string) => string | null | undefined,
): Promise<Map<string, ThreeTexture>> {
  const out = new Map<string, ThreeTexture>();
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin?.('anonymous');
  await Promise.all([...new Set((codes || []).filter(Boolean) as string[])].map(async (code) => {
    const url = urlFor(code);
    if (!url) return;
    try { out.set(code, await loader.loadAsync(url)); } catch { /* missing → default colour */ }
  }));
  return out;
}

/** Options for `buildArGroup`. */
export interface ArGroupOptions extends BuildSceneOptions {
  /** Legacy path: raw swatch photos, keyed by fabric code. */
  textures?: Map<string, ThreeTexture>;
  /** The resolved appearance from `@veta/materials`: exact colours per code. */
  colors?: Map<string, number>;
  /** REAL tileable scans per code — GLTFExporter embeds these into the file. */
  fabricTextures?: Map<string, ThreeTexture>;
  /** Each scan's `material.mat` port per code. */
  pbr?: Map<string, ScanPbr>;
  /** Each scan's own weave relief per code. */
  normals?: Map<string, ThreeTexture>;
}

/** What `buildArGroup` hands back — the caller owns disposal. */
export interface ArGroup {
  root: ThreeObject;
  quilt: ThreeTexture | null;
  dispose: () => void;
}

/**
 * Build the AR-ready group from a scene spec: the furniture group (no studio rig
 * — model-viewer lights it), upholstered, then wrapped in a root scaled cm→m.
 * `opts` carries the fabric finish (see `RenderParams.finishProfile`) plus the
 * appearance maps the caller resolved.
 */
export function buildArGroup(THREE: ThreeApi, scene3d: SceneSpec | null | undefined, opts: ArGroupOptions = {}): ArGroup {
  const textures = opts.textures instanceof Map ? opts.textures : new Map<string, ThreeTexture>();
  // The same woven fabric maps as the live preview, so AR carries the texture too
  // (buildSceneGroup/makeFabricMaterial tile them to the profile's repeat).
  const { normalMap: quilt, grainMap: grain } = makeFabricMaps(THREE);

  // Fabric appearance: the caller's resolved maps (exact colours + REAL tileable
  // textures that GLTFExporter embeds into the file). KHR_materials_sheen
  // carries the velvet sheen either way, so Scene Viewer / Quick Look render
  // real upholstery rather than flat plastic.
  const colors = opts.colors instanceof Map ? new Map(opts.colors) : new Map<string, number>();
  const fabricTextures = opts.fabricTextures instanceof Map ? opts.fabricTextures : new Map<string, ThreeTexture>();
  const pbr = opts.pbr instanceof Map ? opts.pbr : new Map<string, ScanPbr>();
  const scanNormals = opts.normals instanceof Map ? opts.normals : new Map<string, ThreeTexture>();

  const group = buildSceneGroup(THREE, scene3d, {
    ...opts,
    normalMap: quilt, grainMap: grain,
    colorFor: (code) => (colors.has(code) ? colors.get(code)! : null),
    textureFor: (code) => fabricTextures.get(code) || null,
    pbrFor: (code) => pbr.get(code) || null,
    normalFor: (code) => scanNormals.get(code) || null,
  });

  const root = new THREE.Group();
  root.add(group);
  root.scale.setScalar(CM_TO_M);     // centimetres → metres (AR true-to-scale)
  root.updateMatrixWorld(true);

  const dispose = () => {
    disposeGroup(root);                      // geometries, materials, cloned swatch maps
    quilt?.dispose?.();                      // the shared fabric maps (disposeGroup skips them)
    grain?.dispose?.();
    textures.forEach((t) => t.dispose?.());  // the original loaded swatches
    fabricTextures.forEach((t) => t.dispose?.());
  };
  return { root, quilt, dispose };
}

/** The exporter the caller injects (three's `GLTFExporter` addon). */
export interface GlbExportDeps {
  GLTFExporter: new () => {
    parse(
      input: any,
      onDone: (result: ArrayBuffer | object) => void,
      onError: (err: unknown) => void,
      options?: Record<string, unknown>,
    ): void;
  };
}

/**
 * Export a three.js Object3D to a binary glTF (GLB) Blob via GLTFExporter
 * (dependency-injected). Resolves to a Blob of type model/gltf-binary the View
 * wraps in an object URL for <model-viewer>.
 */
export function exportGlbBlob(deps: GlbExportDeps, object: ThreeObject): Promise<Blob> {
  const { GLTFExporter } = deps;
  return new Promise<Blob>((resolve, reject) => {
    try {
      const exporter = new GLTFExporter();
      exporter.parse(
        object,
        (result) => {
          const buf = result instanceof ArrayBuffer ? result : new TextEncoder().encode(JSON.stringify(result));
          resolve(new Blob([buf as BlobPart], { type: 'model/gltf-binary' }));
        },
        (err) => reject(err instanceof Error ? err : new Error('GLB export failed')),
        { binary: true },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
