/**
 * WHAT THE HIGHLIGHT COVERS — the promise a glow (or a gold outline) makes.
 *
 * A highlight is not decoration: it states what the next click will edit. So the
 * two questions here are one question asked twice —
 *
 *   `focusMeshes`  — given a piece's meshes and a scope, WHICH meshes light up;
 *   `resolveHighlightScope` — given the app's state (a committed picker, a
 *                    resting selection, a hovered part), WHICH scope is in force.
 *
 * Both are pure over plain data (`userData` bags and a state record), so the rule
 * is pinned by a unit test rather than by a screenshot, and the app owns the
 * three.js side alone.
 */

/**
 * The reserved `role` meaning «everything on this piece the client can DRESS» —
 * every mesh except the estructura. Exported so callers name the mode instead of
 * re-typing the string: two spellings of it would silently degrade to "no mesh
 * matches" and, through the no-vanish fallback, to the whole piece — a bug that
 * looks exactly like the behaviour it replaced.
 */
export const DRESSABLE_ROLE = 'dressable';

/** Anything carrying the builder's part stamps — a THREE.Mesh satisfies it. */
export interface TaggedMesh {
  userData?: { partRole?: string | null; partKey?: string | null } | null;
}

/** What the highlight is scoped to. */
export interface FocusScope {
  /** A MERGED part group (an estructura), by the key the builder stamps. */
  groupKey?: string | null;
  /** A part role — EVERY group of it — or `DRESSABLE_ROLE`. */
  role?: string | null;
  /** DRESSABLE only: roles to drop (they carry their own pick). Additive. */
  exclude?: readonly string[] | null;
}

/**
 * WHICH of a piece's meshes the highlight covers — the ONE filter both highlight
 * channels (an outline mask pass and the emissive glow) read.
 *
 *   `groupKey`       → that MERGED part group, by the key on every mesh of it.
 *   `role`           → EVERY group of that role — "the cushions" is all of them,
 *                      not the one that was tapped.
 *   `DRESSABLE_ROLE` → the piece MINUS its estructura. Legs and frames are a
 *                      different axis — a finish, not cloth — so the line that
 *                      answers a plain tap must not hug the metal feet.
 *                      `exclude` (part ROLES, dressable only) additionally drops
 *                      parts carrying their OWN fabric pick: the highlight is a
 *                      PROMISE of what the click edits, and the whole-piece pick
 *                      will not repaint an overridden part. Absent or empty ⇒
 *                      exactly the dressable set that shipped.
 *
 * A `groupKey` OUTRANKS the role it arrives with (a finish target sends both).
 *
 * NO-VANISH: a filter matching nothing (an untagged legacy mesh, a stale key, a
 * piece that is ALL estructura, every dressable role excluded) answers null,
 * which every caller reads as "the whole piece" — a selected piece is never left
 * unhighlighted.
 */
export function focusMeshes<T extends TaggedMesh>(
  meshes: readonly T[] | null | undefined,
  scope: FocusScope | null | undefined,
): T[] | null {
  const key = scope?.groupKey ?? null;
  const role = scope?.role ?? null;
  if (key == null && role == null) return null;
  // Overrides narrow the DRESSABLE set only — a role/group focus already names
  // one part, and excluding from it would contradict what was asked for.
  const skip = role === DRESSABLE_ROLE && Array.isArray(scope?.exclude) && scope!.exclude!.length
    ? scope!.exclude!
    : null;
  const out: T[] = [];
  for (const o of meshes || []) {
    const ud = o?.userData || {};
    const r = ud.partRole || 'base';
    const hit = key != null
      ? ud.partKey === key
      : role === DRESSABLE_ROLE
        ? r !== 'structure' && !(skip && skip.includes(r))
        : r === role;
    if (hit) out.push(o);
  }
  return out.length ? out : null;
}

/** The part under the pointer, as the pick resolved it. */
export interface HoverPart {
  uid: unknown;
  role?: string | null;
  /** The merged group key the ray landed on (an estructura's own). */
  partKey?: string | null;
}

/** Everything the precedence rule reads. */
export interface HighlightState {
  /** The scope a picker/selection put in force — `{ uid, role, groupKey, exclude }`. */
  focusPart?: (FocusScope & { uid?: unknown }) | null;
  hover?: HoverPart | null;
  /** 3D only: the plan's outline doubles as the drag affordance and never jumps. */
  mode?: '2d' | '3d' | string | null;
}

/** What the highlight should cover for ONE piece, and why. */
export interface HighlightDecision {
  /** The scope to hand `focusMeshes`, or null for "the whole piece". */
  scope: FocusScope | null;
  /** The scope's origin — `focus` (committed/resting) or `hover`. */
  source: 'focus' | 'hover' | 'none';
}

/**
 * WHOSE highlight wins on a piece: the focus that is already in force, or the
 * transient hover cue.
 *
 *   • A COMMITTED focus (a picker open on a part or an estructura group) still
 *     outranks the hover — two lit parts on one piece read as two selections.
 *   • A RESTING focus (`DRESSABLE_ROLE`: the highlight a mere SELECTION wears)
 *     YIELDS. Giving every focus absolute precedence made the hover branch
 *     unreachable on the selected piece, so hovering its legs lit nothing — and
 *     the estructura, which the resting highlight excludes BY DESIGN, read as
 *     dead.
 *   • The hovered ESTRUCTURA lights its MERGED GROUP — exactly what a click
 *     opens — falling back to the role (via `focusMeshes`' no-vanish null when
 *     the key is stale or absent).
 *   • The body ('base', or no role) keeps the dressable promise: its click IS
 *     the whole-piece flow.
 *
 * `hover` must already be the part on THIS piece (the caller matches uids); the
 * decision is scope-only, so the same answer drives the glow and the outline.
 */
export function resolveHighlightScope(state: HighlightState | null | undefined): HighlightDecision {
  const focus = state?.focusPart ?? null;
  const hover = state?.hover ?? null;
  const resting = focus?.role === DRESSABLE_ROLE;
  const hoveredPart = hover?.role && hover.role !== 'base' ? hover.role : null;
  // 3D only: in plan the outline is the drag affordance and must not jump under
  // the pointer.
  const in3d = (state?.mode ?? '3d') === '3d';
  if (focus && !(resting && in3d && hoveredPart)) {
    return { scope: { groupKey: focus.groupKey ?? null, role: focus.role ?? null, exclude: focus.exclude ?? null }, source: 'focus' };
  }
  if (hoveredPart) {
    return {
      scope: hover!.role === 'structure' && hover!.partKey
        ? { groupKey: hover!.partKey, role: null }
        : { groupKey: null, role: hover!.role ?? null },
      source: 'hover',
    };
  }
  return { scope: null, source: 'none' };
}

/**
 * The dressable EXCLUSIONS a piece's stored picks imply: the roles wearing their
 * own fabric, which the whole-piece pick will not repaint.
 *
 * Any stored pick counts, even one in the very same cloth — the question is not
 * "does it look different?" but "will this gesture change it?", and it will not.
 * `base` and `structure` are never excluded: the first IS the whole-piece pick,
 * the second is a finish and already out of the dressable set.
 */
export function dressableExclusions(
  partMaterials: Record<string, unknown> | null | undefined,
  roles: readonly string[] | null | undefined,
): string[] {
  const known = roles && roles.length ? roles : null;
  return Object.keys(partMaterials || {})
    .filter((role) => role !== 'base' && role !== 'structure' && (!known || known.includes(role)));
}
