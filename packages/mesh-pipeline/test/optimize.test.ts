// THE MESH PIPELINE — what `exportPieceGlb` bakes into every GLB a dealer
// publishes, pinned end to end against real three.js: a fixture geometry goes
// through the export and comes back through GLTFLoader, and the round trip has
// to hold the four things the rest of the app builds on.
//
//   • MATERIAL NAMES SURVIVE. Part tagging keys per-part pricing off
//     `material.name` (pCon gives a part type one material id across a whole
//     collection and no node names at all), so a substituted or re-created
//     material turns the re-imported GLB into one anonymous blob and per-part
//     fabric pricing dies with it.
//   • THE WELD IS REAL. Creasing explodes the mesh into loose triangles;
//     merging them back is where 77% of the vertices (and most of the file) go.
//   • THE GEOMETRY DIDN'T MOVE. Quantization is only acceptable because its
//     error is three orders of magnitude under anything a sofa is specified to:
//     int16 over a 2 m span is a 0.03 mm step, pinned here at 0.5 mm.
//   • THE FILE SAYS SO. The `asset.extras` stamp is what lets the loader SKIP
//     the runtime crease — the single heaviest step of every model load. An
//     UNMARKED file must keep taking the old path, so the stamp reads 0 and a
//     reader's gate is on the VERSION, not on a truthy check.
//
// Imported per MODULE rather than through the barrel on purpose: this file pins
// the optimization engine, and the barrel also re-exports the scene split, which
// pulls in @veta/geometry. A sibling package's state must not decide whether
// this pipeline's own signal is green.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { CREASE_ANGLE, exportPieceGlb, isOptimizableMeshUrl } from '../src/optimize.ts';
import {
  LEGACY_MESH_VERSION_KEY,
  MESH_VERSION,
  MESH_VERSION_KEY,
  meshVersionOf,
  readGlbMeshVersion,
  stampGlbAsset,
} from '../src/glbStamp.ts';

// three's GLTFExporter writes its binary container through FileReader, which
// Node has no global for. Blob-backed shim — nothing about the pipeline under
// test, just the plumbing that turns a Blob into an ArrayBuffer.
if (typeof (globalThis as any).FileReader === 'undefined') {
  (globalThis as any).FileReader = class {
    result: any;
    onloadend: (() => void) | undefined;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); });
    }
  };
}

/** The injected dependencies the app code-splits: an exporter instance and the
 *  geometry utils. A fresh exporter per export, exactly as the caller does. */
const deps = () => ({ exporter: new GLTFExporter(), utils: BufferGeometryUtils });

/** A 2 m-span box, exploded to loose triangles — a stand-in for the pCon export
 *  shape: non-indexed, float32, duplicate vertices everywhere. */
function fixtureMesh(name: string): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(2, 1, 1, 4, 4, 4).toNonIndexed();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name }));
  mesh.position.set(3, 0.5, -2);        // off the origin: the fit transform has to carry it back
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Every vertex of a loaded scene, in WORLD space. */
function worldVertices(object: THREE.Object3D): number[][] {
  object.updateMatrixWorld(true);
  const out: number[][] = [];
  const v = new THREE.Vector3();
  object.traverse((o: any) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) out.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray());
  });
  return out;
}

/** The furthest any point of `a` sits from its nearest neighbour in `b`. */
function maxNearestDistance(a: number[][], b: number[][]): number {
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < best) best = d;
    }
    worst = Math.max(worst, Math.sqrt(best));
  }
  return worst;
}

const parseGlb = (buffer: ArrayBuffer) => new GLTFLoader().parseAsync(buffer, '');

/** The glTF JSON chunk of a GLB, decoded. */
function glbJson(buffer: ArrayBuffer): any {
  const view = new DataView(buffer);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
}

test('exportPieceGlb: crease → weld → quantize, and the round trip holds', async () => {
  const mesh = fixtureMesh('7d370981-bd17-4b0d-9873-b475ef2d1c4c');
  const sourceCount = mesh.geometry.attributes.position.count;
  const sourceWorld = worldVertices(mesh);

  const buffer = await exportPieceGlb(THREE, [mesh], deps());
  const gltf = await parseGlb(buffer);

  // (d) THE STAMP — both off the parsed asset (what a loader reads) and off the
  // raw bytes (what a batch reads before it decides to re-export).
  assert.equal(meshVersionOf(gltf), MESH_VERSION);
  assert.equal(readGlbMeshVersion(buffer), MESH_VERSION);

  // (a) MATERIAL NAMES, by name and one per source material.
  const names: (string | undefined)[] = [];
  gltf.scene.traverse((o: any) => {
    if (o.isMesh) names.push(Array.isArray(o.material) ? o.material[0]?.name : o.material?.name);
  });
  assert.deepEqual(names, ['7d370981-bd17-4b0d-9873-b475ef2d1c4c']);

  // (b) THE WELD — indexed, and materially fewer vertices than the soup.
  let outCount = 0;
  let indexed = 0;
  gltf.scene.traverse((o: any) => {
    if (!o.isMesh) return;
    outCount += o.geometry.attributes.position.count;
    if (o.geometry.index) indexed++;
  });
  assert.equal(indexed, 1, 'the exported mesh is indexed');
  assert.ok(outCount < sourceCount * 0.6, `welded ${sourceCount} → ${outCount}`);

  // (c) THE GEOMETRY DIDN'T MOVE — half a millimetre, both directions, in world
  // space (so the node's dequantization transform is part of what's checked).
  const outWorld = worldVertices(gltf.scene);
  assert.ok(maxNearestDistance(outWorld, sourceWorld) < 0.0005, 'every exported vertex is within 0.5 mm of a source vertex');
  assert.ok(maxNearestDistance(sourceWorld, outWorld) < 0.0005, 'no source vertex was left behind');

  // The attribute contract itself: quantized position + normal, float UVs.
  gltf.scene.traverse((o: any) => {
    if (!o.isMesh) return;
    const { position, normal, uv } = o.geometry.attributes;
    assert.equal(position.array.constructor, Int16Array);
    assert.equal(position.normalized, true);
    assert.equal(normal.array.constructor, Int8Array);
    assert.equal(normal.normalized, true);
    // A factory piece's baked UVs are what make its own bitmaps land where the
    // product designer put them, and they are free to run outside [0,1].
    assert.equal(uv.array.constructor, Float32Array);
    assert.equal(uv.normalized, false);
  });

  // The extension is DECLARED — required, not merely used: a reader that can't
  // decode the integers must refuse the file rather than render it inside out.
  const json = glbJson(buffer);
  assert.ok(json.extensionsUsed?.includes('KHR_mesh_quantization'));
  assert.ok(json.extensionsRequired?.includes('KHR_mesh_quantization'));

  // The SOURCE is untouched: the scene's own meshes may still be on screen
  // behind a review list, and `toCreasedNormals` mutates a non-indexed input.
  assert.equal(mesh.geometry.attributes.position.count, sourceCount);
  assert.equal(mesh.geometry.attributes.position.array.constructor, Float32Array);
  assert.equal(mesh.geometry.index, null);
});

test('quantization is anchored at the geometry origin, and bails when that is too far', async () => {
  // ANCHORED AT THE ORIGIN, not at the bounding-box centre: box-projected UV
  // generation projects the fabric UVs off RAW LOCAL POSITIONS ÷ (tile ÷ the
  // node's own world scale), so a pure scale cancels exactly and the generated
  // UVs come out bit-identical — a re-centring would shift the weave's phase on
  // every mesh. The node therefore carries NO translation of its own.
  const centred = fixtureMesh('centred');
  const json = glbJson(await exportPieceGlb(THREE, [centred], deps()));
  const node = json.nodes.find((n: any) => n.mesh !== undefined);
  const m = node.matrix;
  assert.ok(m, 'the node carries the composed matrix');
  // Column-major: the translation column is the mesh's own world position and
  // nothing else; the 3×3 block is world ∘ (uniform scale), still diagonal here.
  assert.deepEqual(m.slice(12, 15).map((v: number) => +v.toFixed(6)), [3, 0.5, -2]);
  assert.equal(+m[1].toFixed(9), 0);
  assert.equal(+m[2].toFixed(9), 0);
  assert.ok(Math.abs(m[0] - m[5]) < 1e-9 && Math.abs(m[5] - m[10]) < 1e-9, 'uniform scale');

  // The price of the origin anchor is a RANGE guard (MAX_ORIGIN_RATIO): a
  // geometry authored far from its own origin would blow the 0.5 mm budget, so
  // it exports as floats — still creased, still welded, still stamped. Never
  // silently imprecise.
  const far = fixtureMesh('far');
  far.geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(400, 0, 0));   // 400× its own half-span
  const farGltf = await parseGlb(await exportPieceGlb(THREE, [far], deps()));
  let checked = 0;
  farGltf.scene.traverse((o: any) => {
    if (!o.isMesh) return;
    checked++;
    assert.equal(o.geometry.attributes.position.array.constructor, Float32Array, 'not quantized');
    assert.ok(o.geometry.index, 'but still welded');
  });
  assert.equal(checked, 1);
  assert.equal(meshVersionOf(farGltf), MESH_VERSION, 'and still creased, so still stamped');
});

test('exportPieceGlb: one bake per SOURCE geometry, so the GLB still dedups meshes', async () => {
  // A CAD scene places one buffer many times (an eight-module sofa is one
  // cushion mesh over and over). Baking per NODE would hand the exporter eight
  // distinct geometries and the file would carry eight copies.
  const material = new THREE.MeshStandardMaterial({ name: 'shared-mat' });
  const geometry = new THREE.BoxGeometry(2, 1, 1, 4, 4, 4).toNonIndexed();
  const meshes = [0, 1, 2].map((i) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(i * 3, 0, 0);
    m.updateMatrixWorld(true);
    return m;
  });
  const json = glbJson(await exportPieceGlb(THREE, meshes, deps()));
  assert.equal(json.meshes.length, 1, 'three placements, one mesh');
  assert.equal(json.nodes.filter((n: any) => n.mesh !== undefined).length, 3);
});

test('without the geometry utils a piece still exports — unbaked, and UNSTAMPED', async () => {
  // The stamp is a claim about the FILE. A GLB that claimed baked normals it
  // never got would ship flat-shaded soup to every visitor with the loader's own
  // creasing switched off, so it is all-or-nothing.
  const mesh = fixtureMesh('no-utils');
  const buffer = await exportPieceGlb(THREE, [mesh], { exporter: new GLTFExporter(), utils: null });
  assert.equal(readGlbMeshVersion(buffer), 0);
  const gltf = await parseGlb(buffer);
  let meshes = 0;
  gltf.scene.traverse((o: any) => { if (o.isMesh) meshes++; });
  assert.equal(meshes, 1, 'the piece still lands');
});

test('an UNMARKED GLB reports version 0, so a loader keeps creasing it', async () => {
  // Everything published before the pipeline existed — and anything exported by
  // a bare GLTFExporter — must read as 0, or a loader would skip the runtime
  // crease over flat per-face normals and the whole catalogue would shade as
  // faceted patches.
  const mesh = fixtureMesh('mat');
  const plain = await new GLTFExporter().parseAsync(mesh, { binary: true }) as ArrayBuffer;
  assert.equal(readGlbMeshVersion(plain), 0);
  assert.equal(meshVersionOf(await parseGlb(plain)), 0);
  assert.equal(meshVersionOf(undefined), 0);
  assert.equal(meshVersionOf({ asset: {} }), 0);
  // Junk that isn't a container at all answers 0 rather than throwing.
  assert.equal(readGlbMeshVersion(new ArrayBuffer(0)), 0);
  assert.equal(readGlbMeshVersion(new Uint8Array([1, 2, 3, 4, 5]).buffer), 0);
  assert.equal(readGlbMeshVersion(null), 0);

  // A reader's gate must be `meshVersionOf(x) < MESH_VERSION`, never a truthy
  // stamp — a future v3 file has to fall back to runtime creasing until the
  // reader learns it.
  assert.ok(meshVersionOf({ asset: { extras: { [MESH_VERSION_KEY]: MESH_VERSION + 1 } } }) > MESH_VERSION);
  // ONE angle across both moments: the import bakes it, the loader applies it.
  assert.equal(CREASE_ANGLE, Math.PI / 3);
});

test('the stamp writes the VETA key and still reads the legacy one', async () => {
  // The fleet stamped before the extraction carries `alcoverMeshV`, and those
  // files are already creased + welded + quantized. Drop the alias and every one
  // of them reads as version 0: a loader would redo the heaviest step of the
  // load on the whole catalogue, and a re-run of the batch would re-export files
  // that need nothing. The alias is READ-ONLY — new files carry the new key, so
  // the legacy name ages out of the fleet instead of being written forever.
  const buffer = await exportPieceGlb(THREE, [fixtureMesh('legacy')], deps());
  const extras = glbJson(buffer).asset.extras;
  assert.equal(extras[MESH_VERSION_KEY], MESH_VERSION, 'writes vetaMeshV');
  assert.equal(extras[LEGACY_MESH_VERSION_KEY], undefined, 'and never writes the legacy key');

  // A file stamped the OLD way still reads as optimized, bytes and parsed alike.
  const plain = await new GLTFExporter().parseAsync(fixtureMesh('legacy2'), { binary: true }) as ArrayBuffer;
  const legacy = stampGlbAsset(plain, { [LEGACY_MESH_VERSION_KEY]: MESH_VERSION });
  assert.equal(readGlbMeshVersion(legacy), MESH_VERSION);
  assert.equal(meshVersionOf(await parseGlb(legacy)), MESH_VERSION);
  assert.equal(meshVersionOf({ asset: { extras: { [LEGACY_MESH_VERSION_KEY]: 2 } } }), 2);
  // The current key wins where a file somehow carries both.
  assert.equal(meshVersionOf({ asset: { extras: { [MESH_VERSION_KEY]: 3, [LEGACY_MESH_VERSION_KEY]: 2 } } }), 3);

  // Stamping REBUILDS the container around a new JSON chunk: the model must
  // survive it byte-perfect on the BIN side.
  const gltf = await parseGlb(legacy);
  let meshes = 0;
  gltf.scene.traverse((o: any) => { if (o.isMesh) meshes++; });
  assert.equal(meshes, 1);
  // A buffer that isn't a GLB ships back unmarked rather than corrupted.
  const notGlb = new Uint8Array([1, 2, 3, 4]).buffer;
  assert.equal(stampGlbAsset(notGlb, { x: 1 }), notGlb);
});

test('isOptimizableMeshUrl: GLB only — a raw CAD upload has no stamp to read', () => {
  assert.equal(isOptimizableMeshUrl('https://x/y/abc.glb'), true);
  assert.equal(isOptimizableMeshUrl('https://x/y/abc.gltf?v=2'), true);
  assert.equal(isOptimizableMeshUrl('https://x/y/abc.fbx'), false);
  assert.equal(isOptimizableMeshUrl('https://x/y/abc.3ds'), false);
  assert.equal(isOptimizableMeshUrl(null), false);
});
