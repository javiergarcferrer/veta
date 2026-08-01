// The SCENE BUILDER against REAL three — the parts of the extraction that are
// easy to break silently: the material PRECEDENCE chain, the injected part
// taxonomy's untagged default, the seam-bleed footprint fit, and the ownership
// rules disposal depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  DEFAULT_PARTS_TAXONOMY, buildSceneGroup, disposeGroup, generateBoxUvs, placeRealModel,
} from '../src/index.ts';
import type { PartsTaxonomy, SceneSpec } from '../src/index.ts';

// A stand-in "pCon export": two meshes, one of them carrying its own textured
// material (a factory finish), authored in centimetres at 200×70×100.
function fakeExport({ textured = false } = {}) {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(200, 70, 100), new THREE.MeshStandardMaterial({ name: 'Fabric' }));
  body.position.set(0, 35, 0);
  root.add(body);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(200, 6, 100), new THREE.MeshStandardMaterial({ name: 'Metal' }));
  legs.position.set(0, 3, 0);
  if (textured) {
    const tex = new THREE.Texture();
    // `factoryMaterialFor` requires real IMAGE data — a texture whose image
    // never decoded renders black, and black is a worse answer than the fabric.
    (tex as any).image = { width: 4, height: 4 };
    (legs.material as THREE.MeshStandardMaterial).map = tex;
  }
  root.add(legs);
  return root;
}

const fabric = () => new THREE.MeshPhysicalMaterial({ name: 'base-fabric' });

test('placeRealModel centres the mesh on its tile and sits it on the floor', () => {
  const group = new THREE.Group();
  const model = fakeExport();
  model.position.set(500, 12, -300);        // an arbitrary export origin
  placeRealModel(THREE as any, model, fabric(), null, group, { widthCm: 200, depthCm: 100, collection: 'Prado' });
  const box = new THREE.Box3().setFromObject(group);
  assert.ok(Math.abs(box.min.y) < 1e-6, 'sits ON the floor whatever the export origin');
  const c = box.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(c.x) < 1e-6 && Math.abs(c.z) < 1e-6, 'centred on its tile');
});

test('the seam bleed decides the fit: soft OVERFILLS, structured lands on catalogue', () => {
  const fit = (collection: string | null) => {
    const group = new THREE.Group();
    placeRealModel(THREE as any, fakeExport(), fabric(), null, group, { widthCm: 200, depthCm: 100, collection });
    const s = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    return { x: s.x, z: s.z };
  };
  // Prado (structured, bleed 0.98 < 1) fits the FULL mesh to the catalogue W×D.
  const structured = fit('Prado');
  assert.ok(Math.abs(structured.x - 200) < 1e-3, `structured lands on 200, got ${structured.x}`);
  assert.ok(Math.abs(structured.z - 100) < 1e-3);
  // Togo (soft, bleed 1.04) overfills by exactly 4% so neighbours squish flush.
  const soft = fit('Togo');
  assert.ok(Math.abs(soft.x - 208) < 1e-3, `soft overfills to 208, got ${soft.x}`);
  assert.ok(Math.abs(soft.z - 104) < 1e-3);
  // A legacy row (no collection) reads as the soft default.
  assert.ok(Math.abs(fit(null).x - 208) < 1e-3);
});

test('MATERIAL PRECEDENCE: finish > explicit tag > factory finish > the role fabric', () => {
  const rolesOf = (parts: any, taxonomy: PartsTaxonomy, textured: boolean) => {
    const group = new THREE.Group();
    const base = fabric();
    const finishMat = new THREE.MeshPhysicalMaterial({ name: 'finish' });
    placeRealModel(THREE as any, fakeExport({ textured }), base, null, group, {
      widthCm: 200, depthCm: 100, collection: 'Prado', parts,
      finishMaterialFor: () => finishMat,
    }, { taxonomy });
    const out: Record<string, string> = {};
    group.traverse((o: any) => { if (o.isMesh) out[o.userData.partKey] = o.material.name; });
    return out;
  };

  // 4. UNTAGGED + UNTEXTURED — every pCon export there has ever been. With no
  //    taxonomy wired at all, every mesh takes the base fabric, unchanged.
  assert.deepEqual(rolesOf(null, DEFAULT_PARTS_TAXONOMY, false), { Fabric: 'base-fabric', Metal: 'base-fabric' });

  // 3. FACTORY FINISH — untagged, and the GLB material brought its OWN map.
  //    It renders AS-IS: walnut stays walnut.
  const factory = rolesOf(null, DEFAULT_PARTS_TAXONOMY, true);
  assert.equal(factory.Fabric, 'base-fabric');
  assert.equal(factory.Metal, 'Metal', 'the export material survives, cloned');

  // 2. EXPLICIT TAG beats a factory finish — SILENCE IS THE HINGE. An untagged
  //    mesh means "we do not know"; a tagged one is the dealer saying what it is.
  //    Straight through @veta/materials' own `partRoleFor` — no stub.
  const tagged = { mats: { Metal: 'base' } };
  assert.equal(rolesOf(tagged, DEFAULT_PARTS_TAXONOMY, true).Metal, 'base-fabric');

  // 1. FINISH outranks everything, tag and factory map alike. `finishSpecOf` is
  //    the one lookup @veta/materials does not export yet (see NOTES.md), so it
  //    is supplied here exactly as the app supplies it.
  const withPalette = (parts: any): PartsTaxonomy => ({
    ...DEFAULT_PARTS_TAXONOMY,
    finishSpecOf: (_p, key) => (parts?.finishes?.[key]
      ? { label: null, options: [{ id: 'negro', label: 'Negro', rgb: '#111111', metal: 1 }], default: 'negro' }
      : null),
  });
  const finished = { mats: { Metal: 'base' }, finishes: { Metal: {} } };
  assert.equal(rolesOf(finished, withPalette(finished), true).Metal, 'finish');
});

test('a placed mesh OWNS its buffers — the shared model cache is never freed with the group', () => {
  const model = fakeExport();
  const sourceGeometries = new Set<any>();
  model.traverse((o: any) => { if (o.isMesh) sourceGeometries.add(o.geometry); });

  const group = new THREE.Group();
  placeRealModel(THREE as any, model, fabric(), null, group, { widthCm: 200, depthCm: 100, collection: 'Prado' });
  const placed: any[] = [];
  group.traverse((o: any) => { if (o.isMesh) placed.push(o.geometry); });
  assert.equal(placed.length, 2);
  for (const g of placed) assert.ok(!sourceGeometries.has(g), 'the placement cloned the cached geometry');

  // And the shared procedural maps are flagged so disposeGroup leaves them alone.
  const shared = new THREE.Texture();
  shared.userData = { shared: true };
  const own = new THREE.Texture();
  const mat = new THREE.MeshBasicMaterial();
  const holder = new THREE.Group();
  holder.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
  mat.map = shared;
  let sharedDisposed = false, ownDisposed = false;
  shared.addEventListener('dispose', () => { sharedDisposed = true; });
  own.addEventListener('dispose', () => { ownDisposed = true; });
  disposeGroup(holder);
  assert.equal(sharedDisposed, false, 'userData.shared means someone else owns it');
  mat.map = own;
  disposeGroup(holder);
  assert.equal(ownDisposed, true, 'a per-swatch photo map IS owned by the material');
});

test('generateBoxUvs always projects our OWN uvs — a baked pCon set is replaced', () => {
  // pCon FBX uvs were unwrapped for ITS material atlas (per-island, arbitrary
  // scale), so tiling our weave over them stretches it to invisibility.
  const geo = new THREE.BoxGeometry(100, 100, 100);
  const out = generateBoxUvs(THREE as any, geo, 50);
  const uv = out.attributes.uv;
  assert.ok(uv, 'a uv attribute exists');
  assert.ok(!out.index, 'de-indexed so each triangle owns its vertices (per-FACE projection)');
  // One uv unit = `tileLocal` model units, so a 100 cm cube spans exactly 2.
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < uv.count; i++) { const u = uv.getX(i); if (u < mn) mn = u; if (u > mx) mx = u; }
  assert.ok(Math.abs((mx - mn) - 2) < 1e-6, `spans 100/50 = 2 uv units, got ${mx - mn}`);
  // A degenerate tile is a no-op rather than a NaN-filled attribute.
  assert.equal(generateBoxUvs(THREE as any, geo, 0), geo);
});

test('buildSceneGroup places one group per piece, at the plan position and rotation', () => {
  const scene: SceneSpec = {
    pieces: [
      { x: -50, z: 10, rotationDeg: 90, widthCm: 100, depthCm: 100, mountHeightCm: 40 },
      { x: 50, z: 0, widthCm: 100, depthCm: 100 },
    ],
  };
  const group = buildSceneGroup(THREE as any, scene, {});
  assert.equal(group.children.length, 2);
  const [first, second] = group.children as any[];
  assert.equal(first.position.x, -50);
  assert.equal(first.position.z, 10);
  // The plan's CLOCKWISE screen rotation is a NEGATIVE rotation about world Y.
  assert.ok(Math.abs(first.rotation.y + Math.PI / 2) < 1e-9);
  assert.equal(first.children[0].position.y, 40, 'the mount group carries the platform height');
  assert.ok(Math.abs(second.rotation.y) < 1e-9, 'an unrotated piece stays square to the plan');
  assert.equal(second.children[0].position.y, 0);
  disposeGroup(group);
});

test('an empty / absent scene builds an empty group, never throws', () => {
  assert.equal(buildSceneGroup(THREE as any, { pieces: [] }, {}).children.length, 0);
  assert.equal(buildSceneGroup(THREE as any, null, {}).children.length, 0);
  assert.doesNotThrow(() => disposeGroup(null));
});
