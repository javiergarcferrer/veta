/**
 * SKU BINDING — what a model is SOLD as.
 *
 * Two independent bindings, and conflating them is how a model prices wrong:
 *   • the BASE product root, on the model itself (the piece's own SKU ladder);
 *   • the BILLED SLOTS, one per non-base role that can bill, each bound to the
 *     shared part SKU the catalogue sells that loose part under.
 *
 * The slot list is DERIVED, never restated: it is the role taxonomy minus
 * `base` minus `UNPRICED_ROLES` (`@veta/materials`). A materialization ZONE is
 * already inside the base SKU and a STRUCTURE is a finish on metal — same
 * piece, same price whichever the client picks — so neither can ever hold a
 * slot. Add a price-neutral role to the taxonomy and it stays out of the billed
 * slots here for free.
 *
 * Ported from the reference ModelStudio's `planSkuSlot` / `writeSlot`.
 */
import {
  COUNT_MAX,
  DEFAULT_ROLE_SET,
  PART_LABELS,
  partCount,
  type PartRoleSet,
} from '@veta/materials';
import type { PartsDraft, StudioModel } from './types.ts';

/** The roles that can hold a bound part SKU, in taxonomy order. */
export function billedSlots(roles: PartRoleSet = DEFAULT_ROLE_SET): string[] {
  return roles.all.filter((role) => role !== 'base' && !roles.unpriced.includes(role));
}

export type SkuSlotPlan = { role: string; error?: undefined } | { role?: undefined; error: string };

/**
 * Which role SLOT a group takes when the dealer binds it to `root`. A model has
 * a FIXED number of billed slots, so binding is an allocation:
 *   1. another group already bills this very SKU → SHARE its slot (two groups,
 *      one SKU, one billed line);
 *   2. this group already owns a billed slot ALONE → keep it, rewrite the root
 *      (if a SIBLING shares the slot, detaching is the only safe move — keeping
 *      it would silently re-SKU that sibling too);
 *   3. otherwise the first genuinely free slot;
 *   4. none free → refuse, and write nothing.
 */
export function planSkuSlot(
  parts: PartsDraft | null | undefined,
  members: readonly string[],
  currentRole: string,
  root: string | null | undefined,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): SkuSlotPlan {
  const slots = billedSlots(roles);
  const mats: Record<string, string> = (parts?.mats as Record<string, string>) || {};
  const roots: Record<string, string> = (parts?.roots as Record<string, string>) || {};
  const mine = new Set(members);
  const heldByOthers = (role: string): boolean => Object.entries(mats).some(([k, r]) => r === role && !mine.has(k));
  const held = (role: string): boolean => Object.values(mats).some((r) => r === role);

  const shared = slots.find((role) => root && roots[role] === root && heldByOthers(role));
  if (shared) return { role: shared };
  if (slots.includes(currentRole) && !heldByOthers(currentRole)) return { role: currentRole };
  const free = slots.find((role) => !held(role));
  if (free) return { role: free };
  return { error: `At most ${slots.length} part SKUs per model. Clear another part's SKU first.` };
}

/**
 * Move a group into `role` (base / a zone / a billed slot) and keep the billing
 * maps honest: a billed slot the group just VACATED and nobody else holds loses
 * its root AND its count, so a stale SKU can never bill on a model that no
 * longer has that part. Whole-object and immutable; keys nobody touched ride
 * through untouched.
 */
export function writeSlot(
  parts: PartsDraft | null | undefined,
  members: readonly string[],
  role: string,
  root: string | null | undefined,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): PartsDraft {
  const slots = billedSlots(roles);
  const mats: Record<string, string> = { ...((parts?.mats as Record<string, string>) || {}) };
  const vacated = new Set(members.map((m) => mats[m]).filter(Boolean));
  for (const m of members) mats[m] = role;

  const roots: Record<string, string> = { ...((parts?.roots as Record<string, string>) || {}) };
  const counts: Record<string, unknown> = { ...((parts?.counts as Record<string, unknown>) || {}) };
  if (slots.includes(role) && root) roots[role] = root;
  for (const r of vacated) {
    if (r === role || !slots.includes(r)) continue;
    if (Object.values(mats).some((x) => x === r)) continue;   // a sibling still holds it
    delete roots[r];
    delete counts[r];
  }
  const next: PartsDraft = { ...(parts || {}), mats, roots, counts };
  if (!Object.keys(roots).length) delete next.roots;
  if (!Object.keys(counts).length) delete next.counts;
  return next;
}

/**
 * The typed «bills ×N» box. CLAMPED to the model's range at the keyboard, and it
 * SATURATES rather than falling back the way `partCount` does: the input
 * re-mounts on the stored value, so a dealer watching their 100000 land as
 * COUNT_MAX reads a limit, where watching it land as 1 reads as the studio
 * losing their input. `partCount`'s fall-back stays the guard for what this
 * control can no longer produce (a hand-edited row).
 */
export function setPartCount(parts: PartsDraft | null | undefined, role: string, n: unknown): PartsDraft {
  const clamped = Math.min(COUNT_MAX, Math.max(0, Math.round(Number(n) || 0)));
  return { ...(parts || {}), counts: { ...((parts?.counts as Record<string, unknown>) || {}), [role]: clamped } };
}

/** Bind (or clear) the model's own base product root. */
export function bindBaseProduct(model: StudioModel, root: string | null, now: number): StudioModel {
  const next = (root || '').trim();
  return { ...model, productRoot: next || null, updatedAt: now };
}

export interface SkuSlotView {
  role: string;
  label: string;
  /** Part groups currently tagged with this role. */
  groups: string[];
  root: string | null;
  /** Billed units of the bound SKU (`partCount` — the ONE money gate). */
  count: number;
  bound: boolean;
}

export interface SkuBindingView {
  baseRoot: string | null;
  baseBound: boolean;
  slots: SkuSlotView[];
  /** Slots holding no part group at all — what a new binding can take. */
  freeSlots: string[];
  /** Bound part slots, i.e. what will actually add lines to a quote. */
  boundSlots: number;
  /** True when the piece can price at all. */
  quotable: boolean;
}

/** The SKU tab's whole read — one projection, no derivation in the View. */
export function resolveSkuBinding(model: StudioModel, roles: PartRoleSet = DEFAULT_ROLE_SET): SkuBindingView {
  const parts = model.parts || null;
  const mats: Record<string, string> = (parts?.mats as Record<string, string>) || {};
  const roots: Record<string, string> = (parts?.roots as Record<string, string>) || {};
  const slots = billedSlots(roles).map((role): SkuSlotView => {
    const groups = Object.keys(mats).filter((k) => mats[k] === role).sort();
    const root = roots[role] || null;
    return {
      role,
      label: roles.labels[role] || PART_LABELS[role] || role,
      groups,
      root,
      count: partCount(parts, role, roles),
      bound: !!root && groups.length > 0,
    };
  });
  const baseBound = !!model.productRoot;
  return {
    baseRoot: model.productRoot,
    baseBound,
    slots,
    freeSlots: slots.filter((s) => !s.groups.length).map((s) => s.role),
    boundSlots: slots.filter((s) => s.bound).length,
    quotable: baseBound,
  };
}
