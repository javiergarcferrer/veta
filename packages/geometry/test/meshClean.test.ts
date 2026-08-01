// Mesh cleaning — pins the NAME-only label rule (a shape rule kept eating real
// furniture) and the near-degenerate ground-shadow rule, plus the "never strip
// everything" guard both share.
//
// three.js is dependency-injected, so the whole module tests against a tiny
// structural double — no `three` in this package's graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanMeshNodes, stripLabelMeshes, stripShadowMeshes, isLabelMeshName, isGroundShadowBox,
} from '../src/index.ts';
import type { MeshNodeLike, ThreeLike, Box3Like } from '../src/index.ts';

// ── A minimal Object3D/Box3 double (only what meshClean touches) ──────────

interface FakeNode extends MeshNodeLike {
  children: FakeNode[];
  vertical?: { minY: number; maxY: number };
  disposed?: boolean;
}

function group(): FakeNode {
  const node: FakeNode = {
    name: '',
    isMesh: false,
    parent: null,
    children: [],
    traverse(cb) { cb(node); for (const c of [...node.children]) c.traverse(cb); },
    updateMatrixWorld() { /* no-op */ },
  };
  return node;
}

/** A named mesh spanning [minY, maxY], parented to `root`. */
function mesh(root: FakeNode, name: string, minY = 0, maxY = 10): FakeNode {
  const node: FakeNode = {
    name,
    isMesh: true,
    children: [],
    vertical: { minY, maxY },
    parent: { remove: (child) => { root.children = root.children.filter((c) => c !== child); } },
    geometry: { dispose: () => { node.disposed = true; } },
    traverse(cb) { cb(node); },
  };
  root.children.push(node);
  return node;
}

class FakeBox3 implements Box3Like {
  min = { y: Infinity };
  max = { y: -Infinity };
  setFromObject(object: unknown): Box3Like {
    let mn = Infinity, mx = -Infinity;
    (object as FakeNode).traverse((n) => {
      const v = (n as FakeNode).vertical;
      if (!v) return;
      if (v.minY < mn) mn = v.minY;
      if (v.maxY > mx) mx = v.maxY;
    });
    this.min = { y: mn };
    this.max = { y: mx };
    return this;
  }
}

const THREE: ThreeLike = { Box3: FakeBox3 };
const present = (root: FakeNode, m: FakeNode) => { let f = false; root.traverse((o) => { if (o === m) f = true; }); return f; };

// ── Label meshes (BY NAME) ───────────────────────────────────────────────

test('strips a mesh NAMED like a label (Togo_pb, logo, …), keeps the furniture', () => {
  const root = group();
  const seat = mesh(root, 'M2');
  const label = mesh(root, 'Togo_pb');
  assert.equal(stripLabelMeshes(THREE, root), 1);
  assert.ok(present(root, seat), 'furniture kept');
  assert.ok(!present(root, label), 'label removed');
  assert.ok(label.disposed, 'geometry disposed');
});

test('KEEPS real furniture parts regardless of shape/position (bolster, arm cushion)', () => {
  // The real PRADO export: seat + a flat bolster panel + a small arm-cushion plate
  // offset below the seat — none label-named, so ALL are kept whatever the geometry
  // (the shape-based rule used to eat these; the dealer confirmed they're real).
  const root = group();
  const seat = mesh(root, 'M2');
  const bolster = mesh(root, 'M3', 0, 1);        // flat panel at the front
  const armCushion = mesh(root, 'M5', -30, -20); // small plate below the seat
  assert.equal(stripLabelMeshes(THREE, root), 0, 'nothing stripped');
  assert.ok(present(root, seat) && present(root, bolster) && present(root, armCushion));
});

test('never strips ALL meshes (every mesh label-named → no-op)', () => {
  const root = group();
  const a = mesh(root, 'logo'); const b = mesh(root, 'label');
  assert.equal(stripLabelMeshes(THREE, root), 0);
  assert.ok(present(root, a) && present(root, b));
});

test('unnamed meshes are always kept', () => {
  const root = group();
  const a = mesh(root, ''); const b = mesh(root, '');
  assert.equal(stripLabelMeshes(THREE, root), 0);
  assert.ok(present(root, a) && present(root, b));
});

test('a furniture name that merely contains a label token is NOT stripped', () => {
  const root = group();
  mesh(root, 'M2');
  const arm = mesh(root, 'armrest');   // contains "arm", not a label token
  assert.equal(stripLabelMeshes(THREE, root), 0);
  assert.ok(present(root, arm));
});

test('isLabelMeshName: the default regex (word-boundary tokens + the _pb suffix) is overridable', () => {
  for (const n of ['Togo_pb', 'logo', 'Some-label', 'text_01', 'watermark', 'nameplate.001']) {
    assert.ok(isLabelMeshName(n), `${n} reads as a label`);
  }
  for (const n of ['M2', 'armrest', 'Togo Fireside', '', 'contextual']) {
    assert.ok(!isLabelMeshName(n), `${n} is furniture`);
  }
  // A collection with its own export convention passes its own classifier.
  assert.ok(isLabelMeshName('ETIQUETA_1', /etiqueta/i));
  assert.ok(!isLabelMeshName('Togo_pb', /etiqueta/i), 'a custom regex REPLACES the default');
});

// ── Ground-shadow planes (BY SHAPE) ──────────────────────────────────────

test('isGroundShadowBox is near-degenerate-only: real flat parts never match', () => {
  // A 0-thickness decal on the floor of a 72-tall model.
  assert.ok(isGroundShadowBox(0, 0, 0, 72));
  assert.ok(isGroundShadowBox(0.5, 0.6, 0, 72));
  // A bolster (≈18% tall) and a seat pad (≈10%) don't come close.
  assert.ok(!isGroundShadowBox(0, 13, 0, 72));
  assert.ok(!isGroundShadowBox(0, 7, 0, 72));
  // Flat but NOT on the floor (a tabletop) → kept.
  assert.ok(!isGroundShadowBox(70, 70.2, 0, 72));
  // Degenerate model height → never a shadow.
  assert.ok(!isGroundShadowBox(0, 0, 0, 0));
});

test('stripShadowMeshes drops the floor decal, keeps the furniture, never strips all', () => {
  const root = group();
  const seat = mesh(root, 'M1', 0, 72);
  const decal = mesh(root, 'M9', 0, 0);
  assert.equal(stripShadowMeshes(THREE, root), 1);
  assert.ok(present(root, seat) && !present(root, decal));

  // Every mesh degenerate → a naming/geometry convention we don't understand, no-op.
  const flat = group();
  const a = mesh(flat, 'a', 0, 0); const b = mesh(flat, 'b', 0, 0);
  assert.equal(stripShadowMeshes(THREE, flat), 0);
  assert.ok(present(flat, a) && present(flat, b));
});

test('cleanMeshNodes runs both strippers and reports the counts; it is idempotent', () => {
  const root = group();
  mesh(root, 'M1', 0, 72);
  mesh(root, 'M2', 0, 40);
  mesh(root, 'Togo_pb', 30, 31);
  mesh(root, 'M9', 0, 0);
  assert.deepEqual(cleanMeshNodes(THREE, root), { labels: 1, shadows: 1, removed: 2 });
  assert.deepEqual(cleanMeshNodes(THREE, root), { labels: 0, shadows: 0, removed: 0 });
  assert.equal(root.children.length, 2);

  // A missing tree is a no-op, never a throw.
  assert.deepEqual(cleanMeshNodes(THREE, null), { labels: 0, shadows: 0, removed: 0 });
});
