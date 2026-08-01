/**
 * THE THREE SEAM — the only place this package names three.js.
 *
 * Every engine here takes the three namespace as a PARAMETER (`THREE`) instead
 * of importing it: three is ~730 KB of JavaScript whose module evaluation alone
 * is the largest single item in a configurator boot, so the app code-splits it
 * and hands it in. Type-only imports keep that honest — nothing in `src`
 * survives into the runtime graph, which is also what makes these functions
 * unit-testable in node (a test may import three normally).
 *
 * `ThreeLike` lists the classes this package actually constructs and nothing
 * more, so a caller can inject a subset (or a double); the real namespace
 * satisfies it structurally.
 */
import type * as ThreeNS from 'three';

export type Object3DLike = ThreeNS.Object3D;
export type MeshLike = ThreeNS.Mesh;
export type BufferGeometryLike = ThreeNS.BufferGeometry;
export type MaterialLike = ThreeNS.Material;
export type TextureLike = ThreeNS.Texture;
export type LoadingManagerLike = ThreeNS.LoadingManager;

/** The three surface the engines construct against. */
export interface ThreeLike {
  Box3: typeof ThreeNS.Box3;
  Vector3: typeof ThreeNS.Vector3;
  Matrix4: typeof ThreeNS.Matrix4;
  BufferAttribute: typeof ThreeNS.BufferAttribute;
  Group: typeof ThreeNS.Group;
  Mesh: typeof ThreeNS.Mesh;
  LoadingManager: typeof ThreeNS.LoadingManager;
  SRGBColorSpace: typeof ThreeNS.SRGBColorSpace;
}

/**
 * `three/examples/jsm/utils/BufferGeometryUtils.js`, injected. Optional
 * everywhere it is used: a geometry that can't be baked still has to export.
 */
export interface BufferGeometryUtilsLike {
  toCreasedNormals(geometry: BufferGeometryLike, creaseAngle?: number): BufferGeometryLike;
  mergeVertices(geometry: BufferGeometryLike, tolerance?: number): BufferGeometryLike;
}

/**
 * An INSTANCE of `three/examples/jsm/exporters/GLTFExporter.js` (or anything
 * with its `parseAsync`), injected — the exporter is a code-split module and
 * this package never reaches for it.
 */
export interface GltfExporterLike {
  parseAsync(input: Object3DLike, options?: Record<string, unknown>): Promise<unknown>;
}

/** Runtime mesh test — three's types put `isMesh` on Mesh, not on Object3D. */
export const isMeshNode = (o: Object3DLike): o is MeshLike => (o as MeshLike).isMesh === true;

/**
 * Every renderable mesh under `object`, DEPTH-FIRST — the same order every
 * consumer traverses in, so a flattened re-export hands the node-index fallback
 * back the sequence it had (part tagging keys unnamed materials by node index;
 * a shifted index re-tags a cushion as a bolster).
 */
export function collectMeshes(object: Object3DLike | null | undefined): MeshLike[] {
  const meshes: MeshLike[] = [];
  object?.traverse?.((o) => {
    if (isMeshNode(o) && o.geometry?.attributes?.position) meshes.push(o);
  });
  return meshes;
}
