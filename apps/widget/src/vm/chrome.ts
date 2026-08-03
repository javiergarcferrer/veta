/**
 * THE CHROME'S LIFECYCLE — who dismisses whom, and what one Escape closes.
 *
 * A configurator's pickers are asked in two shapes, and getting the difference
 * wrong is what makes an editor feel like it is fighting the visitor:
 *
 *   • A SHEET is a modal QUESTION. Answering it dismisses it.
 *   • A RAIL is the desktop WORKSPACE. The target it holds SURVIVES its own
 *     pick — chip, plates, highlight and scroll all stay put. Dressing a cushion
 *     is not a request to stop looking at cushions.
 *
 * That is decided by the CHROME, never by the material kind and never by the
 * target level. The reference shipped the other rule for a while and picking an
 * acabado closed the rail out from under the visitor on every single choice.
 *
 * A TARGET IS A QUESTION THAT STAYS ASKED until something else answers it: the
 * chip's ✕, a retarget (cloth answers the finish question and vice-versa), or
 * deselecting the piece.
 *
 * Pure and total: a reducer over a plain state record, so the lifecycle is
 * pinned in `node --test` instead of being clicked through in a browser.
 */

/** The two shapes a picker is asked in. */
export type ChromeKind = 'sheet' | 'rail';

/** What a fabric pick will land on. */
export type MaterialTarget =
  | { scope: 'piece'; uid: string }
  | { scope: 'part'; uid: string; role: string }
  /** «Aplicar a todas» — every placed piece at once. */
  | { scope: 'all' };

/** What a finish pick will land on: one merged part group of one piece. */
export interface FinishTarget {
  uid: string;
  partKey: string;
}

export interface ChromeState {
  /** The fabric picker, or null when closed. */
  material: { kind: ChromeKind; target: MaterialTarget } | null;
  /** The acabado picker, or null when closed. */
  finish: { kind: ChromeKind; target: FinishTarget } | null;
  /** Anything stacked ON TOP (AR, the summary sheet, a download dialog). */
  overlay: string | null;
  selectedUid: string | null;
}

export const emptyChrome = (): ChromeState => ({ material: null, finish: null, overlay: null, selectedUid: null });

/**
 * Does answering this chrome dismiss it? The whole rule, in one predicate, so
 * every commit path reads the SAME answer — a second copy of it is how two
 * surfaces start behaving differently while applying the same pick.
 */
export function dismissesOnPick(kind: ChromeKind | null | undefined): boolean {
  return kind === 'sheet';
}

/**
 * Open the FABRIC picker on a target.
 *
 * A cloth retarget ANSWERS the finish question — the vice-versa of the finish
 * branch below. Without it the rail stayed on the finish plates and «cambiar
 * tela» on the same piece was a dead end: the target never changed, so neither
 * did the wall.
 */
export function openMaterial(state: ChromeState, target: MaterialTarget, kind: ChromeKind): ChromeState {
  return {
    ...state,
    material: { kind, target },
    finish: null,
    // «Aplicar a todas» dresses every piece, so it holds no single selection;
    // any other target IS a selection and says which piece.
    selectedUid: target.scope === 'all' ? null : target.uid,
  };
}

/** Open the ACABADO picker on a part group — the estructura sibling, and the
 *  same law: it answers the cloth question. */
export function openFinish(state: ChromeState, target: FinishTarget, kind: ChromeKind): ChromeState {
  return { ...state, finish: { kind, target }, material: null, selectedUid: target.uid };
}

/**
 * A pick landed. The state that comes back is what the visitor is left looking
 * at — the CHROME decides, and only the chrome: a sheet dismisses, a rail keeps
 * its target (and therefore its chip, its plates and its scroll position).
 *
 * Falling back to the piece after a PART pick is deliberately NOT done: it
 * re-keys the picker, the wall remounts onto the piece's own ladder and
 * auto-drills away from the swatch just chosen — the chip vanishes under the
 * visitor's cursor.
 */
export function commitMaterialPick(state: ChromeState): ChromeState {
  if (!state.material) return state;
  return dismissesOnPick(state.material.kind) ? { ...state, material: null } : state;
}

/** The same law for the acabado — one rule, both pickers. */
export function commitFinishPick(state: ChromeState): ChromeState {
  if (!state.finish) return state;
  return dismissesOnPick(state.finish.kind) ? { ...state, finish: null } : state;
}

/** What an Escape press closed, if anything. */
export type ChromeLayer = 'overlay' | 'finish' | 'material' | 'selection';

export interface EscapeResult {
  state: ChromeState;
  /** The ONE layer this press closed — null when there was nothing to close. */
  closed: ChromeLayer | null;
}

/**
 * ONE EXIT PER ESCAPE, TOPMOST CHROME FIRST.
 *
 * Escape with a picker open closes the PICKER and leaves the piece behind it
 * selected; a second press drops the selection. Collapsing both into one press
 * loses work the visitor could not see they were about to lose, and the ✕ and
 * the backdrop already behave this way — the keyboard has to agree with them.
 */
export function resolveEscape(state: ChromeState): EscapeResult {
  if (state.overlay) return { state: { ...state, overlay: null }, closed: 'overlay' };
  if (state.finish) return { state: { ...state, finish: null }, closed: 'finish' };
  if (state.material) return { state: { ...state, material: null }, closed: 'material' };
  if (state.selectedUid != null) return { state: { ...state, selectedUid: null }, closed: 'selection' };
  return { state, closed: null };
}

/** Deselecting answers every question asked ABOUT that piece — the targets were
 *  only ever questions about it. */
export function selectPiece(state: ChromeState, uid: string | null): ChromeState {
  if (uid === state.selectedUid) return state;
  return { ...state, selectedUid: uid, material: null, finish: null };
}

/** How the floating card is positioned — or whether it exists at all. */
export type HoverCardMode = 'follow' | 'anchored' | 'hidden';

/** The card's mode and WHICH piece it describes (never the hovered one unless
 *  that piece is also the selected one). */
export interface HoverCardView {
  mode: HoverCardMode;
  uid: string | null;
}

/**
 * THE HOVER CARD IS A SELECTION AFFORDANCE, and only that.
 *
 *   • hovered AND selected → it FOLLOWS the pointer: following is the register
 *     of EDITING, and there the card and the ray describe the same act;
 *   • selected, not hovered → it PARKS above the piece (the bare-selection
 *     anchor);
 *   • hovered, not selected → NOTHING. A card offering «cambiar tela» over a
 *     console the visitor merely swept past states an intent they never
 *     expressed.
 *
 * Owner, in two passes: «el popup no está siguiendo el mouse», then «popup
 * following mouse should only happen when a product is selected».
 */
export function resolveHoverCard(input: {
  hoveredUid?: string | null;
  selectedUid?: string | null;
  /** The plan's card is anchored to the tile; only the 3D vista follows. */
  mode?: '2d' | '3d' | string | null;
  /** A finger never hovers, so a coarse pointer only ever gets the anchor. */
  finePointer?: boolean;
}): HoverCardView {
  const selected = input.selectedUid ?? null;
  const hovered = input.hoveredUid ?? null;
  // No selection ⇒ no card, whatever the pointer is over. This is the whole
  // amendment: the card describes the piece being EDITED, never one swept past.
  if (selected == null) return { mode: 'hidden', uid: null };
  const following = hovered === selected
    && (input.finePointer ?? true)
    && (input.mode ?? '3d') === '3d';
  // Anchored on the SELECTED piece — hovering another one does not move it
  // there, it just stops the follow.
  return { mode: following ? 'follow' : 'anchored', uid: selected };
}
