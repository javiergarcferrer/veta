/**
 * THE THREE.JS BOUNDARY.
 *
 * `@veta/scene` never imports three (CONTRACTS.md: the runtime namespace is
 * dependency-injected), and neither does any component in this app — three and
 * its addons are ~600 KB the plan editor, the price deck and the lead form do
 * not need. They are loaded HERE, on demand, the first time a visitor opens the
 * 3D view, and every consumer takes the loaded bundle as a parameter.
 *
 * The three addons ride along in the same chunk because they are useless alone:
 * `RoomEnvironment` IS the studio rig's image-based light (`setupStage` needs
 * it), `RoundedBoxGeometry` is the procedural fallback's shape, and the two
 * exporters are what "download" and "see it in your space" produce.
 */

import { safeDynamicImport } from './dynamicImport.ts';

export interface ThreeBundle {
  THREE: any;
  RoundedBoxGeometry: any;
  RoomEnvironment: any;
}

export interface ExporterBundle {
  GLTFExporter: any;
  OBJExporter: any;
}

let threePromise: Promise<ThreeBundle> | null = null;
let exportersPromise: Promise<ExporterBundle> | null = null;

/** three + the addons the stage and the fallback geometry need. Memoized: a
 *  second 3D mount must not re-parse the bundle. */
export function loadThree(): Promise<ThreeBundle> {
  threePromise ??= (async () => {
    const [THREE, roundedBox, roomEnv] = await Promise.all([
      safeDynamicImport(() => import('three')),
      safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
      safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
    ]);
    return {
      THREE,
      RoundedBoxGeometry: (roundedBox as { RoundedBoxGeometry: unknown }).RoundedBoxGeometry,
      RoomEnvironment: (roomEnv as { RoomEnvironment: unknown }).RoomEnvironment,
    };
  })();
  return threePromise;
}

/** The GLB + OBJ writers — loaded only when a download is actually clicked. */
export function loadExporters(): Promise<ExporterBundle> {
  exportersPromise ??= (async () => {
    const [gltf, obj] = await Promise.all([
      safeDynamicImport(() => import('three/examples/jsm/exporters/GLTFExporter.js')),
      safeDynamicImport(() => import('three/examples/jsm/exporters/OBJExporter.js')),
    ]);
    return {
      GLTFExporter: (gltf as { GLTFExporter: unknown }).GLTFExporter,
      OBJExporter: (obj as { OBJExporter: unknown }).OBJExporter,
    };
  })();
  return exportersPromise;
}
