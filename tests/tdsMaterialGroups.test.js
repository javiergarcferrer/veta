// The .3ds material→face repair. three.js's TDSLoader hands each material a
// CONSECUTIVE slice of the index buffer while the file assigns materials by
// explicit face LISTS ("assuming successive indices", its own source says), so
// on any real product mesh every material lands on the wrong geometry. These
// pin the parse and the permutation that puts them back.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readTdsMaterialGroups, reorderIndexForGroups } from '../src/lib/configurator/tdsMaterialGroups.js';

/** A 3DS chunk: uint16 id, uint32 length (header included), payload. */
function chunk(id, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(id, 0);
  head.writeUInt32LE(body.length + 6, 2);
  return Buffer.concat([head, body]);
}
const u16 = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeUInt16LE(x, i * 2)); return b; };
const name = (s) => Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0])]);

/** A one-object .3ds with `faces` faces and the given material groups. */
function tdsFile(objName, faces, groups) {
  const faceData = [];
  for (let i = 0; i < faces; i += 1) faceData.push(i * 3, i * 3 + 1, i * 3 + 2, 0);  // + visibility word
  return chunk(0x4d4d, chunk(0x3d3d, chunk(0x4000, name(objName), chunk(0x4100,
    chunk(0x4120, u16(faces), u16(...faceData), ...groups.map((g) => chunk(0x4130, name(g.name), u16(g.faces.length), u16(...g.faces)))),
  ))));
}

/** The index buffer a loader builds for `faces` faces: 3 consecutive ids each. */
const indexFor = (faces) => Uint32Array.from({ length: faces * 3 }, (_, i) => i);

/** Which face ordinals a permuted index buffer holds, in order. */
const facesOf = (index) => Array.from({ length: index.length / 3 }, (_, i) => index[i * 3] / 3);

test('the material groups are read as explicit face LISTS, in file order', () => {
  // Scattered on purpose — this is the shape TDSLoader mis-reads.
  const buf = tdsFile('Chair', 6, [
    { name: 'Fabric', faces: [1, 3, 5] },
    { name: 'Legs', faces: [0, 2, 4] },
  ]);
  const [obj] = readTdsMaterialGroups(buf);
  assert.equal(obj.name, 'Chair');
  assert.equal(obj.faceCount, 6);
  assert.deepEqual(obj.groups.map((g) => g.name), ['Fabric', 'Legs'], 'file order — the order TDSLoader reads them in');
  assert.deepEqual([...obj.groups[0].faces], [1, 3, 5]);
  assert.deepEqual([...obj.groups[1].faces], [0, 2, 4]);
});

test('REGRESSION (the EXCLUSIF chair): the permutation makes consecutive-range groups TRUE', () => {
  // The loader will claim faces 0–2 are Fabric and 3–5 are Legs. Reordering is
  // what makes that claim describe the geometry instead of scrambling it.
  const [obj] = readTdsMaterialGroups(tdsFile('Chair', 6, [
    { name: 'Fabric', faces: [1, 3, 5] },
    { name: 'Legs', faces: [0, 2, 4] },
  ]));
  const out = reorderIndexForGroups(indexFor(6), obj.groups, obj.faceCount);
  assert.deepEqual(facesOf(out), [1, 3, 5, 0, 2, 4], 'group 0 first, then group 1');
  // The loader's own group ranges now name the right faces.
  assert.deepEqual(facesOf(out).slice(0, 3), [1, 3, 5], 'range [0,3) really is Fabric');
  assert.deepEqual(facesOf(out).slice(3), [0, 2, 4], 'range [3,6) really is Legs');
});

test('a face no material claims is kept, after the grouped ones — never dropped', () => {
  const [obj] = readTdsMaterialGroups(tdsFile('Chair', 5, [{ name: 'Fabric', faces: [3, 1] }]));
  const out = reorderIndexForGroups(indexFor(5), obj.groups, obj.faceCount);
  assert.equal(out.length / 3, 5, 'every face survives the permutation');
  assert.deepEqual(facesOf(out), [3, 1, 0, 2, 4], 'unclaimed faces keep their relative order, outside the group');
});

test('the permutation carries each face\'s OWN corner indices, not its slot', () => {
  // A permutation that moved faces without their vertices would scramble the
  // mesh — far worse than the mis-paint it is fixing.
  const index = Uint32Array.from([10, 11, 12, 20, 21, 22, 30, 31, 32]);
  const [obj] = readTdsMaterialGroups(tdsFile('Chair', 3, [{ name: 'M', faces: [2, 0, 1] }]));
  const out = reorderIndexForGroups(index, obj.groups, obj.faceCount);
  assert.deepEqual([...out], [30, 31, 32, 10, 11, 12, 20, 21, 22]);
});

test('ambiguous or impossible face lists REFUSE — the caller keeps the raw geometry', () => {
  const groups = (faces) => [{ name: 'M', faces }];
  assert.equal(reorderIndexForGroups(indexFor(4), groups([9]), 4), null, 'face ordinal past the end');
  assert.equal(reorderIndexForGroups(indexFor(4), groups([-1]), 4), null, 'negative ordinal');
  assert.equal(reorderIndexForGroups(indexFor(4), [{ name: 'A', faces: [1] }, { name: 'B', faces: [1] }], 4), null,
    'two materials claiming one face — the permutation would be a guess');
  assert.equal(reorderIndexForGroups(indexFor(4), [], 4), null, 'nothing to order by');
  assert.equal(reorderIndexForGroups(null, groups([0]), 4), null);
  assert.equal(reorderIndexForGroups(indexFor(2), groups([0]), 4), null, 'index shorter than the face count');
});

test('junk in, empty out — a repair that cannot read its input does nothing', () => {
  assert.deepEqual(readTdsMaterialGroups(null), []);
  assert.deepEqual(readTdsMaterialGroups(Buffer.alloc(0)), []);
  assert.deepEqual(readTdsMaterialGroups(Buffer.from([1, 2, 3])), []);
  assert.deepEqual(readTdsMaterialGroups(Buffer.alloc(64)), [], 'zero-length chunks must not loop forever');
  // A truncated file: the header promises more than the buffer holds.
  const truncated = tdsFile('Chair', 4, [{ name: 'M', faces: [0, 1] }]).subarray(0, 20);
  assert.deepEqual(readTdsMaterialGroups(truncated), []);
});

test('an object with no faces is not reported — nothing to repair', () => {
  const buf = chunk(0x4d4d, chunk(0x3d3d, chunk(0x4000, name('Empty'), chunk(0x4100))));
  assert.deepEqual(readTdsMaterialGroups(buf), []);
});

test('several objects come back in file order — meshes pair with them by position', () => {
  const one = chunk(0x4000, name('A'), chunk(0x4100, chunk(0x4120, u16(2), u16(0, 1, 2, 0, 3, 4, 5, 0),
    chunk(0x4130, name('MA'), u16(1), u16(1)))));
  const two = chunk(0x4000, name('B'), chunk(0x4100, chunk(0x4120, u16(1), u16(0, 1, 2, 0),
    chunk(0x4130, name('MB'), u16(1), u16(0)))));
  const objs = readTdsMaterialGroups(chunk(0x4d4d, chunk(0x3d3d, one, two)));
  assert.deepEqual(objs.map((o) => o.name), ['A', 'B']);
  assert.deepEqual(objs.map((o) => o.faceCount), [2, 1]);
});
