/**
 * UNIR / SEPARAR — the ONE gesture, and the two very different things it is
 * underneath. Ported with the reference's own fixtures (`tests/meshParts.test.js`
 * additions): a real dealer row where pCon gave the frame AND the seat cushions
 * ONE material (COL0), `partKeysFor` split it into islands by shape, and the
 * cushion islands were tagged out of it. `merges` is absent — the join never had
 * a route, because `merges` moves a key's LABEL and its FINISH but never its
 * ROLE, so the island kept rendering AND BILLING as a cushion while the studio
 * drew it folded in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BILLED_ROLES,
  finishSpecOf,
  mergedKeyOf,
  partCount,
  partRoleFor,
  planPartJoin,
  planPartSplit,
} from '../src/index.ts';
import type { PartsMap } from '../src/index.ts';

const EXCLUSIF = (): PartsMap => ({
  mats: {
    COL0: 'base', COL1: 'armCushion', COL2: 'base',
    'COL0~2': 'cushion', 'COL0~3': 'cushion',
  },
});

const matsOf = (p: PartsMap): Record<string, string> => (p.mats || {}) as Record<string, string>;
const bag = (v: unknown): Record<string, unknown> => (v || {}) as Record<string, unknown>;

test('planPartJoin UN-SPLITS an island back into its own material — the case that had no route', () => {
  const before = EXCLUSIF();
  const next = planPartJoin(before, 'COL0', ['COL0~2']);

  // The gesture is not a no-op on the data the way `merges` alone was: the
  // island now GROUPS with COL0 *and* RESOLVES as COL0.
  assert.equal(mergedKeyOf(next, 'COL0~2'), 'COL0', 'it groups with the frame');
  assert.equal(partRoleFor(next, null, -1, 'COL0~2'), 'base', 'and it PLAYS the frame — the half `merges` never moved');
  // Minimal by construction: a split island inheriting its material's tag is
  // exactly the state it had before anyone split anything, so it carries no tag
  // of its own. An untagged mesh is NOT the same as one tagged `base` — a scene
  // renders a factory-textured mesh as-is only while nothing claims it — so
  // stamping every key touched would repaint parts.
  assert.equal('COL0~2' in matsOf(next), false, 'no tag of its own: it inherits, as it did before the split');
  // Nothing else moved.
  assert.equal(matsOf(next).COL0, 'base');
  assert.equal(matsOf(next).COL1, 'armCushion');
  assert.equal(partRoleFor(next, null, -1, 'COL0~3'), 'cushion', 'the OTHER island keeps its own tag');
  // The input is never mutated — a studio holds it as a draft.
  assert.deepEqual(before, EXCLUSIF());
});

test('planPartJoin MERGES two different materials — same gesture, the other case', () => {
  // Two pCon materials, one of them a structure. Here the member cannot inherit
  // anything (its base key is itself), so the role must be written explicitly or
  // it silently falls back to `base` — a different fabric, and for a billed role
  // a different price.
  const parts: PartsMap = { mats: { metal_01: 'structure', metal_02: 'base' } };
  const next = planPartJoin(parts, 'metal_01', ['metal_02']);
  assert.equal(bag(next.merges).metal_02, 'metal_01');
  assert.equal(matsOf(next).metal_02, 'structure', 'written, because nothing would have inherited it');
  assert.equal(partRoleFor(next, null, -1, 'metal_02'), 'structure');
  // A target is never itself a child (that is what keeps mergedKeyOf loop-free),
  // and joining a key to itself is a no-op.
  assert.equal('metal_01' in bag(next.merges), false);
  assert.deepEqual(planPartJoin(parts, 'metal_01', ['metal_01']), parts);
});

test('planPartJoin gives back the billed slot it emptied — a phantom cushion never bills', () => {
  // Both cushion islands joined into the frame ⇒ the model no longer HAS a
  // cushion, so the cushion SKU and its typed quantity must go with it. Left
  // behind, `partCount` reads the explicit count first and bills a part SKU on a
  // tagging that has no such part.
  const parts: PartsMap = {
    ...EXCLUSIF(),
    roots: { cushion: 'PRADO-COJ', armCushion: 'PRADO-BRZ' },
    counts: { cushion: 3, armCushion: 2 },
  };
  const next = planPartJoin(parts, 'COL0', ['COL0~2', 'COL0~3']);
  assert.equal(partCount(next, 'cushion'), 0, 'nothing left to bill');
  assert.equal(bag(next.roots).cushion, undefined);
  assert.equal(bag(next.counts).cushion, undefined);
  // A role somebody still holds is untouched — the release is surgical.
  assert.equal(bag(next.roots).armCushion, 'PRADO-BRZ');
  assert.equal(partCount(next, 'armCushion'), 2);
  assert.ok(BILLED_ROLES.includes('cushion') && !BILLED_ROLES.includes('structure'));
});

test('joining does not ORPHAN a palette — it moves, or it yields to the target', () => {
  const palette = { options: [{ id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1 }], default: 'acero' };
  const otra = { options: [{ id: 'laca', label: 'Laca', rgb: '#17181c' }] };

  // The target has none ⇒ it ADOPTS the member's. A palette left on a key
  // nothing renders is worse than dead: a collection fan-out reads `finishes`
  // as evidence the model has that group and keeps fanning it out forever.
  const a = planPartJoin(
    {
      mats: { patas: 'structure', 'patas~2': 'structure' },
      finishes: { 'patas~2': palette },
      labels: { 'patas~2': 'Patas traseras' },
    },
    'patas', ['patas~2'],
  );
  assert.equal('patas~2' in bag(a.finishes), false, 'no palette left on a key that is no longer a group');
  assert.deepEqual(bag(a.finishes).patas, palette, 'it moved to the group that now renders it');
  assert.equal(bag(a.labels).patas, 'Patas traseras', 'and so did the name — the target had none');
  assert.ok(finishSpecOf(a, 'patas~2'), 'the folded key still resolves a palette, through its target');

  // The target already has one ⇒ the target's identity wins, and the member's is
  // REMOVED rather than kept as a second, unreachable copy.
  const b = planPartJoin(
    {
      mats: { patas: 'structure', marco: 'structure' },
      finishes: { patas: palette, marco: otra },
      labels: { patas: 'Patas', marco: 'Marco' },
    },
    'patas', ['marco'],
  );
  assert.deepEqual(b.finishes, { patas: palette });
  assert.deepEqual(b.labels, { patas: 'Patas' });
});

test('planPartSplit is the same gesture in reverse — natively grouped or dealer-joined, it does not care', () => {
  // (1) UNDO a join: the island comes back out as its own group, still resolving
  // through the role it wore, with no leftover merge entry.
  const joined = planPartJoin(EXCLUSIF(), 'COL0', ['COL0~2']);
  const undone = planPartSplit(joined, 'COL0', ['COL0~2']);
  assert.equal(mergedKeyOf(undone, 'COL0~2'), 'COL0~2', 'its own group again');
  assert.equal(partRoleFor(undone, null, -1, 'COL0~2'), 'base',
    'it keeps the role it was WEARING inside the group — separating never re-files a part');

  // (2) UNGROUP what came grouped from the FILE. `COL1` was never joined by
  // anybody; it is one pCon material split into islands, and the dealer must be
  // able to take one out without knowing that. The island carries no tag and no
  // merge entry — only inheritance — and it still separates.
  const native: PartsMap = { mats: { COL1: 'structure' } };
  const apart = planPartSplit(native, 'COL1', ['COL1~2']);
  assert.equal(mergedKeyOf(apart, 'COL1~2'), 'COL1~2');
  assert.equal(partRoleFor(apart, null, -1, 'COL1~2'), 'structure',
    'the role it inherited is the role it leaves with — never a silent drop to base');
  assert.equal(matsOf(apart).COL1, 'structure', 'and the material it left is untouched');

  // (3) A cross-material member leaves with an EXPLICIT tag, because there is
  // nothing for it to inherit from.
  const two = planPartJoin({ mats: { metal_01: 'structure', metal_02: 'base' } }, 'metal_01', ['metal_02']);
  const back = planPartSplit(two, 'metal_01', ['metal_02']);
  assert.equal(matsOf(back).metal_02, 'structure');
  assert.equal(bag(back.merges).metal_02, undefined);

  // You cannot separate a group from itself, and an empty ask changes nothing.
  assert.deepEqual(planPartSplit(joined, 'COL0', ['COL0']), joined);
  assert.deepEqual(planPartSplit(joined, 'COL0', []), joined);
});

test('a join/separate round trip loses neither a tagged role nor a palette', () => {
  const palette = { options: [{ id: 'acero', label: 'Acero', rgb: '#8a8f98', metal: 1 }], default: 'acero' };
  const start: PartsMap = {
    mats: { COL0: 'base', 'COL0~2': 'cushion', patas: 'structure' },
    finishes: { patas: palette },
    labels: { patas: 'Patas' },
    roots: { cushion: 'PRADO-COJ' },
    counts: { cushion: 2 },
  };
  const joined = planPartJoin(start, 'COL0', ['COL0~2']);
  const back = planPartSplit(joined, 'COL0', ['COL0~2']);

  // The ROLE survives the trip in both directions: it comes back wearing what
  // the GROUP wore, which is the honest answer — the dealer said "this is part
  // of the frame", and undoing the grouping does not un-say it. What must never
  // happen is a silent third answer, so this is pinned rather than left to chance.
  assert.equal(partRoleFor(back, null, -1, 'COL0~2'), 'base');
  assert.equal(partRoleFor(back, null, -1, 'COL0'), 'base');
  assert.equal(partRoleFor(back, null, -1, 'patas'), 'structure', 'an untouched group is untouched');
  // The palette of a group nobody joined is exactly where it was.
  assert.deepEqual(back.finishes, { patas: palette });
  assert.deepEqual(back.labels, { patas: 'Patas' });
  // And the billed slot the join emptied stays given back — re-separating the
  // mesh does not resurrect a SKU the tagging no longer implies.
  assert.equal(partCount(back, 'cushion'), 0);
  assert.equal(bag(back.roots).cushion, undefined);
});

test('join/split never throw on a half-typed parts bag', () => {
  // `parts` is dealer-authored jsonb and reaches these two straight off the row.
  const junk: unknown[] = [null, undefined, 'nope', 42, [], { mats: 'no' }, { merges: [] }, { mats: null, finishes: 7 }];
  for (const bad of junk) {
    assert.doesNotThrow(() => planPartJoin(bad as PartsMap, 'a', ['b']));
    assert.doesNotThrow(() => planPartSplit(bad as PartsMap, 'a', ['b']));
  }
  assert.doesNotThrow(() => planPartJoin({ mats: { a: 'base' } }, '', ['a']));
  assert.doesNotThrow(() => planPartJoin({ mats: { a: 'base' } }, 'a', [null, '', undefined]));
  // A hand-edited merge LOOP resolves to a real group instead of hanging, and
  // the join still lands somewhere legal.
  const loop: PartsMap = { mats: { a: 'cushion', b: 'base' }, merges: { a: 'b', b: 'a' } };
  assert.doesNotThrow(() => planPartJoin(loop, 'a', ['c']));
  assert.doesNotThrow(() => planPartSplit(loop, 'a', ['b']));
});

test('regrouping never strips a tag the dealer already put there', () => {
  // An UNTAGGED mesh and one tagged `base` are different things to the renderer:
  // a scene shows a factory-textured mesh (walnut, lacquer) as-is only while
  // nothing claims it, and an explicit `base` is what overrides it with fabric.
  // So a key whose tag ALREADY says what the group says is left exactly as it
  // is — otherwise joining a part and separating it again would silently repaint
  // it, which is a round trip that isn't one.
  const start: PartsMap = { mats: { COL0: 'base', COL2: 'base' } };
  const joined = planPartJoin(start, 'COL0', ['COL2']);
  assert.equal(matsOf(joined).COL2, 'base', 'the explicit tag survives the join');
  const back = planPartSplit(joined, 'COL0', ['COL2']);
  assert.equal(matsOf(back).COL2, 'base', 'and the separation');
  assert.deepEqual(back.mats, start.mats, 'mats comes back exactly as it went in');

  // And the mirror: a key with NO tag joined into a `base` group stays untagged,
  // so its factory finish is never claimed by a regrouping it didn't ask for.
  const untagged = planPartJoin({ mats: { COL0: 'base' } }, 'COL0', ['nogal']);
  assert.equal('nogal' in matsOf(untagged), false);
  assert.equal(partRoleFor(untagged, null, -1, 'nogal'), 'base');
});
