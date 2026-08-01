// Scene split — pins the pure math behind the batch "import a whole scene" flow:
// one pCon export with several pieces laid out on the floor → clustered back
// into individual pieces. If the clustering drifts, a batch import either fuses
// two sofas into one model or shatters one sofa into cushion-sized models.
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectUpAxis, clusterFootprints, pieceName, clusterName } from '../src/index.ts';

test('detectUpAxis: the smallest extent is up (a spread-out floor scene is wide, not tall)', () => {
  // y-up export: pieces spread over XZ, height ~72.
  assert.equal(detectUpAxis({ x: 600, y: 72, z: 400 }), 'y');
  // z-up export (3DS/Max style): floor is XY.
  assert.equal(detectUpAxis({ x: 600, y: 400, z: 72 }), 'z');
  // Degenerate (x smallest) never happens for furniture → default y.
  assert.equal(detectUpAxis({ x: 50, y: 400, z: 600 }), 'y');
  assert.equal(detectUpAxis({}), 'y');
  assert.equal(detectUpAxis(null), 'y');
});

test('clusterFootprints groups touching boxes transitively, splits across the gap', () => {
  // One sofa made of three parts (seat + two cushions overlapping it), plus an
  // armchair 100 units away: 2 clusters.
  const items = [
    { id: 'seat', min: [0, 0], max: [174, 102] },
    { id: 'cushL', min: [5, 5], max: [80, 60] },
    { id: 'cushR', min: [90, 5], max: [170, 60] },   // touches seat, NOT cushL — transitivity joins them
    { id: 'arm', min: [274, 0], max: [376, 102] },   // 100 units of air
  ];
  const clusters = clusterFootprints(items, 15);
  assert.equal(clusters.length, 2);
  const sofa = clusters.find((c) => c.includes('seat'))!;
  assert.deepEqual([...sofa].sort(), ['cushL', 'cushR', 'seat']);
  assert.deepEqual(clusters.find((c) => c.includes('arm')), ['arm']);

  // Boxes within the gap tolerance fuse (parts of one piece may not touch
  // exactly); beyond it they stay separate pieces.
  const near = clusterFootprints([
    { id: 'a', min: [0, 0], max: [100, 100] },
    { id: 'b', min: [110, 0], max: [200, 100] },   // 10 apart
  ], 15);
  assert.equal(near.length, 1, 'a 10-unit seam within a 15 gap is one piece');
  const far = clusterFootprints([
    { id: 'a', min: [0, 0], max: [100, 100] },
    { id: 'b', min: [130, 0], max: [220, 100] },   // 30 apart
  ], 15);
  assert.equal(far.length, 2, '30 units of air with a 15 gap is two pieces');

  // Empty input → no clusters, never a crash.
  assert.deepEqual(clusterFootprints([], 15), []);
  assert.deepEqual(clusterFootprints(null, 15), []);
});

test('pieceName keeps human names, drops machine noise; clusterName majority-votes', () => {
  assert.equal(pieceName('TOGO_GRAND_CANAPE'), 'TOGO GRAND CANAPE');
  assert.equal(pieceName('Togo-Fireside.001'), 'Togo Fireside');
  // GUIDs and exporter counters carry no meaning.
  assert.equal(pieceName('ed599815-8e2a-4bfe-a80c-aca16837b725'), '');
  assert.equal(pieceName('Mesh_12'), '');
  assert.equal(pieceName('Object001'), '');
  assert.equal(pieceName(''), '');

  // The most frequent meaningful name wins; all-noise falls back to Pieza N.
  assert.equal(clusterName(['Togo Sofa', 'Mesh_1', 'Togo Sofa', 'Cushion'], 0), 'Togo Sofa');
  assert.equal(clusterName(['Mesh_1', 'Object002'], 2), 'Pieza 3');
  assert.equal(clusterName([], 0), 'Pieza 1');
});
