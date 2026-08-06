// The import's per-solid split, at the seam where materials cross it. Through
// v6 this bailed on ANY multi-material mesh — and the Ligne Roset 3DS library
// ships every product as one mesh with several materials, so the topological
// classifier never ran on the catalogue at all and "parts" were material
// groups. These pin that a body is a body whatever it is painted with.
import test from 'node:test';
import assert from 'node:assert/strict';

import { splitGeometryBySolid } from '../src/components/togo/sceneImport.js';

// ── The slice of three.js `subGeometry` actually touches. No WebGL, no real
// three: the split is buffer arithmetic and this is every method it calls.
class BufferAttribute {
  constructor(array, itemSize, normalized = false) {
    this.array = array;
    this.itemSize = itemSize;
    this.normalized = normalized;
    this.count = Math.floor(array.length / itemSize);
  }
}
class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.morphAttributes = {};
    this.groups = [];
    this.index = null;
  }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  setIndex(attr) { this.index = attr; return this; }
  addGroup(start, count, materialIndex) { this.groups.push({ start, count, materialIndex }); }
}
const THREE = { BufferGeometry, BufferAttribute };

/** A closed 12-triangle box, the way an exporter writes one (24 vertices). */
function box(cx, cy, cz, s) {
  const h = s / 2;
  const corner = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  const positions = []; const indices = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const ci of f) positions.push(corner[ci][0] + cx, corner[ci][1] + cy, corner[ci][2] + cz);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
}

/** One geometry from several primitives, with draw groups over triangle RANGES. */
function geometryOf(parts, groups) {
  const positions = []; const indices = [];
  for (const p of parts) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    for (const i of p.indices) indices.push(i + base);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  g.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
  for (const [fromTri, toTri, materialIndex] of groups) {
    g.addGroup(fromTri * 3, (toTri - fromTri) * 3, materialIndex);
  }
  return g;
}

/** Every material index a piece's groups name, with its triangle count. */
const materialsOf = (piece) => piece.groups.map((g) => [g.materialIndex, g.count / 3]);

test('REGRESSION: a multi-material mesh SPLITS — it used to bail and never segment at all', () => {
  // Three separate bodies painted with two materials — the EXCLUSIF shape,
  // where one material (0) spans two bodies. Bodies are what parts are.
  const g = geometryOf(
    [box(0, 0, 0, 2), box(10, 0, 0, 1.5), box(20, 0, 0, 1)],
    [[0, 24, 0], [24, 36, 1]],
  );
  return splitGeometryBySolid(THREE, g).then((pieces) => {
    assert.equal(pieces.length, 3, 'one piece per BODY, not per material');
    assert.equal(pieces.reduce((n, p) => n + p.index.count / 3, 0), 36, 'no triangle lost');
  });
});

test('the material assignment rides ACROSS the split — each body keeps what it was painted with', async () => {
  const g = geometryOf(
    [box(0, 0, 0, 2), box(10, 0, 0, 1.5), box(20, 0, 0, 1)],
    [[0, 24, 0], [24, 36, 1]],
  );
  const pieces = await splitGeometryBySolid(THREE, g);
  // Solids come back largest first, so the order is the box order above.
  assert.deepEqual(materialsOf(pieces[0]), [[0, 12]], 'biggest body — material 0');
  assert.deepEqual(materialsOf(pieces[1]), [[0, 12]], 'second body shares material 0');
  assert.deepEqual(materialsOf(pieces[2]), [[1, 12]], 'third body — material 1');
});

test('a body spanning TWO materials keeps both, as contiguous groups covering it whole', async () => {
  // One box whose faces are painted half and half, plus a far-away second body.
  const g = geometryOf([box(0, 0, 0, 2), box(10, 0, 0, 1)], [[0, 6, 0], [6, 12, 1], [12, 24, 0]]);
  const pieces = await splitGeometryBySolid(THREE, g);
  assert.equal(pieces.length, 2);
  const split = pieces[0];
  assert.deepEqual(materialsOf(split), [[0, 6], [1, 6]], 'both materials survive on the one body');
  const covered = split.groups.reduce((n, x) => n + x.count, 0);
  assert.equal(covered, split.index.count, 'the groups cover the primitive exactly — nothing undrawn');
  // Contiguity is what makes them valid draw ranges at all.
  assert.deepEqual(split.groups.map((x) => x.start), [0, 6 * 3]);
  assert.deepEqual(materialsOf(pieces[1]), [[0, 12]]);
});

test('a face no group covers stays uncovered — the split never invents geometry to draw', async () => {
  // Group names only the first box; the second is outside every group and, with
  // a material array, three draws exactly nothing for it. That must not change.
  const g = geometryOf([box(0, 0, 0, 2), box(10, 0, 0, 1)], [[0, 12, 0]]);
  const pieces = await splitGeometryBySolid(THREE, g);
  assert.equal(pieces.length, 2);
  assert.deepEqual(materialsOf(pieces[0]), [[0, 12]]);
  assert.deepEqual(pieces[1].groups, [], 'uncovered before, uncovered after');
});

test('a single-material mesh still splits, and keeps its one group', async () => {
  const g = geometryOf([box(0, 0, 0, 2), box(10, 0, 0, 1)], [[0, 24, 0]]);
  const pieces = await splitGeometryBySolid(THREE, g);
  assert.equal(pieces.length, 2);
  assert.deepEqual(materialsOf(pieces[0]), [[0, 12]]);
  assert.deepEqual(materialsOf(pieces[1]), [[0, 12]]);
});

test('morph targets still bail — a per-mass index would lose the morph', async () => {
  const g = geometryOf([box(0, 0, 0, 2), box(10, 0, 0, 1)], [[0, 24, 0]]);
  g.morphAttributes = { position: [] };
  const pieces = await splitGeometryBySolid(THREE, g);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0], g, 'the geometry comes back verbatim');
});

test('one body comes back whole — splitting is for meshes that hold more than one', async () => {
  const g = geometryOf([box(0, 0, 0, 2)], [[0, 12, 0]]);
  const pieces = await splitGeometryBySolid(THREE, g);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0], g);
});
