/**
 * THE CHROME'S LIFECYCLE — a sheet is a question, a rail is the workspace.
 *
 * Ported from the reference configurator (RosetSoft c313ecd + cbbe976): the
 * dismissal decided by the chrome and never by the material kind, one exit per
 * Escape, a cloth retarget answering the finish question, and the hover card as
 * strictly an affordance of the selection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitFinishPick, commitMaterialPick, dismissesOnPick, emptyChrome,
  openFinish, openMaterial, resolveEscape, resolveHoverCard, selectPiece,
  type ChromeState,
} from '../src/vm/chrome.ts';

const base = (over: Partial<ChromeState> = {}): ChromeState => ({ ...emptyChrome(), ...over });

test('DISMISSAL IS THE CHROME\'S, not the material kind\'s or the target level\'s', () => {
  assert.equal(dismissesOnPick('sheet'), true, 'a sheet is a modal question — answering it dismisses');
  assert.equal(dismissesOnPick('rail'), false, 'the rail IS the workspace');
  assert.equal(dismissesOnPick(null), false);

  const target = { scope: 'part', uid: 'a', role: 'cushion' } as const;
  // The SAME target, the same pick, two chromes, two answers — and the answer
  // never depends on cloth-vs-acabado or on piece-vs-part.
  assert.equal(commitMaterialPick(openMaterial(base(), target, 'sheet')).material, null);
  assert.deepEqual(commitMaterialPick(openMaterial(base(), target, 'rail')).material, { kind: 'rail', target });
  // Picking an acabado used to close the rail out from under the visitor on
  // every single choice; it obeys the same law now.
  const finish = openFinish(base(), { uid: 'a', partKey: 'legs' }, 'rail');
  assert.deepEqual(commitFinishPick(finish).finish, finish.finish);
  assert.equal(commitFinishPick(openFinish(base(), { uid: 'a', partKey: 'legs' }, 'sheet')).finish, null);
});

test('the rail keeps its PART target — dressing a cushion is not a request to stop', () => {
  // Falling back to the piece re-keys the picker: the wall remounts onto the
  // piece's own ladder and auto-drills away from the swatch just chosen — the
  // chip vanishes under the visitor's cursor.
  const railed = openMaterial(base(), { scope: 'part', uid: 'a', role: 'cushion' }, 'rail');
  const after = commitMaterialPick(railed);
  assert.deepEqual(after.material?.target, { scope: 'part', uid: 'a', role: 'cushion' });
  assert.equal(after.selectedUid, 'a', 'and the piece stays selected under it');
});

test('a CLOTH retarget answers the finish question, and vice-versa', () => {
  const onFinish = openFinish(base(), { uid: 'a', partKey: 'legs' }, 'rail');
  const retargeted = openMaterial(onFinish, { scope: 'piece', uid: 'a' }, 'rail');
  // Without this the rail stayed on the finish plates and «cambiar tela» on the
  // same piece was a dead end: the target never changed, so neither did the wall.
  assert.equal(retargeted.finish, null);
  assert.deepEqual(retargeted.material?.target, { scope: 'piece', uid: 'a' });
  // The other direction — metal wears an acabado, never cloth.
  assert.equal(openFinish(retargeted, { uid: 'a', partKey: 'legs' }, 'rail').material, null);
});

test('«apply to all» holds no selection; every other target names its piece', () => {
  assert.equal(openMaterial(base({ selectedUid: 'a' }), { scope: 'all' }, 'rail').selectedUid, null);
  assert.equal(openMaterial(base(), { scope: 'piece', uid: 'b' }, 'sheet').selectedUid, 'b');
});

test('ONE EXIT PER ESCAPE, topmost chrome first', () => {
  const stacked = openMaterial(base({ overlay: 'ar', selectedUid: 'a' }), { scope: 'piece', uid: 'a' }, 'rail');
  const first = resolveEscape(stacked);
  assert.equal(first.closed, 'overlay');
  assert.ok(first.state.material, 'the picker under it is untouched');
  const second = resolveEscape(first.state);
  assert.equal(second.closed, 'material');
  assert.equal(second.state.selectedUid, 'a', 'Escape on a picker leaves the piece behind it SELECTED');
  const third = resolveEscape(second.state);
  assert.equal(third.closed, 'selection');
  assert.equal(third.state.selectedUid, null);
  assert.equal(resolveEscape(third.state).closed, null, 'nothing left to close is not an error');
});

test('Escape closes the finish sheet above the fabric rail', () => {
  const both: ChromeState = base({
    material: { kind: 'rail', target: { scope: 'piece', uid: 'a' } },
    finish: { kind: 'sheet', target: { uid: 'a', partKey: 'legs' } },
    selectedUid: 'a',
  });
  const out = resolveEscape(both);
  assert.equal(out.closed, 'finish');
  assert.ok(out.state.material, 'and only that one');
});

test('deselecting answers every question asked ABOUT that piece', () => {
  const open = openMaterial(base(), { scope: 'part', uid: 'a', role: 'cushion' }, 'rail');
  const moved = selectPiece(open, 'b');
  assert.equal(moved.material, null);
  assert.equal(moved.finish, null);
  assert.equal(moved.selectedUid, 'b');
  // Re-selecting the SAME piece is not a change and must not close its picker.
  assert.equal(selectPiece(open, 'a'), open);
});

test('THE HOVER CARD IS A SELECTION AFFORDANCE — nothing else gets one', () => {
  // Hovered AND selected → it follows the pointer: following is the register of
  // editing, and there the card and the ray describe the same act.
  assert.deepEqual(resolveHoverCard({ hoveredUid: 'a', selectedUid: 'a', mode: '3d' }), { mode: 'follow', uid: 'a' });
  // Selected, not hovered → it parks above the piece.
  assert.deepEqual(resolveHoverCard({ hoveredUid: null, selectedUid: 'a', mode: '3d' }), { mode: 'anchored', uid: 'a' });
  // Hovered, NOT selected → nothing for that piece: a card offering «cambiar
  // tela» over a console the visitor merely swept past states an intent they
  // never expressed. (With a selection elsewhere, the card stays on it.)
  assert.deepEqual(resolveHoverCard({ hoveredUid: 'b', selectedUid: null, mode: '3d' }), { mode: 'hidden', uid: null });
  assert.deepEqual(resolveHoverCard({ hoveredUid: 'b', selectedUid: 'a', mode: '3d' }), { mode: 'anchored', uid: 'a' });
  // The plan's card is anchored to the tile; only the 3D vista follows. A finger
  // never hovers, so a coarse pointer only ever gets the anchor.
  assert.equal(resolveHoverCard({ hoveredUid: 'a', selectedUid: 'a', mode: '2d' }).mode, 'anchored');
  assert.equal(resolveHoverCard({ hoveredUid: 'a', selectedUid: 'a', finePointer: false }).mode, 'anchored');
});
