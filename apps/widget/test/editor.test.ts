/**
 * The plan reducer. Every gesture the visitor has goes through it, so this is
 * where the sandbox rules are pinned: snapping assists but never blocks, a
 * drag doesn't stack history, and nothing here can lose a piece.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxOf,
  editorCanRedo,
  editorCanUndo,
  editorReducer,
  initialEditorState,
  nextSelection,
  nudge,
  planBounds,
  type EditorAction,
  type EditorContext,
  type EditorState,
} from '../src/vm/editor.ts';
import { resolveWidgetCatalog } from '../src/vm/catalog.ts';
import { catalogPayload } from './fixtures.ts';

const catalog = resolveWidgetCatalog({ payload: catalogPayload });
const ctx: EditorContext = { modelById: catalog.modelById, params: catalog.collection.layoutParams };

const run = (actions: EditorAction[], from: EditorState = initialEditorState()): EditorState =>
  actions.reduce((state, action) => editorReducer(state, action, ctx), from);

test('adding a piece places it and selects it', () => {
  const state = run([{ type: 'add', pieceId: 'm-fireside' }]);
  assert.equal(state.placed.length, 1);
  assert.equal(state.placed[0].pieceId, 'm-fireside');
  assert.equal(state.selectedUid, state.placed[0].uid);
});

test('an unknown pieceId is a no-op, never a phantom placement', () => {
  const before = initialEditorState();
  assert.equal(run([{ type: 'add', pieceId: 'nope' }], before), before);
});

test('a second piece DOCKS onto the first (a run, not a scatter)', () => {
  const state = run([{ type: 'add', pieceId: 'm-fireside' }, { type: 'add', pieceId: 'm-ottoman' }]);
  const [a, b] = state.placed;
  const boxA = boxOf(a, ctx);
  const boxB = boxOf(b, ctx);
  // Same collection ⇒ they nest by the collection's link overlap (9 cm here).
  assert.equal(boxB.x, boxA.x + boxA.w - 9);
  assert.equal(boxB.y, boxA.y);
});

test('a drag does NOT stack history; the drop does', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }]);
  const uid = state.placed[0].uid;
  const depth = state.history.past.length;
  state = run([
    { type: 'drag', uid, x: 300, y: 40 },
    { type: 'drag', uid, x: 320, y: 44 },
    { type: 'drag', uid, x: 340, y: 48 },
  ], state);
  assert.equal(state.history.past.length, depth, 'a live drag must not fill the undo stack');
  state = run([{ type: 'drop', uid, x: 340, y: 48 }], state);
  assert.equal(state.history.past.length, depth + 1);
});

test('undo/redo restore the whole design, and report their availability', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }, { type: 'add', pieceId: 'm-ottoman' }]);
  assert.equal(editorCanUndo(state), true);
  assert.equal(editorCanRedo(state), false);
  state = run([{ type: 'undo' }], state);
  assert.equal(state.placed.length, 1);
  assert.equal(editorCanRedo(state), true);
  state = run([{ type: 'redo' }], state);
  assert.equal(state.placed.length, 2);
  // Undo past the beginning is a no-op, never a crash.
  const emptied = run([{ type: 'undo' }, { type: 'undo' }, { type: 'undo' }, { type: 'undo' }], state);
  assert.equal(emptied.placed.length, 0);
  assert.equal(editorCanUndo(emptied), false);
});

test('rotating re-settles the piece: a turned footprint never lands embedded', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }, { type: 'add', pieceId: 'm-ottoman' }]);
  const uid = state.placed[1].uid;
  state = run([{ type: 'rotate', uid, deg: 90 }], state);
  const a = boxOf(state.placed[0], ctx);
  const b = boxOf(state.placed[1], ctx);
  assert.equal(state.placed[1].rot, 90);
  // The rotated box swaps w/h and must not overlap deeper than the link nest.
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  assert.ok(overlapX <= 9.5 || overlapY <= 0.5, `pieces interpenetrate (${overlapX} × ${overlapY})`);
});

test('duplicate copies the piece AND its fabric pick, with a fresh uid', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }]);
  const uid = state.placed[0].uid;
  state = run([{ type: 'setMaterial', uid, material: { code: 'B0021', grade: 'C' } }], state);
  state = run([{ type: 'duplicate', uid }], state);
  assert.equal(state.placed.length, 2);
  const copy = state.placed[1];
  assert.notEqual(copy.uid, uid);
  assert.deepEqual(copy.material, { code: 'B0021', grade: 'C' });
  // Duplicating something that isn't there changes nothing.
  const same = run([{ type: 'duplicate', uid: 'ghost' }], state);
  assert.equal(same.placed.length, 2);
});

test('"one fabric for all" applies to every piece (uid = null)', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }, { type: 'add', pieceId: 'm-ottoman' }]);
  state = run([{ type: 'setMaterial', uid: null, material: { code: 'B0021' } }], state);
  assert.deepEqual(state.placed.map((p) => (p.material as { code: string }).code), ['B0021', 'B0021']);
});

test('a part pick is stored per role, and clearing the last one drops the bag', () => {
  let state = run([{ type: 'add', pieceId: 'm-ottoman' }]);
  const uid = state.placed[0].uid;
  state = run([{ type: 'setPartMaterial', uid, role: 'exterior', material: { code: 'B0032' } }], state);
  assert.deepEqual(state.placed[0].partMaterials, { exterior: { code: 'B0032' } });
  state = run([{ type: 'setPartMaterial', uid, role: 'exterior', material: null }], state);
  assert.equal(state.placed[0].partMaterials, null);
});

test('remove drops the piece and releases the selection', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }]);
  const uid = state.placed[0].uid;
  state = run([{ type: 'remove', uid }], state);
  assert.deepEqual(state.placed, []);
  assert.equal(state.selectedUid, null);
  // Removing a ghost is a no-op.
  assert.equal(run([{ type: 'remove', uid: 'ghost' }], state), state);
});

test('clear empties the plan and the room, and is undoable', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }]);
  state = run([{ type: 'clear' }], state);
  assert.deepEqual(state.placed, []);
  state = run([{ type: 'undo' }], state);
  assert.equal(state.placed.length, 1);
  // Clearing an empty plan does nothing at all (no empty history entry).
  const empty = initialEditorState();
  assert.equal(run([{ type: 'clear' }], empty), empty);
});

test('restore stamps FRESH uids so a share link cannot collide with the plan', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside' }]);
  const existing = state.placed[0].uid;
  state = run([{
    type: 'restore',
    placed: [
      { uid: existing, pieceId: 'm-ottoman', x: 0, y: 0, rot: 0 },
      { uid: existing, pieceId: 'm-cushion', x: 10, y: 10, rot: 0 },
    ],
  }], state);
  const uids = state.placed.map((p) => p.uid);
  assert.equal(new Set(uids).size, uids.length, 'restored uids must be unique');
});

test('nudge moves by the step and commits (the keyboard is a first-class input)', () => {
  let state = run([{ type: 'add', pieceId: 'm-fireside', x: 0, y: 0 }]);
  const uid = state.placed[0].uid;
  const before = state.placed[0].x;
  state = nudge(state, uid, 10, 0, ctx);
  assert.equal(state.placed[0].x, before + 10);
  assert.equal(state.history.past.length, 2);
  // A ghost uid is a no-op.
  assert.equal(nudge(state, 'ghost', 10, 0, ctx), state);
});

test('planBounds reports the overall footprint, or null for an empty plan', () => {
  assert.equal(planBounds([], ctx), null);
  const state = run([{ type: 'add', pieceId: 'm-fireside' }, { type: 'add', pieceId: 'm-ottoman' }]);
  const bounds = planBounds(state.placed, ctx)!;
  assert.equal(bounds.widthCm, 78 + 100 - 9);
  assert.equal(bounds.depthCm, 102);
});

test('selection cycles in reading order and wraps', () => {
  const state = run([{ type: 'add', pieceId: 'm-fireside' }, { type: 'add', pieceId: 'm-ottoman' }]);
  const first = nextSelection({ ...state, selectedUid: null }, 1);
  assert.ok(first);
  const second = nextSelection({ ...state, selectedUid: first }, 1);
  assert.notEqual(second, first);
  assert.equal(nextSelection({ ...state, selectedUid: second }, 1), first, 'cycling wraps');
  assert.equal(nextSelection(initialEditorState(), 1), null);
});

test('compact pulls a run flush again after a middle piece is deleted', () => {
  let state = run([
    { type: 'add', pieceId: 'm-fireside' },
    { type: 'add', pieceId: 'm-ottoman' },
    { type: 'add', pieceId: 'm-fireside' },
  ]);
  const middle = state.placed[1].uid;
  state = run([{ type: 'remove', uid: middle }, { type: 'compact' }], state);
  const [a, b] = state.placed.map((p) => boxOf(p, ctx));
  assert.ok(b.x <= a.x + a.w + 0.5, 'the gap the deleted piece left must be closed');
});
