/**
 * THE PICK — "the click lands where it looks", pinned over the hit list.
 *
 * Ported from the reference stage (RosetSoft c313ecd): the grab pad demoted, a
 * tagged part preferred over the body mass behind it, and the screen-space ring
 * of mercy that makes a 15-px estructura hittable with a fingertip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RING_R_MOUSE, RING_R_TOUCH, RING_SPOKES,
  preferPick, resolvePickHit, ringRadiusFor, ringSamples,
} from '../src/picking.ts';
import type { PickHit, PickIntersection } from '../src/picking.ts';

/** A hit whose mesh hangs under a piece group — the shape the builder produces. */
const hit = (
  { uid = 'a', role = null as string | null, key = null as string | null, pad = false, distance = 10 } = {},
): PickIntersection => ({
  object: {
    userData: { ...(role != null ? { partRole: role } : {}), ...(key != null ? { partKey: key } : {}), ...(pad ? { pad: true } : {}) },
    parent: { userData: { uid }, parent: null },
  },
  distance,
});

test('the grab pad is DEMOTED: a real mesh further along the ray outranks it', () => {
  // The pad lies flat just off the ground and the estructura's metal sits a
  // couple of cm BEHIND it, so first-hit-wins answered "the body, nothing in
  // particular" at essentially every visible skid pixel.
  const got = resolvePickHit([hit({ pad: true, distance: 8 }), hit({ role: 'structure', key: 'legs', distance: 11 })]);
  assert.equal(got?.pad, false);
  assert.equal(got?.partRole, 'structure');
  assert.equal(got?.partKey, 'legs');
});

test('…and it still answers when the ray met no real mesh at all', () => {
  const got = resolvePickHit([hit({ pad: true, distance: 8 })]);
  assert.equal(got?.pad, true);
  assert.equal(got?.uid, 'a');
  // "Somewhere on this piece, nothing in particular" — role and key are null by
  // construction, which is exactly the job the pad was added for (drag me).
  assert.equal(got?.partRole, null);
  assert.equal(got?.partKey, null);
  assert.equal(resolvePickHit([]), null, 'nothing under the pointer is null, never a pad');
  assert.equal(resolvePickHit(null), null);
});

test('the role and key come from the NEAREST tagged ancestor, and the uid ends the walk', () => {
  const nested: PickIntersection = {
    object: {
      userData: {},                                        // an untagged leaf…
      parent: { userData: { partRole: 'cushion', partKey: 'seat' }, parent: { userData: { uid: 'p1' }, parent: null } },
    },
    distance: 4,
  };
  assert.deepEqual(resolvePickHit([nested]), { uid: 'p1', partRole: 'cushion', partKey: 'seat', pad: false, distance: 4 });
});

test('preferPick: a TAGGED part beats the body mass behind it', () => {
  const body: PickHit = { uid: 'a', partRole: 'base', partKey: null, pad: false, distance: 5 };
  const legs: PickHit = { uid: 'a', partRole: 'structure', partKey: 'legs', pad: false, distance: 9 };
  // …even though the body is NEARER: the ring exists because thin estructura is
  // hard to hit, and the body under it is already reachable everywhere.
  assert.equal(preferPick([{ hit: body, radius: 3.5 }, { hit: legs, radius: 7 }]), legs);
});

test('preferPick: then the smaller radius, then the shorter ray — and ties never move', () => {
  const near: PickHit = { uid: 'a', partRole: 'cushion', partKey: 'c1', pad: false, distance: 9 };
  const far: PickHit = { uid: 'a', partRole: 'cushion', partKey: 'c2', pad: false, distance: 4 };
  assert.equal(preferPick([{ hit: far, radius: 7 }, { hit: near, radius: 3.5 }]), near, 'nearer to where they pointed');
  assert.equal(
    preferPick([{ hit: near, radius: 7 }, { hit: far, radius: 7 }]), far,
    'same radius ⇒ the front of the sofa, not through it',
  );
  // Strictly-better comparison: the FIRST candidate wins every tie, so the
  // answer can never depend on the spoke order.
  const a: PickHit = { ...near, partKey: 'first' };
  const b: PickHit = { ...near, partKey: 'second' };
  assert.equal(preferPick([{ hit: a, radius: 7 }, { hit: b, radius: 7 }])?.partKey, 'first');
  assert.equal(preferPick([{ hit: b, radius: 7 }, { hit: a, radius: 7 }])?.partKey, 'second');
  assert.equal(preferPick([{ hit: null, radius: 3.5 }]), null, 'empty candidates answer null');
  assert.equal(preferPick([]), null);
});

test('the ring: 8 spokes at r and 2r, a finger twice a mouse', () => {
  assert.equal(ringRadiusFor('mouse'), RING_R_MOUSE);
  assert.equal(ringRadiusFor('pen'), RING_R_MOUSE);
  assert.equal(ringRadiusFor(undefined), RING_R_MOUSE, 'an absent pointerType takes the tight ring');
  assert.equal(ringRadiusFor('touch'), RING_R_TOUCH);
  assert.equal(RING_R_TOUCH, RING_R_MOUSE * 2);

  const pts = ringSamples(100, 100, RING_R_MOUSE);
  assert.equal(pts.length, RING_SPOKES * 2, 'two rings of eight');
  const radii = [...new Set(pts.map((p) => p.radius))];
  assert.deepEqual(radii, [RING_R_MOUSE, RING_R_MOUSE * 2]);
  for (const p of pts) {
    assert.ok(Math.abs(Math.hypot(p.x - 100, p.y - 100) - p.radius) < 1e-9, 'every spoke lands on its own circle');
  }
  // The exact ray is the caller's first cast — the ring never repeats it, or a
  // pad hit at the centre would be re-adopted as a candidate.
  assert.equal(pts.some((p) => p.x === 100 && p.y === 100), false);
});
