/**
 * THE HIGHLIGHT'S SCOPE — what the gold line promises the next click will edit.
 *
 * `focusMeshes` and its `exclude` amendment are ported verbatim from the
 * reference (RosetSoft's togoConfigurator pins, 3427af2), plus the precedence
 * rule that commit closed: a RESTING focus yields to the hover cue, a COMMITTED
 * one does not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DRESSABLE_ROLE, dressableExclusions, focusMeshes, resolveHighlightScope } from '../src/highlight.ts';

const M = (partRole: string, partKey: string | null = null) => ({ userData: { partRole, ...(partKey ? { partKey } : {}) } });
// One settee as the scene builder stamps it: base shell, two cushions, a
// bolster, four legs merged into ONE group key — plus an UNTAGGED mesh, which
// reads as 'base'.
const PIECE_MESHES = [
  M('base'), M('cushion'), M('cushion'), M('bolster'),
  M('structure', 'legs'), M('structure', 'legs'), M('structure', 'legs'), M('structure', 'legs'),
  { userData: {} },
];

test('the plain-selection highlight is DRESSABLE — every mesh except the estructura', () => {
  const got = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null })!;
  assert.equal(got.length, 5, 'base + 2 cushions + bolster + the untagged mesh');
  assert.equal(
    got.some((m: any) => (m.userData.partRole || 'base') === 'structure'), false,
    'a leg can NEVER enter the dressable highlight — that is the whole ask',
  );
  assert.ok(got.length < PIECE_MESHES.length, 'dressable ⊂ whole piece');
  for (const m of got) assert.ok(PIECE_MESHES.includes(m));
});

test('the other two focus modes: a role is all of it, a group is one', () => {
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'cushion', groupKey: null })!.length, 2);
  const legs = focusMeshes(PIECE_MESHES, { role: 'structure', groupKey: 'legs' })!;
  assert.equal(legs.length, 4);
  const dress = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null })!;
  assert.equal(legs.filter((m) => dress.includes(m)).length, 0, 'dressable ∩ estructura = ∅');
  assert.equal(legs.length + dress.length, PIECE_MESHES.length, 'together they are the whole piece');
  // A groupKey OUTRANKS the role it arrives with (a finish target sends both).
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'cushion', groupKey: 'legs' })!.length, 4);
});

test('NO-VANISH: a filter that matches nothing falls back to the whole piece', () => {
  assert.equal(focusMeshes([M('structure', 'legs')], { role: DRESSABLE_ROLE, groupKey: null }), null,
    'an ALL-estructura piece keeps its whole-piece outline, not an empty one');
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'armCushion', groupKey: null }), null, 'a role the piece lacks');
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'structure', groupKey: 'stale' }), null, 'a stale group key');
  assert.equal(focusMeshes(PIECE_MESHES, { role: null, groupKey: null }), null, 'no scope at all');
  assert.equal(focusMeshes([], { role: DRESSABLE_ROLE, groupKey: null }), null, 'no meshes');
  // Legacy models carry no `partRole` at all: they read as base, so the
  // dressable highlight degrades to the whole piece rather than to nothing.
  assert.equal(focusMeshes([{ userData: {} }, { userData: {} }], { role: DRESSABLE_ROLE, groupKey: null })!.length, 2);
});

test('the dressable highlight drops the roles carrying their own fabric pick', () => {
  const got = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['cushion'] })!;
  assert.equal(got.length, 3, 'base + bolster + the untagged mesh — the two cushions left with the legs');
  const roles = got.map((m: any) => m.userData.partRole || 'base');
  assert.equal(roles.includes('cushion'), false, 'an overridden part is not promised to the whole-piece pick');
  assert.equal(roles.includes('structure'), false, 'the estructura is still out — exclude NARROWS dressable, never widens it');
  assert.equal(focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['cushion', 'bolster'] })!.length, 2);
  assert.equal(focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['armCushion'] })!.length, 5);
});

test('no exclusions ⇒ byte-identical to the dressable set that shipped', () => {
  const plain = focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null });
  for (const scope of [
    { role: DRESSABLE_ROLE, groupKey: null },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: [] },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: null },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: undefined },
    { role: DRESSABLE_ROLE, groupKey: null, exclude: 'cushion' as unknown as string[] },   // not an array ⇒ ignored, never a substring match
  ]) assert.deepEqual(focusMeshes(PIECE_MESHES, scope), plain, `${JSON.stringify(scope.exclude)} must not narrow anything`);
  // …and it is honoured ONLY in dressable mode: a named role or group is the
  // subject the visitor picked, so an override list can never carve into it.
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'cushion', groupKey: null, exclude: ['cushion'] })!.length, 2);
  assert.equal(focusMeshes(PIECE_MESHES, { role: 'structure', groupKey: 'legs', exclude: ['structure'] })!.length, 4);
});

test('NO-VANISH survives exclusions: every dressable role overridden ⇒ the whole piece', () => {
  assert.equal(
    focusMeshes(PIECE_MESHES, { role: DRESSABLE_ROLE, groupKey: null, exclude: ['base', 'cushion', 'bolster'] }), null,
    'nothing left to promise ⇒ fall back, never an empty highlight',
  );
});

test('PRECEDENCE: a resting focus YIELDS to the hover, a committed one does not', () => {
  const hover = { uid: 'a', role: 'structure', partKey: 'legs' };
  // Resting = the dressable highlight a mere selection wears. Absolute
  // precedence here made the hover branch unreachable on the selected piece,
  // and the estructura — which the resting set excludes BY DESIGN — read as dead.
  const resting = resolveHighlightScope({ focusPart: { uid: 'a', role: DRESSABLE_ROLE }, hover, mode: '3d' });
  assert.equal(resting.source, 'hover');
  assert.deepEqual(resting.scope, { groupKey: 'legs', role: null }, 'the hovered estructura lights its MERGED group — what a click opens');
  // Committed = a picker is open on a part. Two lit parts on one piece read as
  // two selections, so the picker keeps the trace.
  const committed = resolveHighlightScope({ focusPart: { uid: 'a', role: 'cushion' }, hover, mode: '3d' });
  assert.equal(committed.source, 'focus');
  assert.equal(committed.scope?.role, 'cushion');
});

test('PRECEDENCE: the body keeps the dressable promise, and the plan never jumps', () => {
  const focusPart = { uid: 'a', role: DRESSABLE_ROLE, exclude: ['cushion'] };
  // Hovering the BODY is the whole-piece flow — the resting scope stands, with
  // its exclusions intact.
  const body = resolveHighlightScope({ focusPart, hover: { uid: 'a', role: 'base' }, mode: '3d' });
  assert.equal(body.source, 'focus');
  assert.deepEqual(body.scope?.exclude, ['cushion']);
  // 2D: the outline doubles as the drag affordance and must not move under the
  // pointer, so the resting focus wins there whatever is hovered.
  const plan = resolveHighlightScope({ focusPart, hover: { uid: 'a', role: 'structure', partKey: 'legs' }, mode: '2d' });
  assert.equal(plan.source, 'focus');
  // No focus at all ⇒ the hover still names what a click edits…
  assert.equal(resolveHighlightScope({ hover: { uid: 'a', role: 'cushion' }, mode: '3d' }).source, 'hover');
  // …and with neither, "the whole piece" (null) — the callers' no-vanish shape.
  assert.deepEqual(resolveHighlightScope({ mode: '3d' }), { scope: null, source: 'none' });
  // A stale/absent group key on a hovered estructura falls back to the ROLE,
  // where focusMeshes' own no-vanish takes over.
  assert.deepEqual(
    resolveHighlightScope({ hover: { uid: 'a', role: 'structure' }, mode: '3d' }).scope,
    { groupKey: null, role: 'structure' },
  );
});

test('the exclusions are the piece\'s OWN picks — base and structure never among them', () => {
  const roles = ['base', 'structure', 'cushion', 'bolster', 'armCushion'];
  assert.deepEqual(
    dressableExclusions({ cushion: { code: 'X' }, base: { code: 'Y' }, structure: { code: 'Z' } }, roles),
    ['cushion'],
    'the whole-piece pick IS the base, and the estructura is a finish',
  );
  // Any stored pick counts, even one in the very same cloth: the question is not
  // "does it look different?" but "will this gesture change it?".
  assert.deepEqual(dressableExclusions({ bolster: {} }, roles), ['bolster']);
  assert.deepEqual(dressableExclusions({ mystery: {} }, roles), [], 'a role the taxonomy does not know is inert');
  assert.deepEqual(dressableExclusions(null, roles), []);
});
