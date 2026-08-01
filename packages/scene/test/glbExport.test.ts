// GLB export — pins the PURE-ish AR export contract with a tiny three stub
// (no real WebGL): the configured layout is wrapped in a root scaled cm→m, so AR
// places the piece TRUE-TO-SCALE; the furniture group carries one node per
// piece; and the swatch loader dedups codes + swallows missing-swatch failures
// so one bad code never blocks the export. The visual three.js path is covered
// by the app's build.
//
// Ported from RosetSoft `tests/togoGlbExport.test.js`. Its scene spec came from
// `resolveTogoScene` (now @veta/layout); here the spec is written inline,
// because a plain `{ pieces }` object is exactly what the engine consumes.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CM_TO_M, buildArGroup, loadFabricTextures } from '../src/index.ts';
import type { SceneSpec } from '../src/index.ts';

// A minimal three.js stand-in — only what buildSceneGroup/makeFabricMaterial
// touch. makeFabricMaps returns nulls under Node (no `document`), so no
// CanvasTexture is ever constructed.
function makeThreeStub() {
  class Vector2 { x: number; y: number; constructor(x?: number, y?: number) { this.x = x!; this.y = y!; } set(x: number, y: number) { this.x = x; this.y = y; return this; } }
  class Color { v: unknown; constructor(v?: unknown) { this.v = v; } }
  class Group {
    children: any[] = [];
    type = 'Group';
    position = { y: 0, set() {} };
    rotation = { y: 0 };
    scale = { value: 1, setScalar(s: number) { this.value = s; } };
    userData: Record<string, unknown> = {};
    add(o: any) { this.children.push(o); }
    updateMatrixWorld() {}
  }
  class Mesh {
    position = { set() {} };
    rotation: Record<string, number> = {};
    userData: Record<string, unknown> = {};
    castShadow = false;
    receiveShadow = false;
    constructor(public geometry: any, public material: any) {}
  }
  class MeshPhysicalMaterial { userData: Record<string, unknown> = {}; constructor(o: Record<string, unknown>) { Object.assign(this, o); } }
  class CapsuleGeometry { constructor(public radius: number, public length: number) {} }
  class BoxGeometry { constructor(public w: number, public h: number, public d: number) {} }
  return {
    Group, Mesh, MeshPhysicalMaterial, CapsuleGeometry, BoxGeometry, Color, Vector2,
    SRGBColorSpace: 'srgb', RepeatWrapping: 1,
  } as any;
}
class RoundedBoxGeometry { constructor(public w: number, public h: number, public d: number) {} }

const SCENE: SceneSpec = {
  pieces: [
    { x: -51, z: 0, rotationDeg: 0, widthCm: 174, depthCm: 102, label: 'Sofá', fabricCode: '4479' },
    { x: 87, z: 0, rotationDeg: 0, widthCm: 102, depthCm: 102, label: 'Sillón' },
  ],
};

test('buildArGroup wraps the furniture in a root scaled cm→m (AR true-to-scale)', () => {
  const THREE = makeThreeStub();
  const { root, quilt, dispose } = buildArGroup(THREE, SCENE, { RoundedBoxGeometry });

  // The root carries the metre conversion (glTF unit = metre; scene is in cm).
  assert.equal(root.scale.value, CM_TO_M);
  assert.equal(CM_TO_M, 0.01);
  // It wraps exactly the furniture group …
  assert.equal(root.children.length, 1);
  // … which holds one piece-group per placed piece.
  assert.equal(root.children[0].children.length, SCENE.pieces!.length);
  // No CanvasTexture under Node, so there's nothing to bake/dispose — and dispose
  // must be safe to call with no quilt and no textures.
  assert.equal(quilt, null);
  assert.doesNotThrow(() => dispose());
});

test('the DEFAULT fallback is one VISIBLE placeholder per piece — never a wrong-brand sofa', () => {
  const THREE = makeThreeStub();
  const { root } = buildArGroup(THREE, SCENE, { RoundedBoxGeometry });
  const [first] = root.children[0].children;
  const mount = first.children[0];              // the mount group
  assert.equal(mount.children.length, 1, 'exactly one placeholder solid');
  const box = mount.children[0];
  assert.equal(box.userData.placeholder, true);
  assert.ok(box.geometry instanceof RoundedBoxGeometry, 'a rounded box, not a generated sofa');
  assert.equal(box.geometry.w, 174, 'sized to the catalogue footprint');
  assert.equal(box.geometry.d, 102);
});

test('the procedural Togo fallback is OPT-IN — and then it is the cushion pile', () => {
  const THREE = makeThreeStub();
  const { root } = buildArGroup(THREE, SCENE, {
    RoundedBoxGeometry,
    params: { fallback: 'procedural-togo' },
  });
  const mount = root.children[0].children[0].children[0];
  assert.ok(mount.children.length > 10, `the generated cushion pile (${mount.children.length} parts)`);
  assert.ok(mount.children.some((m: any) => m.geometry instanceof THREE.CapsuleGeometry), 'has the channel ridges');
});

test('loadFabricTextures dedups codes and swallows missing swatches', async () => {
  const THREE = {
    TextureLoader: class {
      setCrossOrigin() {}
      loadAsync(url: string) { return url.includes('bad') ? Promise.reject(new Error('404')) : Promise.resolve({ url }); }
    },
  } as any;
  const map = await loadFabricTextures(THREE, ['a', 'a', 'b', 'bad', '', null], (c) => `https://x/${c}`);
  // 'a' deduped, 'b' kept, 'bad' rejected (swallowed), '' and null filtered out.
  assert.equal(map.size, 2);
  assert.ok(map.has('a') && map.has('b'));
  assert.ok(!map.has('bad'));
});
