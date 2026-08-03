// ONE GESTURE, and the keys that arm it.
//
// The dealer points at two things and says "these are one part", or at one
// member and says "this one is its own". What that IS in the data depends on
// where the keys came from — two materials are a MERGE, two islands of one
// material are an UN-SPLIT — and he must never have to know which. So one mode
// does both directions, and `@veta/materials` settles the merge map, the role,
// the label and the palette together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { partRoleFor } from '@veta/materials';

import {
  applyPickGesture, resolvePickGesture, resolveStudioKey, separateMembers,
} from '../src/vm/gesture.ts';
import type { PartsDraft } from '../src/vm/types.ts';

const draft: PartsDraft = {
  mats: { COL0: 'base', 'COL0~2': 'cushion', COL1: 'structure' },
};

test('unarmed, a click SELECTS — that is the whole of the default mode', () => {
  assert.deepEqual(
    resolvePickGesture({ raw: 'COL1', group: 'COL1' }, { joinMode: false, selected: null }),
    { kind: 'select', group: 'COL1' },
  );
  // Empty space deselects when unarmed…
  assert.deepEqual(resolvePickGesture(null, { joinMode: false, selected: 'COL0' }), { kind: 'select', group: null });
  // …and with the mode armed but nothing selected there is nothing to join INTO,
  // so it is still a selection, never a swallowed click.
  assert.deepEqual(
    resolvePickGesture({ raw: 'COL1', group: 'COL1' }, { joinMode: true, selected: null }),
    { kind: 'select', group: 'COL1' },
  );
});

test('armed: OUTSIDE joins, INSIDE separates, empty space stays armed', () => {
  const armed = { joinMode: true, selected: 'COL0' };
  // Outside the part → bring it in.
  assert.deepEqual(
    resolvePickGesture({ raw: 'COL1', group: 'COL1' }, armed),
    { kind: 'join', target: 'COL0', members: ['COL1'] },
  );
  // Inside → take it out. `raw` is the mesh's OWN key, which is what makes
  // taking a natively-grouped island out possible: it need carry no merge entry.
  assert.deepEqual(
    resolvePickGesture({ raw: 'COL0~2', group: 'COL0' }, armed),
    { kind: 'separate', group: 'COL0', members: ['COL0~2'] },
  );
  // The group key itself is not separable from itself.
  assert.deepEqual(resolvePickGesture({ raw: 'COL0', group: 'COL0' }, armed), { kind: 'noop' });
  // A stray miss must not cost the mode — the dealer is usually mid-run.
  assert.deepEqual(resolvePickGesture(null, armed), { kind: 'noop' });
});

test('folding a GROUP in carries everything already folded into it', () => {
  // Otherwise its children stay pointed at a key that is no longer a group of
  // its own.
  const g = resolvePickGesture({ raw: 'COL1', group: 'COL1' }, {
    joinMode: true, selected: 'COL0', groups: { COL1: ['COL1', 'COL1~2', 'COL1~3'] },
  });
  assert.deepEqual(g, { kind: 'join', target: 'COL0', members: ['COL1', 'COL1~2', 'COL1~3'] });
});

test('a join makes the member RESOLVE as the target — role included', () => {
  // The failure this replaces: `merges` moved a key's label and its finish but
  // never its ROLE, so the join folded the island into the group in the studio
  // while the renderer still resolved it as a cushion — it kept rendering as a
  // cushion and kept billing one.
  const joined = applyPickGesture(draft, { kind: 'join', target: 'COL0', members: ['COL0~2'] });
  assert.equal(partRoleFor(joined, null, -1, 'COL0~2'), 'base', 'it renders and bills as the target');

  // And the same gesture in reverse: separating must never silently re-file a
  // part as `base`, which is a different fabric and, for a billed role, a
  // different price.
  const back = separateMembers(joined, ['COL0~2']);
  assert.equal(partRoleFor(back, null, -1, 'COL0~2'), 'base', 'it keeps the role it was WEARING');

  // Un-splitting a natively-grouped island is the same control: the island had
  // no merge entry at all, only its own tag.
  const unsplit = applyPickGesture(draft, { kind: 'separate', group: 'COL0', members: ['COL0~2'] });
  assert.equal(partRoleFor(unsplit, null, -1, 'COL0~2'), 'cushion');
});

test('select and noop never touch the draft', () => {
  assert.equal(applyPickGesture(draft, { kind: 'select', group: 'COL1' }), draft);
  assert.equal(applyPickGesture(draft, { kind: 'noop' }), draft);
  assert.equal(separateMembers(draft, []), draft);
});

/* ── Keyboard ───────────────────────────────────────────────────────────────*/

const ctx = { joinMode: false, selected: 'COL0', modelIds: ['a', 'b', 'c'], activeId: 'b' };

test('U toggles the mode — and NEEDS a selection, because that is what you join into', () => {
  assert.deepEqual(resolveStudioKey({ key: 'u' }, ctx), { action: { kind: 'toggle-join' }, preventDefault: true });
  assert.deepEqual(resolveStudioKey({ key: 'U' }, ctx), { action: { kind: 'toggle-join' }, preventDefault: true });
  // Arming it with nothing selected would swallow the next click, the same
  // reason the mode clears itself when the selection goes.
  assert.equal(resolveStudioKey({ key: 'u' }, { ...ctx, selected: null }).action.kind, 'none');
});

test('Esc leaves the mode; already out, it deselects', () => {
  assert.equal(resolveStudioKey({ key: 'Escape' }, { ...ctx, joinMode: true }).action.kind, 'exit-join');
  assert.equal(resolveStudioKey({ key: 'Escape' }, ctx).action.kind, 'deselect');
});

test('←/→ walk the rail, and stop at the ends', () => {
  assert.deepEqual(resolveStudioKey({ key: 'ArrowRight' }, ctx).action, { kind: 'model', id: 'c' });
  assert.deepEqual(resolveStudioKey({ key: 'ArrowLeft' }, ctx).action, { kind: 'model', id: 'a' });
  assert.equal(resolveStudioKey({ key: 'ArrowLeft' }, { ...ctx, activeId: 'a' }).action.kind, 'none');
  assert.equal(resolveStudioKey({ key: 'ArrowRight' }, { ...ctx, activeId: 'c' }).action.kind, 'none');
  assert.equal(resolveStudioKey({ key: 'ArrowRight' }, { ...ctx, activeId: 'gone' }).action.kind, 'none');
});

test('never while typing, and modifier combos are the browser\'s', () => {
  // A bare letter is a shortcut only OUTSIDE a field, or renaming a part would
  // toggle modes mid-word.
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(resolveStudioKey({ key: 'u', target: { tagName } }, ctx).action.kind, 'none', tagName);
    assert.equal(resolveStudioKey({ key: 'Escape', target: { tagName } }, ctx).action.kind, 'none');
  }
  assert.equal(resolveStudioKey({ key: 'u', target: { isContentEditable: true } }, ctx).action.kind, 'none');
  // Cmd+← stays "back".
  assert.equal(resolveStudioKey({ key: 'ArrowLeft', metaKey: true }, ctx).action.kind, 'none');
  assert.equal(resolveStudioKey({ key: 'u', ctrlKey: true }, ctx).action.kind, 'none');
  assert.equal(resolveStudioKey({ key: 'u', altKey: true }, ctx).action.kind, 'none');
  assert.equal(resolveStudioKey({ key: 'u', defaultPrevented: true }, ctx).action.kind, 'none');
  assert.equal(resolveStudioKey(null, ctx).action.kind, 'none');
  assert.equal(resolveStudioKey({ key: 'k' }, ctx).action.kind, 'none');
});
