/**
 * THE PLAN EDITOR — a pure reducer over the placed pieces.
 *
 * Every gesture the 2D plan supports (place, drag, rotate, duplicate, delete,
 * undo, pick a fabric, draw a room) is an ACTION here; the React layer owns
 * pointers and pixels and nothing else. That split is what makes the placement
 * behaviour testable at all: the snapping, the collision push-out and the
 * undo depth are asserted in `node --test`, not eyeballed in a browser.
 *
 * Two rules carried over from the reference configurator:
 *
 *   • THE PLAN IS A SANDBOX. Snapping is an assist, never a barrier — nothing
 *     here clamps a piece to a boundary, and a room is a drawn guide the pieces
 *     may exceed (the fit readout says by how much).
 *   • HISTORY IS PER COMMIT GESTURE, not per pointer-move. A drag pushes ONE
 *     entry when it ends; otherwise a single drag would fill the undo stack and
 *     "undo" would nudge the piece a millimetre at a time.
 */

import {
  canRedo,
  canUndo,
  compactPlaced,
  cyclePieceUid,
  duplicatePlacement,
  footprintOf,
  historyPush,
  historyRedo,
  historyUndo,
  makeHistory,
  norm360,
  resolvePlacement,
  snapPlacementInfo,
  type History,
  type LayoutParams,
  type Placed,
  type PieceBox,
  type PieceModelMap,
  type Room,
} from '@veta/layout';

/** A piece on the plan. `uid` is stable for the piece's whole life. */
export interface PlacedPiece extends Placed {
  uid: string;
  pieceId: string;
  x: number;
  y: number;
  rot: number;
}

/** What undo/redo restore — the whole visible design, never a partial diff. */
export interface EditorSnapshot {
  placed: PlacedPiece[];
  room: Room | null;
}

export interface EditorState extends EditorSnapshot {
  selectedUid: string | null;
  history: History<EditorSnapshot>;
  /** Bumped whenever the last gesture engaged a snap — the View's haptic cue. */
  snapPulse: number;
  /** Monotonic id source, so a uid is never reused inside one session. */
  seq: number;
}

export interface EditorContext {
  modelById: PieceModelMap;
  params: LayoutParams;
}

export type EditorAction =
  | { type: 'add'; pieceId: string; x?: number; y?: number; rot?: number }
  /** Live pointer-move: gentle magnet, NO history entry. */
  | { type: 'drag'; uid: string; x: number; y: number }
  /** Pointer-up: the generous dock magnet, and the history push. */
  | { type: 'drop'; uid: string; x: number; y: number }
  | { type: 'rotate'; uid: string; deg: number; commit?: boolean }
  | { type: 'remove'; uid: string }
  | { type: 'duplicate'; uid: string }
  | { type: 'select'; uid: string | null }
  | { type: 'setMaterial'; uid: string | null; material: Record<string, unknown> | null }
  | { type: 'setPartMaterial'; uid: string; role: string; material: Record<string, unknown> | null }
  | { type: 'setRoom'; room: Room | null }
  | { type: 'compact' }
  | { type: 'clear' }
  | { type: 'restore'; placed: PlacedPiece[]; room?: Room | null }
  | { type: 'undo' }
  | { type: 'redo' };

export function initialEditorState(): EditorState {
  return { placed: [], room: null, selectedUid: null, history: makeHistory<EditorSnapshot>(), snapPulse: 0, seq: 0 };
}

const snapshotOf = (state: EditorState): EditorSnapshot => ({ placed: state.placed, room: state.room });

/** Every state change that a visitor would expect ⌘Z to reverse goes through
 *  here; a pointer-move deliberately does not. */
function commit(state: EditorState, next: Partial<EditorState>): EditorState {
  return { ...state, ...next, history: historyPush(state.history, snapshotOf(state)) };
}

/** A piece's plan box at its current rotation — the input every layout call takes. */
export function boxOf(piece: PlacedPiece, ctx: EditorContext, at?: { x: number; y: number }): PieceBox {
  const model = resolvePlacement(piece, ctx.modelById);
  const fp = footprintOf(model, piece.rot);
  return {
    x: at?.x ?? piece.x,
    y: at?.y ?? piece.y,
    w: fp.w,
    h: fp.h,
    col: (model.collection as string | null) ?? null,
  };
}

/** The other pieces' boxes — what a moving piece snaps and collides against. */
function neighbours(state: EditorState, uid: string, ctx: EditorContext): PieceBox[] {
  return state.placed.filter((p) => p.uid !== uid).map((p) => boxOf(p, ctx));
}

/** The next free spot for a NEW piece: to the right of the current run, so a
 *  tapped tile never lands underneath what is already there. */
function spawnAt(state: EditorState, ctx: EditorContext): { x: number; y: number } {
  if (!state.placed.length) return { x: 0, y: 0 };
  let maxRight = -Infinity;
  let topY = 0;
  for (const p of state.placed) {
    const box = boxOf(p, ctx);
    if (box.x + box.w > maxRight) { maxRight = box.x + box.w; topY = box.y; }
  }
  return { x: Number.isFinite(maxRight) ? maxRight + 20 : 0, y: topY };
}

export function editorReducer(state: EditorState, action: EditorAction, ctx: EditorContext): EditorState {
  switch (action.type) {
    case 'add': {
      const model = ctx.modelById[action.pieceId];
      if (!model) return state;
      const seq = state.seq + 1;
      const uid = `p${seq}`;
      const spawn = spawnAt(state, ctx);
      const piece: PlacedPiece = {
        uid,
        pieceId: action.pieceId,
        x: action.x ?? spawn.x,
        y: action.y ?? spawn.y,
        rot: norm360(action.rot ?? (model as { defaultRot?: number }).defaultRot ?? 0),
      };
      // A new piece DOCKS on arrival (the generous magnet), so tapping two
      // tiles in a row builds a connected run instead of a scatter.
      const snap = snapPlacementInfo(boxOf(piece, ctx), neighbours(state, uid, ctx), { mode: 'dock', params: ctx.params });
      const placed = [...state.placed, { ...piece, x: snap.x, y: snap.y }];
      return commit(state, { placed, selectedUid: uid, seq, snapPulse: state.snapPulse + (snap.snapped ? 1 : 0) });
    }

    case 'drag':
    case 'drop': {
      const piece = state.placed.find((p) => p.uid === action.uid);
      if (!piece) return state;
      const snap = snapPlacementInfo(
        boxOf(piece, ctx, { x: action.x, y: action.y }),
        neighbours(state, action.uid, ctx),
        { mode: action.type === 'drop' ? 'dock' : 'drag', params: ctx.params },
      );
      const placed = state.placed.map((p) => (p.uid === action.uid ? { ...p, x: snap.x, y: snap.y } : p));
      const pulse = state.snapPulse + (snap.snapped ? 1 : 0);
      // Live moves must not stack history — only the drop does.
      return action.type === 'drop'
        ? commit(state, { placed, snapPulse: pulse })
        : { ...state, placed, snapPulse: pulse };
    }

    case 'rotate': {
      const piece = state.placed.find((p) => p.uid === action.uid);
      if (!piece) return state;
      const rot = norm360(action.deg);
      const rotated = { ...piece, rot };
      // Rotating changes the footprint, so re-settle against the neighbours:
      // a turned piece must never end up embedded in the one it was flush with.
      const snap = snapPlacementInfo(boxOf(rotated, ctx), neighbours(state, action.uid, ctx), {
        mode: 'dock', params: ctx.params,
      });
      const placed = state.placed.map((p) => (p.uid === action.uid ? { ...rotated, x: snap.x, y: snap.y } : p));
      return action.commit === false ? { ...state, placed } : commit(state, { placed });
    }

    case 'remove': {
      if (!state.placed.some((p) => p.uid === action.uid)) return state;
      const placed = state.placed.filter((p) => p.uid !== action.uid);
      const selectedUid = state.selectedUid === action.uid ? null : state.selectedUid;
      return commit(state, { placed, selectedUid });
    }

    case 'duplicate': {
      const seq = state.seq + 1;
      const uid = `p${seq}`;
      const dup = duplicatePlacement(state.placed, action.uid, ctx.modelById, uid, ctx.params);
      if (!dup) return state;
      return commit(state, { placed: dup.placed as PlacedPiece[], selectedUid: uid, seq });
    }

    case 'select':
      return { ...state, selectedUid: action.uid };

    case 'setMaterial': {
      // A null uid means "one fabric for the whole design" — the single most
      // used control in the reference configurator.
      const placed = state.placed.map((p) => (
        action.uid == null || p.uid === action.uid ? { ...p, material: action.material } : p
      ));
      return commit(state, { placed });
    }

    case 'setPartMaterial': {
      const placed = state.placed.map((p) => {
        if (p.uid !== action.uid) return p;
        const partMaterials = { ...(p.partMaterials ?? {}) };
        if (action.material == null) delete partMaterials[action.role];
        else partMaterials[action.role] = action.material;
        return { ...p, partMaterials: Object.keys(partMaterials).length ? partMaterials : null };
      });
      return commit(state, { placed });
    }

    case 'setRoom':
      return commit(state, { room: action.room });

    case 'compact':
      return commit(state, { placed: compactPlaced(state.placed, ctx.modelById) as PlacedPiece[] });

    case 'clear':
      return state.placed.length || state.room
        ? commit(state, { placed: [], room: null, selectedUid: null })
        : state;

    case 'restore': {
      // A restored build (share link / device snapshot) carries no uids: stamp
      // fresh ones so nothing can collide with a piece already on the plan.
      let seq = state.seq;
      const placed = action.placed.map((p) => { seq += 1; return { ...p, uid: `p${seq}` }; });
      return commit(state, { placed, room: action.room ?? state.room, selectedUid: null, seq });
    }

    case 'undo': {
      const step = historyUndo(state.history, snapshotOf(state));
      if (!step) return state;
      return { ...state, ...step.present, history: step.hist, selectedUid: null };
    }

    case 'redo': {
      const step = historyRedo(state.history, snapshotOf(state));
      if (!step) return state;
      return { ...state, ...step.present, history: step.hist, selectedUid: null };
    }

    default:
      return state;
  }
}

/** Keyboard/step nudge — the accessible sibling of a drag. */
export function nudge(state: EditorState, uid: string, dx: number, dy: number, ctx: EditorContext): EditorState {
  const piece = state.placed.find((p) => p.uid === uid);
  if (!piece) return state;
  return editorReducer(state, { type: 'drop', uid, x: piece.x + dx, y: piece.y + dy }, ctx);
}

/** The plan's overall footprint in cm — the "Conjunto W × D" readout, and the
 *  bounds the 2D view and the 3D framing both fit to. */
export function planBounds(placed: PlacedPiece[], ctx: EditorContext): {
  minX: number; minY: number; maxX: number; maxY: number; widthCm: number; depthCm: number;
} | null {
  if (!placed.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of placed) {
    const box = boxOf(p, ctx);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { minX, minY, maxX, maxY, widthCm: Math.round(maxX - minX), depthCm: Math.round(maxY - minY) };
}

export const editorCanUndo = (state: EditorState): boolean => canUndo(state.history);
export const editorCanRedo = (state: EditorState): boolean => canRedo(state.history);

/** Selection cycling for the keyboard (Tab through the placed pieces). */
export function nextSelection(state: EditorState, direction: 1 | -1 = 1): string | null {
  return cyclePieceUid(state.placed, state.selectedUid, direction) as string | null;
}
