// THE PARTS WORKFLOW — the four things "detect parts" has to get right, each of
// which was a real misfiling in the reference before it was pinned:
//
//   • BOXES FIRST, THEN KEYS. One material upholstering two part TYPES must
//     split by shape; merging its boxes first averaged a cushion slab and a
//     bolster roll into a box that is neither, and the two could then never be
//     tagged, priced or re-covered separately.
//   • A FINGERPRINT IS IDENTITY. pCon reuses one material id per part type
//     across a collection, so a sofa group sharing the loose cushion's material
//     IS that cushion — and it outranks every heuristic.
//   • A RULO IS ELONGATED *AND SMALL*. Elongation alone filed a fused
//     three-cushion slab as a bolster.
//   • EXISTING DEALER CHOICES ALWAYS WIN. A re-run may only fill NEW keys.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accessoryRefFrom,
  classifyPartGroups,
  detectParts,
  partGroupsFrom,
  partGroupsInCm,
} from '../src/vm/parts.ts';
import type { MeasuredNode } from '../src/vm/types.ts';

const node = (materialName: string | null, min: [number, number, number], size: [number, number, number]): MeasuredNode => ({
  materialName,
  min,
  max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]],
  size,
});

const box = (key: string, min: [number, number, number], size: [number, number, number]) => ({
  key,
  min,
  max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] as [number, number, number],
});

test('boxes first, then keys: one material over two shapes splits into clusters', () => {
  // A platform, three near-identical back cushions and a bolster — the cushions
  // and the bolster share ONE material, exactly as the misbehaving export did.
  const nodes: MeasuredNode[] = [
    node('platform', [0, 0, 0], [200, 30, 90]),
    node('cloth', [10, 30, 10], [55, 50, 25]),
    node('cloth', [70, 30, 10], [55, 50, 25]),
    node('cloth', [130, 30, 10], [55, 50, 25]),
    node('cloth', [20, 30, 60], [160, 16, 16]),   // the roll
  ];
  const groups = partGroupsFrom(nodes);
  const keys = groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ['cloth', 'cloth~2', 'platform']);

  const roles = classifyPartGroups(partGroupsInCm(groups));
  assert.equal(roles.platform, 'base');
  assert.equal(roles.cloth, 'cushion', 'the slab cluster is a cushion');
  assert.equal(roles['cloth~2'], 'bolster', 'the roll cluster is a rulo');
});

test('a rulo is elongated AND small — a fused cushion slab is not one', () => {
  // The measured Prado Medium 120: three back cushions export FUSED as one
  // 174×66×50 slab, which is "elongated" too. Height is what tells them apart.
  const groups = [
    box('base', [0, 0, 0], [190, 20, 95]),
    box('slab', [8, 20, 8], [174, 50, 66]),
    box('rulo', [15, 20, 70], [160, 16, 16]),
  ];
  const roles = classifyPartGroups(groups);
  assert.equal(roles.slab, 'cushion');
  assert.equal(roles.rulo, 'bolster');
});

test('a material fingerprint outranks the heuristics', () => {
  const groups = [
    box('base', [0, 0, 0], [200, 30, 90]),
    // Shaped like a cushion, but it wears the loose BOLSTER model's material.
    box('shared-mat', [20, 30, 20], [60, 45, 30]),
  ];
  const roles = classifyPartGroups(groups, [{ role: 'bolster', matKeys: ['shared-mat'], size: [160, 16, 16] }]);
  assert.equal(roles['shared-mat'], 'bolster');
});

test('a SPLIT cluster ignores the material fingerprint — its shape is all it has', () => {
  // The material is shared with another part type ON THIS MODEL: taking it would
  // hand the bolster the cushion's role and undo the split that found it.
  const groups = [
    box('base', [0, 0, 0], [200, 30, 90]),
    box('cloth', [10, 30, 10], [55, 50, 25]),
    box('cloth~2', [20, 30, 60], [160, 16, 16]),
  ];
  const roles = classifyPartGroups(groups, [{ role: 'cushion', matKeys: ['cloth', 'cloth~2'], size: [55, 50, 25] }]);
  assert.equal(roles.cloth, 'cushion');
  assert.equal(roles['cloth~2'], 'bolster', 'the split cluster is classified by shape');
});

test('an accessory fingerprint comes off the standalone model, in cm', () => {
  // A metre-unit export of a 55 cm cushion: the unit guard brings it to cm so
  // the size comparison is like for like.
  const ref = accessoryRefFrom('Back Cushion', [node('cushion-mat', [0, 0, 0], [0.55, 0.5, 0.25])]);
  assert.ok(ref);
  assert.equal(ref!.role, 'cushion');
  assert.deepEqual(ref!.matKeys, ['cushion-mat']);
  assert.ok(Math.abs(ref!.size[0] - 55) < 1e-6, `expected ~55 cm, got ${ref!.size[0]}`);
});

test('a sofa is not an accessory — only a recognizable name fingerprints', () => {
  assert.equal(accessoryRefFrom('Prado 2 seat', [node('m', [0, 0, 0], [1, 1, 1])]), null);
});

test('the materialization pair: a body over a recessed plinth is two zones, not a cushion', () => {
  // The measured ottomans: body 8..41 cm over a RECESSED plinth 0..8 cm, and
  // nothing above. The plinth is recessed enough that it does not read as a
  // second platform (<40% of the footprint), which is what leaves it as the
  // only untagged group and reveals the pair.
  const groups = [
    box('body', [0, 8, 0], [90, 33, 90]),
    box('plinth', [16, 0, 16], [55, 8, 55]),
  ];
  const roles = classifyPartGroups(groups);
  assert.equal(roles.body, 'exterior');
  assert.equal(roles.plinth, 'interior');
});

test('a model is never all-cushions: the biggest footprint anchors as base', () => {
  const roles = classifyPartGroups([
    box('a', [0, 40, 0], [120, 40, 80]),
    box('b', [0, 90, 0], [40, 20, 30]),
  ]);
  assert.equal(roles.a, 'base');
});

test('detect only fills NEW keys — a confirmed choice is never overwritten', () => {
  const nodes: MeasuredNode[] = [
    node('platform', [0, 0, 0], [200, 30, 90]),
    node('cloth', [70, 30, 10], [55, 50, 25]),   // mid-span: not an arm cushion
  ];
  const stored = { mats: { platform: 'structure' }, roots: { cushion: 'X-1' } };
  const result = detectParts({ nodes, parts: stored });
  assert.equal(result.proposal.platform, 'base', 'the classifier still says base…');
  assert.equal((result.parts.mats as Record<string, string>).platform, 'structure', '…but the dealer wins');
  assert.equal((result.parts.mats as Record<string, string>).cloth, 'cushion');
  assert.deepEqual(result.kept, ['platform']);
  assert.deepEqual(result.added, ['cloth']);
  assert.deepEqual(result.parts.roots, { cushion: 'X-1' }, 'nothing else in the draft is touched');
});

test('a z-up export is classified in the same frame as a y-up one', () => {
  const yUp: MeasuredNode[] = [
    node('platform', [0, 0, 0], [200, 30, 90]),
    node('cloth', [10, 30, 10], [55, 50, 25]),
  ];
  // The same piece exported z-up: the vertical axis is the third one.
  const zUp: MeasuredNode[] = [
    node('platform', [0, 0, 0], [200, 90, 30]),
    node('cloth', [10, 10, 30], [55, 25, 50]),
  ];
  const a = classifyPartGroups(partGroupsInCm(partGroupsFrom(yUp, 'y')));
  const b = classifyPartGroups(partGroupsInCm(partGroupsFrom(zUp, 'z')));
  assert.deepEqual(b, a);
});

test('no geometry is an empty proposal, not a throw', () => {
  const result = detectParts({ nodes: [], parts: { mats: { a: 'base' } } });
  assert.deepEqual(result.proposal, {});
  assert.deepEqual(result.parts.mats, { a: 'base' });
});
