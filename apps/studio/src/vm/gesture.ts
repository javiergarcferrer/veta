/**
 * ONE GESTURE, and the keys that arm it.
 *
 * THE DEALER POINTS AT TWO THINGS and says "these are one part" — or at one
 * member and says "this one is its own". What that IS in the data depends on
 * where the keys came from: two pCon materials are a MERGE, two islands of the
 * same material are an UN-SPLIT. He must never have to know which, so the mode
 * is ONE control in both directions — outside the part JOINS, inside SEPARATES —
 * and `planPartJoin`/`planPartSplit` (`@veta/materials`) settle the merge map,
 * the role, the label and the palette together so both cases land on one truth.
 *
 * This module decides only WHICH KEYS a gesture is about, and what a keystroke
 * means. It is pure: no React, no DOM types beyond the three fields a keyboard
 * event actually carries.
 */
import { mergedKeyOf, planPartJoin, planPartSplit } from '@veta/materials';
import type { PartsDraft } from './types.ts';

/** What a stage click hit: the mesh's OWN key and the group it resolves into. */
export interface StageHit {
  /** The mesh's own part key. NOT the group — that is what makes taking a
   *  natively-grouped island out possible: it need carry no merge entry, it only
   *  needs to not BE the group key. */
  raw: string;
  /** The key it currently renders as (`mergedKeyOf`). */
  group: string;
}

export type PickGesture =
  | { kind: 'select'; group: string | null }
  | { kind: 'join'; target: string; members: string[] }
  | { kind: 'separate'; group: string; members: string[] }
  | { kind: 'noop' };

/**
 * What a stage click MEANS, given the mode.
 *
 * Unarmed, a click selects. Armed, it is one question asked of whatever is
 * clicked: inside this part ⇒ take it out, outside ⇒ bring it in. Empty space
 * stays armed rather than disarming — the dealer is usually mid-run, joining
 * several meshes, and a stray miss must not cost him the mode.
 *
 * `groups` maps a group key to the member keys it already contains, so folding a
 * GROUP in carries everything already folded into it — otherwise its children
 * stay pointed at a key that is no longer a group of its own.
 */
export function resolvePickGesture(
  hit: StageHit | null | undefined,
  { joinMode, selected, groups = {} }: {
    joinMode: boolean;
    selected: string | null;
    groups?: Record<string, readonly string[]>;
  },
): PickGesture {
  if (!joinMode || !selected) return { kind: 'select', group: hit?.group ?? null };
  if (!hit) return { kind: 'noop' };                      // empty space: stay armed
  if (hit.group === selected) {
    // A mesh already inside this part — click it again to take it out. The group
    // key itself is not separable from itself.
    return hit.raw !== selected ? { kind: 'separate', group: selected, members: [hit.raw] } : { kind: 'noop' };
  }
  const members = groups[hit.group]?.length ? [...groups[hit.group]!] : [hit.group];
  return { kind: 'join', target: selected, members };
}

/** Apply a gesture to the parts draft. A `select`/`noop` never touches it. */
export function applyPickGesture(draft: PartsDraft, gesture: PickGesture): PartsDraft {
  if (gesture.kind === 'join') return planPartJoin(draft, gesture.target, gesture.members) as PartsDraft;
  if (gesture.kind === 'separate') {
    return planPartSplit(draft, mergedKeyOf(draft, gesture.members[0]), gesture.members) as PartsDraft;
  }
  return draft;
}

/** Separate an explicit list (the inspector's "separate" buttons), resolving the
 *  group off the FIRST member exactly as a stage click would. */
export function separateMembers(draft: PartsDraft, memberKeys: readonly string[]): PartsDraft {
  const keys = (memberKeys || []).filter(Boolean);
  if (!keys.length) return draft;
  return planPartSplit(draft, mergedKeyOf(draft, keys[0]), keys) as PartsDraft;
}

/* ── Keyboard ───────────────────────────────────────────────────────────────*/

/**
 * The three fields a shortcut actually reads off a keyboard event. Typed
 * structurally so the rule is testable without a DOM.
 */
export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  /** The element the key went to — a field swallows bare letters. */
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

export type StudioKeyAction =
  | { kind: 'none' }
  | { kind: 'toggle-join' }
  | { kind: 'exit-join' }
  | { kind: 'deselect' }
  | { kind: 'model'; id: string };

/**
 * Tagging a catalogue is the same few moves over and over, and the join mode's
 * one button sits in the inspector, which scrolls out of reach behind the part
 * editor. So the hands stay on the keyboard:
 *
 *   U        join mode on/off
 *   Esc      leaves the mode; already out, deselects
 *   ← / →    previous / next model
 *
 * U NEEDS A SELECTED PART, because the selection IS what you join into — arming
 * the mode with nothing selected would swallow the next click, the same reason
 * the mode clears itself when the selection goes.
 *
 * A bare letter is a shortcut only OUTSIDE a field (inputs, textareas, selects
 * and contenteditable are all skipped) or renaming a part would toggle modes
 * mid-word. Modifier combos are left to the browser, so Cmd+← stays "back".
 *
 * `preventDefault` is reported, never called: the caller owns the event.
 */
export function resolveStudioKey(
  event: KeyEventLike | null | undefined,
  { joinMode, selected, modelIds = [], activeId = null }: {
    joinMode: boolean;
    selected: string | null;
    modelIds?: readonly string[];
    activeId?: string | null;
  },
): { action: StudioKeyAction; preventDefault: boolean } {
  const none = { action: { kind: 'none' } as StudioKeyAction, preventDefault: false };
  if (!event) return none;
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return none;
  const tag = event.target?.tagName;
  if (event.target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return none;

  if (event.key === 'Escape') {
    return { action: joinMode ? { kind: 'exit-join' } : { kind: 'deselect' }, preventDefault: false };
  }
  if (event.key === 'u' || event.key === 'U') {
    return selected ? { action: { kind: 'toggle-join' }, preventDefault: true } : none;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const at = (modelIds || []).indexOf(String(activeId ?? ''));
    if (at < 0) return none;
    const to = modelIds[at + (event.key === 'ArrowRight' ? 1 : -1)];
    if (!to) return none;
    return { action: { kind: 'model', id: to }, preventDefault: true };
  }
  return none;
}
