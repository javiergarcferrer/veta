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

import {
  CREASE_ANGLE,
  MAX_SOLIDS_PER_MESH,
  exportPieceGlb,
  isOptimizableMeshUrl,
  splitGeometryBySolid,
} from '../src/optimize.ts';
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

/* ── ONE MESH PER SOLID (v3) ────────────────────────────────────────────────*/

/** Two boxes with air between them, merged into ONE non-indexed geometry — the
 *  shape an upholstered export actually arrives as: a single primitive whose
 *  triangles form several disconnected masses. */
function twoMassGeometry(): THREE.BufferGeometry {
  const a = new THREE.BoxGeometry(2, 1, 1, 2, 2, 2);
  // Deliberately coarser: the two masses must be TELLABLE APART by vertex count,
  // which is how the compaction pin proves neither carries the parent's buffer.
  const b = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1).translate(8, 0, 0);
  return BufferGeometryUtils.mergeGeometries([a, b])!.toNonIndexed();
}

/** Every mesh of a parsed scene, with the facts the pins read. */
function primitivesOf(scene: THREE.Object3D) {
  const out: { count: number; material: string; matrix: number[]; posCtor: unknown; normalized: boolean }[] = [];
  scene.traverse((o: any) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    out.push({
      count: pos.count,
      material: Array.isArray(o.material) ? o.material[0]?.name : o.material?.name,
      matrix: o.matrix.elements.slice(),
      posCtor: pos.array.constructor,
      normalized: pos.normalized,
    });
  });
  return out;
}

test('a two-mass mesh exports as TWO primitives — that is what makes a cushion clickable', async () => {
  // Every consumer downstream (the tagger, the raycast, the selection outline)
  // already works per MESH, so making one mesh BE one connected mass is the
  // whole integration. Grouping by MATERIAL cannot do this: one fabric covers
  // the seat, the back, the piping and every seam.
  const mesh = new THREE.Mesh(twoMassGeometry(), new THREE.MeshStandardMaterial({ name: 'fabric-A' }));
  mesh.position.set(3, 0.5, -2);
  mesh.updateMatrixWorld(true);

  const buffer = await exportPieceGlb(THREE, [mesh], deps());
  const prims = primitivesOf((await parseGlb(buffer)).scene);
  assert.equal(prims.length, 2, 'one primitive per solid mass');

  // Same node material and the SAME composed matrix on both: the masses of one
  // node share its world transform and its dequantization fit.
  assert.deepEqual(prims.map((p) => p.material), ['fabric-A', 'fabric-A']);
  assert.deepEqual(prims[0]!.matrix, prims[1]!.matrix, 'every mass of a node rides one fit');

  // COMPACTED VERTICES. Sharing the parent's buffers would write the whole
  // vertex array into EVERY primitive and multiply the file by the number of
  // masses — so each mass must carry materially fewer vertices than the pair.
  const total = prims[0]!.count + prims[1]!.count;
  assert.ok(prims[0]!.count < total && prims[1]!.count < total, 'each mass compacts its own vertices');
  // Largest mass first (splitSolids orders by area), and the small one is a
  // fraction of the pair — a shared parent buffer would make them identical.
  assert.ok(prims[0]!.count > prims[1]!.count, 'the largest mass leads, and carries more vertices');

  // ATTRIBUTE TYPES SURVIVE THE SPLIT: a quantized geometry stays quantized (the
  // split runs AFTER crease/weld/quantize, on the integers).
  for (const p of prims) {
    assert.equal(p.posCtor, Int16Array);
    assert.equal(p.normalized, true);
  }
  assert.equal(readGlbMeshVersion(buffer), MESH_VERSION);
});

test('an UNNAMED material is NAMED after its node BEFORE the split, cloned per node', async () => {
  // THE HAZARD THE SPLIT HAD TO CLEAR. An unnamed material keys its part by NODE
  // INDEX, so emitting one node per mass renumbers every node after the first
  // split — silently re-tagging a cushion as a bolster across the catalogue.
  // Naming freezes the key, and the clone is what keeps two nodes that SHARED
  // one unnamed material as two distinct parts instead of collapsing to one.
  const shared = new THREE.MeshStandardMaterial();          // no name at all
  const meshes = [0, 1].map((i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).toNonIndexed(), shared);
    m.position.set(i * 4, 0, 0);
    m.updateMatrixWorld(true);
    return m;
  });
  const prims = primitivesOf((await parseGlb(await exportPieceGlb(THREE, meshes, deps()))).scene);
  assert.deepEqual(prims.map((p) => p.material).sort(), ['#0', '#1'], 'two nodes, two keys');
  assert.equal(shared.name, '', 'the SOURCE material is untouched — it may still be on screen');

  // A material that already HAS a name is never renamed: the dealer's own
  // tagging hangs on it.
  const named = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).toNonIndexed(), new THREE.MeshStandardMaterial({ name: 'COL0' }));
  named.updateMatrixWorld(true);
  const one = primitivesOf((await parseGlb(await exportPieceGlb(THREE, [named], deps()))).scene);
  assert.deepEqual(one.map((p) => p.material), ['COL0']);
});

test('the split BAILS rather than making confetti', () => {
  // Past the cap a mesh is scan noise or exploded seams; one primitive each
  // would bloat the file and the draw calls for nothing, so it exports whole.
  const geometry = twoMassGeometry();
  assert.equal(splitGeometryBySolid(THREE, geometry).length, 2, 'the ordinary case still splits');

  // Multi-material groups: a per-mass index would lose the assignment.
  const grouped = twoMassGeometry();
  grouped.addGroup(0, 30, 0);
  grouped.addGroup(30, 30, 1);
  assert.deepEqual(splitGeometryBySolid(THREE, grouped), [grouped]);

  // Morph targets live in the same space as the positions; splitting one side
  // of that pair deforms the mesh silently.
  const morphed = twoMassGeometry();
  morphed.morphAttributes.position = [morphed.attributes.position!.clone()];
  assert.deepEqual(splitGeometryBySolid(THREE, morphed), [morphed]);

  // A single mass is returned as itself, not as a one-element rebuild.
  const one = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).toNonIndexed();
  assert.deepEqual(splitGeometryBySolid(THREE, one), [one]);
  assert.equal(MAX_SOLIDS_PER_MESH, 64);
});

test('MESH_VERSION 3: a v2 file is renderable, stale, and owed a re-export', async () => {
  // The bump is what makes the catalogue read as re-optimizable again. A v2 GLB
  // still renders identically — it is creased, welded and quantized — it just
  // cannot offer the parts until the batch runs. So the gate is a COMPARISON,
  // never a truthy stamp, and both legacy accepts survive the bump.
  assert.equal(MESH_VERSION, 3);
  assert.ok(meshVersionOf({ asset: { extras: { [MESH_VERSION_KEY]: 2 } } }) < MESH_VERSION, 'our own v2 is stale');
  assert.ok(meshVersionOf({ asset: { extras: { [LEGACY_MESH_VERSION_KEY]: 2 } } }) < MESH_VERSION, 'a legacy v2 is stale');
  // …and a legacy stamp at the CURRENT version is current: the alias is read at
  // face value, not treated as "old therefore stale".
  assert.equal(meshVersionOf({ asset: { extras: { [LEGACY_MESH_VERSION_KEY]: 3 } } }), MESH_VERSION);

  const plain = await new GLTFExporter().parseAsync(fixtureMesh('v2'), { binary: true }) as ArrayBuffer;
  const v2 = stampGlbAsset(plain, { [MESH_VERSION_KEY]: 2 });
  assert.equal(readGlbMeshVersion(v2), 2);
  let meshes = 0;
  (await parseGlb(v2)).scene.traverse((o: any) => { if (o.isMesh) meshes++; });
  assert.equal(meshes, 1, 'still a perfectly good file');
});
