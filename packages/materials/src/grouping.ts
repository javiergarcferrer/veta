/**
 * GROUPING — joining and separating a model's parts, as ONE gesture.
 *
 * "Une el cojín al armazón" is one thing to the dealer and two things to the
 * data, and that is exactly why he could not do it. A pCon export hands us
 * MATERIAL groups; `partKeysFor` then SPLITS a material whose meshes are
 * different shapes into islands ("COL0", "COL0~2", "COL0~3" — one material
 * upholstering the frame AND the seat cushions). So the two things a dealer
 * points at can be:
 *
 *   • two different materials      → a MERGE (what `merges` always did);
 *   • two islands of ONE material  → an UN-SPLIT (undoing `partKeysFor`) —
 *     which had no route at all: the join wrote `merges`, and `merges` moves a
 *     key's LABEL and its FINISH but never its ROLE (`partRoleFor` reads
 *     `mats[key]` first), so the island stayed tagged `cushion`, kept rendering
 *     as a cushion and kept BILLING as one while the studio drew it folded in.
 *     The join looked like it did nothing because half of it did nothing.
 *
 * Both cases are one operation here, producing ONE truth whichever it was.
 * Pure, whole-object, non-mutating: `parts` is dealer-authored jsonb held as a
 * studio draft, so anything untouched rides through and a half-typed bag
 * returns unchanged rather than throwing.
 */

import { BILLED_ROLES, DEFAULT_ROLE_SET, partRoleFor } from './partRoles.ts';
import type { PartRoleSet, PartsMap } from './partRoles.ts';
import { mergedKeyOf } from './finishes.ts';

/** A dealer-authored jsonb sub-map, defensively: anything that isn't a plain
 *  object reads as empty, so a half-typed bag can never throw a spread. */
const bagOf = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const partsOf = (v: unknown): PartsMap =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as PartsMap) : {});

/** The billable slots of a taxonomy — `BILLED_ROLES` for the default set, the
 *  same question asked of a collection's own vocabulary otherwise. */
const billedOf = (roles: PartRoleSet): readonly string[] =>
  (roles === DEFAULT_ROLE_SET ? BILLED_ROLES : roles.all.filter((r) => r !== 'base' && !roles.unpriced.includes(r)));

/**
 * `parts` with `key` RESOLVING to `role`, changing as little as it can.
 *
 * An UNTAGGED mesh is not the same thing as one tagged `base`: a scene renders
 * a factory-textured mesh as-is only while nothing claims it (an explicit
 * `base` OVERRIDES the walnut and puts fabric on it). So this touches
 * `mats[key]` in exactly two situations and leaves it alone otherwise:
 *
 *   • it ALREADY says `role` — untouched, not rewritten. Regrouping a key must
 *     not quietly strip a tag the dealer put there, or a join/separate round
 *     trip would repaint a factory-finished part;
 *   • it says something else — dropped, and re-written ONLY if the key would
 *     not land on `role` without it. A split island un-joined into its own
 *     material ("COL0~2" under "COL0") therefore comes out carrying NO tag at
 *     all, which is the exact state it had before anything split it and is
 *     what lets `partRoleFor`'s base-key inheritance go on answering for it. A
 *     key from a DIFFERENT material has nothing to inherit from, so it gets the
 *     tag — without it the role would fall back to `base`, a different fabric
 *     and, for a billed role, a different price.
 */
function settleRole(parts: PartsMap, key: string, role: string, roles: PartRoleSet): PartsMap {
  const src = partsOf(parts);
  if (bagOf(src.mats)[key] === role) return src;
  const mats = { ...bagOf(src.mats) };
  delete mats[key];
  const bare = { ...src, mats } as PartsMap;
  if (partRoleFor(bare, null, -1, key, roles) === role) return bare;
  return { ...bare, mats: { ...mats, [key]: role } } as PartsMap;
}

/** Give back the `roots`/`counts` of every billed role in `vacated` that no key
 *  holds any more — the same rule a studio's slot writer applies, for the same
 *  money reason: a stale `counts.cushion` bills a part SKU on a model whose
 *  tagging no longer has a cushion at all. Roles still held are left alone. */
function releaseBilled(parts: PartsMap, vacated: Iterable<string>, roles: PartRoleSet): PartsMap {
  const billed = billedOf(roles);
  const held = new Set(Object.values(bagOf(parts?.mats)));
  const roots = { ...bagOf(parts?.roots) };
  const counts = { ...bagOf(parts?.counts) };
  for (const role of vacated) {
    if (!billed.includes(role) || held.has(role)) continue;
    delete roots[role];
    delete counts[role];
  }
  return { ...partsOf(parts), roots, counts } as PartsMap;
}

/**
 * ── JOIN — one gesture, both underlying cases ──────────────────────────────
 *
 * `memberKeys` fold into `targetKey`, and the result is ONE truth whichever
 * case it was:
 *   1. every member points at the target in `merges` (chains flatten, and a
 *      target is never a child — that is what keeps `mergedKeyOf` loop-free);
 *   2. every member RESOLVES to the target's role (`settleRole`) — so the mesh
 *      renders, prices and counts as the target, not as what it used to be;
 *   3. the target's identity wins for `labels`/`finishes`, and a member's own
 *      is ADOPTED when the target has none. Either way the member's keys are
 *      REMOVED: a palette left on a key nothing renders is not merely dead, it
 *      keeps fanning itself out across the collection forever (a finish map is
 *      read as evidence the model "has" that group);
 *   4. a billed role the join emptied gives back its `roots`/`counts`.
 *
 * An unusable target, an empty member list, or a bag of the wrong shape returns
 * the input unchanged rather than throwing.
 */
export function planPartJoin(
  parts: PartsMap | null | undefined,
  targetKey: unknown,
  memberKeys: readonly unknown[] | null | undefined,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): PartsMap {
  const src = partsOf(parts);
  const target = mergedKeyOf(src, targetKey);
  if (!target) return src;
  const members = [...new Set((memberKeys || [])
    .map((k) => (k == null ? '' : String(k)))
    .filter((k) => k && k !== target))];
  if (!members.length) return src;

  const role = partRoleFor(src, null, -1, target, roles);
  const vacated = new Set(members.map((m) => bagOf(src.mats)[m]).filter(Boolean) as string[]);

  const fold = new Set(members);
  const merges = { ...bagOf(src.merges) };
  for (const m of members) merges[m] = target;
  // Anything that pointed AT a member now points at the target: a two-hop chain
  // still resolves, but flattening it keeps the map readable and keeps a later
  // split from stranding a grandchild on a key that is no longer a group.
  for (const [k, v] of Object.entries(merges)) {
    if (k !== target && typeof v === 'string' && fold.has(v.trim())) merges[k] = target;
  }
  delete merges[target];

  const labels = { ...bagOf(src.labels) };
  const finishes = { ...bagOf(src.finishes) };
  for (const m of members) {
    if (m in labels) {
      if (!(target in labels)) labels[target] = labels[m];
      delete labels[m];
    }
    if (m in finishes) {
      if (!(target in finishes)) finishes[target] = finishes[m];
      delete finishes[m];
    }
  }

  let next = { ...src, merges, labels, finishes } as PartsMap;
  for (const m of members) next = settleRole(next, m, role, roles);
  return releaseBilled(next, vacated, roles);
}

/**
 * ── SEPARATE — the same gesture, the other direction ───────────────────────
 *
 * The inverse of `planPartJoin`, and deliberately blind to how the member came
 * to be inside the group: a key the dealer folded in and a split island that
 * was only ever INHERITING its material's tag both come out as parts of their
 * own. That is the whole of "ungroup what came grouped from the factory" — the
 * dealer never has to know which of the two he is looking at.
 *
 *   • the merge entry is dropped, so the key is its own group again;
 *   • it KEEPS the role it was wearing (`settleRole` writes the tag only when
 *     the key wouldn't inherit it anyway) — separating a part must never
 *     silently re-file it as `base`, which is a different fabric and, for a
 *     billed role, a different price.
 *
 * What it CANNOT give back is a palette the join folded into the target: a
 * separated key comes out with no `finishes` of its own and takes the
 * collection's structure palette (or a starter) again. Nothing is lost that the
 * join didn't already say belonged to the target.
 *
 * A member key that IS the group (you cannot separate a group from itself) and
 * an unknown key are both no-ops.
 */
export function planPartSplit(
  parts: PartsMap | null | undefined,
  groupKey: unknown,
  memberKeys: readonly unknown[] | null | undefined,
  roles: PartRoleSet = DEFAULT_ROLE_SET,
): PartsMap {
  const src = partsOf(parts);
  const group = mergedKeyOf(src, groupKey);
  const members = [...new Set((memberKeys || [])
    .map((k) => (k == null ? '' : String(k)))
    .filter((k) => k && k !== group))];
  if (!members.length) return src;

  const role = partRoleFor(src, null, -1, group, roles);
  const merges = { ...bagOf(src.merges) };
  for (const m of members) delete merges[m];
  let next = { ...src, merges } as PartsMap;
  for (const m of members) next = settleRole(next, m, role, roles);
  return next;
}
