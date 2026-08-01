/**
 * THE THREE SEAM, WORKER SIDE — the runtime namespace and the code-split
 * addons the pipeline takes as parameters.
 *
 * `@veta/*` packages never import three (CONTRACTS.md): they take it in. This
 * module is where an app finally names it, and it does so behind a dynamic
 * `import()` so three's ~730 KB of module evaluation is paid once, inside the
 * worker, off the thread the dealer is clicking on.
 *
 * BOTH HALVES OF THE GLB PIPELINE WORK IN A WORKER, and that is not luck:
 * three's GLTFLoader picks `ImageBitmapLoader` whenever `createImageBitmap`
 * exists (it does in a worker), and GLTFExporter falls back to `OffscreenCanvas`
 * whenever `document` is undefined (it is). Textures survive the round trip
 * without a DOM.
 */
import type { BufferGeometryUtilsLike, GltfExporterLike, ThreeLike } from '@veta/mesh-pipeline';

export interface ThreeBundle {
  THREE: ThreeLike;
  utils: BufferGeometryUtilsLike;
  /** A FRESH exporter per export — GLTFExporter holds per-parse state. */
  exporter(): GltfExporterLike;
  parseGlb(buffer: ArrayBuffer): Promise<any>;
  /** A loader instance for an extension, or null when we don't cover it. */
  loaderFor(ext: string, manager?: unknown): Promise<any | null>;
}

let cached: Promise<ThreeBundle> | null = null;

/** The bundle, loaded once per worker. */
export function loadThree(): Promise<ThreeBundle> {
  if (!cached) cached = build();
  return cached;
}

async function build(): Promise<ThreeBundle> {
  const [THREE, GLTF, EXPORT, UTILS] = await Promise.all([
    import('three'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/exporters/GLTFExporter.js'),
    import('three/examples/jsm/utils/BufferGeometryUtils.js'),
  ]);
  const three = THREE as unknown as ThreeLike;
  return {
    THREE: three,
    utils: UTILS as unknown as BufferGeometryUtilsLike,
    exporter: () => new EXPORT.GLTFExporter() as unknown as GltfExporterLike,
    async parseGlb(buffer: ArrayBuffer) {
      // The RAW file, read exactly as it is: no label stripping, no re-crease.
      // Stripping nodes here would silently drop geometry AND renumber the rest,
      // and part tagging keys unnamed materials by node index — a shifted index
      // re-tags a cushion as a bolster.
      const gltf = await new GLTF.GLTFLoader().parseAsync(buffer, '');
      return gltf?.scene ?? null;
    },
    async loaderFor(ext: string, manager?: unknown) {
      const mgr = manager as any;
      switch (ext) {
        case 'glb':
        case 'gltf':
          return new GLTF.GLTFLoader(mgr);
        case 'fbx': {
          const m = await import('three/examples/jsm/loaders/FBXLoader.js');
          return new m.FBXLoader(mgr);
        }
        case 'obj': {
          const m = await import('three/examples/jsm/loaders/OBJLoader.js');
          return new m.OBJLoader(mgr);
        }
        case 'dae': {
          const m = await import('three/examples/jsm/loaders/ColladaLoader.js');
          return new m.ColladaLoader(mgr);
        }
        case '3ds': {
          const m = await import('three/examples/jsm/loaders/TDSLoader.js');
          return new m.TDSLoader(mgr);
        }
        default:
          return null;
      }
    },
  };
}

/** The scene root a loader's parse returned, whatever shape it came in. */
export function sceneRootOf(ext: string, parsed: any): any {
  if (!parsed) return null;
  if (ext === 'glb' || ext === 'gltf') return parsed.scene ?? parsed;
  if (ext === 'dae') return parsed.scene ?? parsed;
  return parsed;
}
